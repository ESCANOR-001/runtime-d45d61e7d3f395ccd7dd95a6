import { expect, test } from "bun:test";

async function styles(): Promise<string> {
  return Bun.file(new URL("../src/styles.css", import.meta.url)).text();
}

/**
 * Declaration block of a rule matching `selector`. `which` picks between the base rule and a
 * later media-query override, both of which exist for `.sidebar` and the beside-placement menu.
 */
function ruleBody(css: string, selector: string, which: "first" | "last" = "last"): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, "g"))];
  expect(matches.length).toBeGreaterThan(0);
  return (which === "first" ? matches[0]! : matches.at(-1)!)[1]!;
}

// The locale menu opens beside its trigger, which sits in the sidebar footer. It used to be
// pinned with `top: 0` and no height limit, so growing the locale list to six entries pushed it
// past the bottom of the sidebar. A repositioning fix alone would not hold — the durable
// property is the height bound, which makes the menu independent of how many locales exist.
test("the beside-placement menu is anchored upward and height-bounded", async () => {
  const css = await styles();

  for (const selector of [".select-dropdown-beside", ".lang-toggle .select-dropdown-beside"]) {
    const body = ruleBody(css, selector);
    expect(`${selector}: ${body}`).not.toMatch(/top:\s*0/);
    expect(body).toMatch(/bottom:\s*0/);
    expect(body).toMatch(/max-height:/);
    expect(body).toMatch(/overflow-y:\s*auto/);
  }
});

// The non-portaled language menu relies on a positioned wrapper in the desktop sidebar and on
// the transformed mobile drawer. Keep both anchors explicit so placement remains layout-local.
test("the language menu keeps its desktop and mobile positioning anchors", async () => {
  const css = await styles();
  const languageToggle = ruleBody(css, ".lang-toggle");
  expect(languageToggle).toMatch(/position:\s*relative/);
  const drawer = ruleBody(css, ".sidebar", "last");
  expect(drawer).toMatch(/transform:\s*translateX/);
});

// The drawer scrolls, so beside-placement would be clipped at its edge; the mobile rule opens
// the menu upward from the foot row instead. It must keep outranking the desktop rule.
test("the mobile drawer keeps its own upward placement", async () => {
  const css = await styles();
  expect(css).toMatch(/\.sidebar \.lang-toggle \.select-dropdown-beside\s*\{[^}]*bottom:\s*calc\(100% \+ 6px\)/);
});
