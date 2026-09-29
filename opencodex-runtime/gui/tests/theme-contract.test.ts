import { describe, expect, test } from "bun:test";

const styles = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
const fontStyles = await Bun.file(new URL("../src/styles-fonts.css", import.meta.url)).text();

describe("dashboard visual theme", () => {
  test("keeps the requested dark palette in shared tokens", () => {
    expect(styles).toContain("--bg:           light-dark(#ffffff, #181818);");
    expect(styles).toContain("--rail:         light-dark(#f9f9f9, #141414);");
    expect(styles).toContain("--surface:      light-dark(#ffffff, #262626);");
    expect(styles).toContain("--raised:       light-dark(#f4f4f4, #262626);");
    expect(styles).toContain("--accent-soft:  light-dark(rgba(13, 13, 13, 0.06), #262626);");
    expect(styles).toContain("background: var(--bg);");
    expect(styles).toContain("background: var(--rail);");
    expect(styles).toContain(".main { min-width: 0; background: var(--bg); }");
  });

  test("uses only static solid surfaces for the application chrome", () => {
    expect(styles).not.toContain("body::before");
    expect(styles).not.toContain("backdrop-filter");
    expect(styles).not.toContain("filter: blur(");
    expect(styles).not.toContain("--glass-");
    expect(styles).toMatch(/\.sidebar\s*\{[^}]*background:\s*var\(--rail\)/);
    expect(styles).toMatch(/\.mobile-topbar\s*\{[^}]*background:\s*var\(--rail\)/);
    expect(styles).toMatch(/\.select-trigger\s*\{[^}]*background:\s*var\(--raised\)/);
    expect(styles).toMatch(/\.select-dropdown\s*\{[^}]*background:\s*var\(--surface\)/);
    expect(styles).toMatch(/\.modal-card\s*\{[^}]*background:\s*var\(--surface\)/);
    expect(styles).toMatch(/\.ocx-tooltip-bubble\s*\{[^}]*background:\s*var\(--surface\)/);
  });

  test("uses the card token for cards and selected navigation", () => {
    expect(styles).toContain(".nav-item.active { background: var(--accent-soft); color: var(--text); }");
    expect(styles).toContain(".card { background: var(--surface);");
    expect(styles).toContain(".panel { background: var(--surface);");
    expect(styles).toContain(".stat { background: var(--surface);");
  });

  test("self-hosts Google Sans with language-safe fallbacks", async () => {
    expect(styles).toContain('--font-ui: "Google Sans",');
    expect(fontStyles).toContain('font-family: "Google Sans";');
    expect(fontStyles).toContain('url("/fonts/google-sans-latin.woff2")');
    expect(fontStyles).toContain('url("/fonts/google-sans-cyrillic.woff2")');

    const latin = Bun.file(new URL("../public/fonts/google-sans-latin.woff2", import.meta.url));
    const cyrillic = Bun.file(new URL("../public/fonts/google-sans-cyrillic.woff2", import.meta.url));
    expect(await latin.exists()).toBe(true);
    expect(await cyrillic.exists()).toBe(true);
    expect(latin.size).toBeGreaterThan(10_000);
    expect(cyrillic.size).toBeGreaterThan(10_000);
  });
});
