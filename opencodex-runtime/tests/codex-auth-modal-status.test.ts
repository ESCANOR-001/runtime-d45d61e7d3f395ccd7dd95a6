import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// These checks inspect fixed source files, not asynchronous file I/O. Read them
// directly and resolve from this test so they do not depend on a pending Bun
// file-read job or the directory from which the suite was started.
const readSource = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("Codex auth modal status feedback", () => {
  test("keeps a distinct submitted/waiting state for manual code login", () => {
    const reducer = readSource("gui/src/components/add-codex-account-reducer.ts");
    const oauth = readSource("gui/src/components/use-add-codex-account-oauth.ts");
    const waiting = readSource("gui/src/components/add-codex-account-waiting-step.tsx");
    expect(reducer).toContain('export type ManualCodeState = "idle" | "submitting" | "waiting"');
    expect(reducer).toContain('manualCodeState: "idle"');
    expect(oauth).toContain('statusNotice: t("codexAuth.oauthCodeSubmitted")');
    expect(oauth).toContain('statusNotice: t("codexAuth.oauthStatusRetrying")');
    expect(waiting).toContain("disabled={manualCodeBusy || manualCodeWaiting || !manualCode.trim() || !flowId}");
    expect(waiting).toContain('aria-live="polite"');
  });

  test("defines the new status copy in every shipped GUI locale", () => {
    const localePaths = [
      "gui/src/i18n/en.ts",
      "gui/src/i18n/de.ts",
      "gui/src/i18n/ja.ts",
      "gui/src/i18n/ko.ts",
      "gui/src/i18n/ru.ts",
      "gui/src/i18n/zh.ts",
    ];
    const locales = localePaths.map(readSource);
    for (const source of locales) {
      expect(source).toContain('"codexAuth.oauthSubmittingCode"');
      expect(source).toContain('"codexAuth.oauthCodeSubmitted"');
      expect(source).toContain('"codexAuth.oauthStatusRetrying"');
    }
  });
});
