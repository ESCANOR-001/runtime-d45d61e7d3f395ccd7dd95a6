import { expect, test } from "bun:test";
import { canonicalizeRemodexCliExample } from "../src/remodex-user-copy";

test("canonicalizes legacy CLI commands and user-state path examples", () => {
  expect(canonicalizeRemodexCliExample(
    "ocx doctor --fix-codex-runtime && ocx sync --config ~/.opencodex/config.json",
  )).toBe(
    "rmx doctor --fix-codex-runtime && rmx sync --config ~/.remodex/config.json",
  );
  expect(canonicalizeRemodexCliExample(
    String.raw`ocx sync --config C:\Users\Jane Doe\.opencodex\config.json`,
  )).toBe(
    String.raw`rmx sync --config C:\Users\Jane Doe\.remodex\config.json`,
  );
});

test("preserves compatibility-only identifiers", () => {
  const value = "ocx_abc OPENCODEX_HOME providers.opencodex https://opencodex.me ocx-*";
  expect(canonicalizeRemodexCliExample(value)).toBe(value);
});
