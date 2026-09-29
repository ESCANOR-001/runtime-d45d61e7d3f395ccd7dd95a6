import { describe, expect, test } from "bun:test";
import {
  codexAppServerProfileOverrideArgs,
  codexAppServerModelParams,
  remodexCodexAppServerArgs,
} from "../src/android-remote/codex-app-server";

describe("Remodex private Codex app-server profile", () => {
  test("uses a direct provider without generating a profile or losing reasoning and speed", () => {
    const params = {
      model: "codex-lb/gpt-6-astra", effort: "high", serviceTier: "priority",
      collaborationMode: { mode: "default", settings: { model: "codex-lb/gpt-6-astra", reasoning_effort: "high" } },
    };
    expect(codexAppServerModelParams(params, "codex-lb")).toEqual({
      ...params, model: "gpt-6-astra",
      collaborationMode: { ...params.collaborationMode, settings: { ...params.collaborationMode.settings, model: "gpt-6-astra" } },
    });
    expect(codexAppServerModelParams(params, null)).toBe(params);
    expect(params.model).toBe("codex-lb/gpt-6-astra");
    expect(codexAppServerModelParams({ model: "codex-lb/future-model", serviceTier: null }, "codex-lb"))
      .toEqual({ model: "future-model", serviceTier: null });
    expect(codexAppServerModelParams(params, "openai")).toEqual(params);
  });
  test("projects the generated profile through app-server config overrides", () => {
    const profile = [
      'model_provider = "openai"',
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      'model_catalog_json = "/tmp/codex/models.json"',
      "",
      "[features]",
      "fast_mode = true",
      "",
    ].join("\n");

    expect(remodexCodexAppServerArgs(10106, profile)).toEqual([
      "--config",
      'model_provider="openai"',
      "--config",
      'openai_base_url="http://127.0.0.1:10100/v1"',
      "--config",
      'model_catalog_json="/tmp/codex/models.json"',
      "--config",
      "features.fast_mode=true",
      "--enable",
      "goals",
      "app-server",
      "--listen",
      "ws://127.0.0.1:10106",
    ]);
  });

  test("keeps the historical invocation when integration has no profile", () => {
    expect(remodexCodexAppServerArgs(10106, null)).toEqual([
      "--enable",
      "goals",
      "app-server",
      "--listen",
      "ws://127.0.0.1:10106",
    ]);
  });

  test("projects the authenticated provider table without putting a key value in argv", () => {
    const profile = [
      'model_provider = "opencodex"',
      'model_catalog_json = "C:\\\\Codex\\\\models.json"',
      "",
      "[model_providers.opencodex]",
      'name = "Remodex"',
      'base_url = "http://192.0.2.10:10100/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      'env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }',
      "supports_websockets = true",
      "",
    ].join("\n");

    const args = codexAppServerProfileOverrideArgs(profile);
    expect(args).toContain('model_provider="opencodex"');
    expect(args).toContain('model_providers.opencodex.base_url="http://192.0.2.10:10100/v1"');
    expect(args).toContain(
      'model_providers.opencodex.env_http_headers.x-opencodex-api-key="OPENCODEX_API_AUTH_TOKEN"',
    );
    expect(args.join(" ")).not.toContain("must-not-enter-argv");
  });

  test("fails closed for unsupported profile keys", () => {
    expect(() => codexAppServerProfileOverrideArgs([
      'model_provider = "openai"',
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "must-not-enter-argv"',
    ].join("\n"))).toThrow("unsupported key");
  });
});
