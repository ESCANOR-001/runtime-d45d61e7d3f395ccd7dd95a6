import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  hashBelongsToPage,
  readPageFromHash,
  resolveAppHashChange,
} from "../src/app-routing";
import { en } from "../src/i18n/en";
import { I18nContext, interpolate, type TFn } from "../src/i18n/shared";
import {
  GUIDE_AUDIENCE_KEY,
  readGuideAudience,
  writeGuideAudience,
} from "../src/pages/guide-preference";

describe("Guide route", () => {
  test("the bare Guide hash is a first-class page", () => {
    expect(readPageFromHash("#guide")).toBe("guide");
    expect(hashBelongsToPage("guide", "guide")).toBe(true);
    expect(resolveAppHashChange("guide")).toEqual({ page: "guide", replaceTo: null });
  });

  test("an unknown Guide suffix returns to the Guide instead of a blank page", () => {
    expect(resolveAppHashChange("guide/unknown")).toEqual({
      page: "guide",
      replaceTo: "guide",
    });
  });

  test("the sidebar and page renderer both register Guide", async () => {
    const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
    const nav = app.slice(app.indexOf("const NAV"), app.indexOf("];", app.indexOf("const NAV")));
    expect(nav).toContain('id: "guide"');
    expect(nav).toContain('tkey: "nav.guide"');
    expect(app).toContain('page === "guide" && <Guide />');
  });
});

describe("Guide audience preference", () => {
  test("defaults to Beginner and persists Advanced", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(readGuideAudience(storage)).toBe("beginner");
    writeGuideAudience("advanced", storage);
    expect(values.get(GUIDE_AUDIENCE_KEY)).toBe("advanced");
    expect(readGuideAudience(storage)).toBe("advanced");
  });

  test("blocked storage falls back safely", () => {
    const storage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readGuideAudience(storage)).toBe("beginner");
    expect(() => writeGuideAudience("advanced", storage)).not.toThrow();
  });
});

describe("Guide interaction", () => {
  const globals = [
    "document",
    "window",
    "navigator",
    "localStorage",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  let previous: Record<(typeof globals)[number], unknown>;
  let win: Window;
  let host: HTMLElement;
  let root: import("react-dom/client").Root | null = null;

  beforeEach(() => {
    previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
    win = new Window({ url: "http://localhost/#guide" });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: win.document },
      window: { configurable: true, value: win },
      navigator: { configurable: true, value: win.navigator },
      localStorage: { configurable: true, value: win.localStorage },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(host as never);
  });

  afterEach(async () => {
    if (root) {
      const mounted = root;
      const { act } = await import("react");
      await act(async () => { mounted.unmount(); });
      root = null;
    }
    for (const key of globals) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    }
  });

  async function mountGuide() {
    const [{ act }, { createRoot }, { default: Guide }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("../src/pages/Guide"),
    ]);
    const t: TFn = (key, vars) => interpolate(en[key], vars);
    await act(async () => {
      root = createRoot(host);
      root.render(
        <I18nContext.Provider value={{ locale: "en", setLocale: () => undefined, t }}>
          <Guide />
        </I18nContext.Provider>,
      );
    });
    return act;
  }

  test("switches modes and restores the saved choice after remount", async () => {
    const act = await mountGuide();
    const beginner = host.querySelector<HTMLButtonElement>('[data-guide-audience="beginner"]')!;
    const advanced = host.querySelector<HTMLButtonElement>('[data-guide-audience="advanced"]')!;

    expect(beginner.getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain(en["guide.mode.beginnerDescription"]);

    await act(async () => { advanced.click(); });
    expect(advanced.getAttribute("aria-pressed")).toBe("true");
    expect(win.localStorage.getItem(GUIDE_AUDIENCE_KEY)).toBe("advanced");
    expect(host.textContent).toContain(en["guide.mode.advancedDescription"]);

    await act(async () => { root!.unmount(); });
    root = null;
    host.replaceChildren();

    await mountGuide();
    const restored = host.querySelector<HTMLButtonElement>('[data-guide-audience="advanced"]')!;
    expect(restored.getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain(en["guide.mode.advancedDescription"]);
  });

  test("renders a direct link for every navigable dashboard section", async () => {
    await mountGuide();
    for (const page of [
      "dashboard",
      "codex-auth",
      "providers",
      "models",
      "subagents",
      "logs",
      "usage",
      "storage",
      "integrations",
      "android-remote",
      "startup",
    ]) {
      expect(host.querySelector(`a[href="#${page}"]`)).not.toBeNull();
    }
  });
});
