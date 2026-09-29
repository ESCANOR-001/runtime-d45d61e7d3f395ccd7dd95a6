import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopModelProvider, desktopConversationModelSelectors, remodexRuntimeModelSelectors, readDesktopDirectModelProvider } from "../src/android-remote/desktop-model-route";

test("existing chat provider wins over the current Desktop default", () => {
  expect(desktopModelProvider({ modelProvider: "codex-lb" }, () => "openai")).toBe("codex-lb");
  expect(desktopModelProvider({ modelProvider: "openai" }, () => "codex-lb")).toBe("openai");
  const options = { reasoningEffort: "high", serviceTier: "priority" };
  expect(remodexRuntimeModelSelectors({ modelProvider: "codex-lb", model: "gpt-6-astra", ...options }))
    .toMatchObject({ model: "codex-lb/gpt-6-astra", modelProvider: "codex-lb", ...options });
  expect(remodexRuntimeModelSelectors({ modelProvider: "openai", model: "gpt-6-astra", ...options }))
    .toMatchObject({ model: "gpt-6-astra", modelProvider: "openai", ...options });
  expect(desktopConversationModelSelectors({ modelProvider: "codex-lb", latestModel: "codex-lb/gpt-6-astra" }))
    .toMatchObject({ modelProvider: "codex-lb", latestModel: "gpt-6-astra" });
});

test.each([
  { name: "official account", config: 'model = "gpt-5.6-sol"', expected: "openai" },
  { name: "direct Codex-LB", config: 'model_provider = "codex-lb"\n[model_providers.codex-lb]\nbase_url = "https://provider.example/v1"', expected: "codex-lb" },
  { name: "managed built-in connection", config: 'openai_base_url = "http://127.0.0.1:10100/v1"', expected: null },
  { name: "equivalent loopback spelling", config: 'openai_base_url = "http://localhost:10100/v1/"', expected: null },
  { name: "managed custom connection", config: 'model_provider = "codex-lb"\n[model_providers.codex-lb]\nbase_url = "http://127.0.0.1:10100/v1"', expected: null },
  { name: "another local server", config: 'model_provider = "local"\n[model_providers.local]\nbase_url = "http://127.0.0.1:9999/v1"', expected: "local" },
  { name: "legacy selected profile", config: 'profile = "work"\n[profiles.work]\nmodel_provider = "codex-lb"\n[model_providers.codex-lb]\nbase_url = "https://provider.example/v1"', expected: "codex-lb" },
])("identifies Desktop model connection: $name", ({ config, expected }) => {
  const root = mkdtempSync(join(tmpdir(), "rmx-desktop-route-"));
  const paths = { configPath: join(root, "config.toml"), remodexProfilePath: join(root, "opencodex.config.toml") };
  try {
    writeFileSync(paths.configPath, config);
    writeFileSync(paths.remodexProfilePath, 'model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:10100/v1"');
    expect(readDesktopDirectModelProvider(paths)).toBe(expected);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reads current separate profile files and refuses a malformed profile without guessing OpenAI", () => {
  const root = mkdtempSync(join(tmpdir(), "rmx-desktop-profile-"));
  const paths = { configPath: join(root, "config.toml"), remodexProfilePath: join(root, "opencodex.config.toml") };
  try {
    writeFileSync(paths.configPath, 'profile = "work"\n[model_providers.codex-lb]\nbase_url = "https://provider.example/v1"');
    writeFileSync(join(root, "work.config.toml"), 'model_provider = "codex-lb"');
    expect(readDesktopDirectModelProvider(paths)).toBe("codex-lb");
    writeFileSync(join(root, "work.config.toml"), 'model_provider = [broken');
    expect(() => readDesktopDirectModelProvider(paths)).toThrow("Desktop connection settings could not be read");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
