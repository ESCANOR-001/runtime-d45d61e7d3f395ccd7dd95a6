import { describe, expect, test } from "bun:test";
import type {
  PersistedConfigMutation,
  PersistedConfigMutationOutcome,
} from "../src/config";
import {
  adoptActiveCodexLbProvider,
  inspectActiveCodexLbProvider,
  isManagedActiveCodexLbProvider,
  providerForCodexLb,
} from "../src/codex/provider-adoption";
import type { OcxConfig } from "../src/types";
import { routeModel } from "../src/router";

function config(): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "cursor",
    providers: {
      cursor: {
        adapter: "cursor-agent",
        baseUrl: "https://api2.cursor.sh",
        authMode: "oauth",
      },
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "${OPENCODE_API_KEY}",
      },
    },
  } as OcxConfig;
}

function codexLb(overrides: string[] = [], eol = "\n"): string {
  return [
    'model = "gpt-5.6-sol"',
    'model_provider = "codex-lb"',
    "",
    "[model_providers.codex-lb]",
    'name = "codex-lb"',
    'base_url = "https://chatgpt.tryvanta.bond/backend-api/codex"',
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    "requires_openai_auth = true",
    ...overrides,
    "",
  ].join(eol);
}

function memoryMutation(initial: OcxConfig): {
  mutate: <T>(fn: (value: OcxConfig) => PersistedConfigMutation<T>) => PersistedConfigMutationOutcome<T>;
  read: () => OcxConfig;
} {
  let state = structuredClone(initial);
  return {
    mutate<T>(fn: (value: OcxConfig) => PersistedConfigMutation<T>): PersistedConfigMutationOutcome<T> {
      const next = structuredClone(state);
      const result = fn(next);
      if (result.changed) state = next;
      return { status: result.changed ? "committed" : "unchanged", value: result.value };
    },
    read: () => structuredClone(state),
  };
}

describe("Codex Desktop codex-lb adoption", () => {
  test("imports only the Responses metadata and environment reference", () => {
    const live = config();
    const memory = memoryMutation(live);
    process.env.CODEX_LB_API_KEY = "super-secret-resolved-value";
    try {
      const result = adoptActiveCodexLbProvider(codexLb(), live, memory.mutate);
      expect(result.kind).toBe("adopted");
      expect(memory.read().providers.cursor).toEqual(config().providers.cursor);
      expect(memory.read().providers["opencode-go"]).toEqual(config().providers["opencode-go"]);
      expect(memory.read().providers["codex-lb"]).toMatchObject({
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.tryvanta.bond/backend-api/codex",
        responsesPath: "/responses",
        authMode: "key",
        apiKey: "${CODEX_LB_API_KEY}",
      });
      expect(JSON.stringify(memory.read())).not.toContain("super-secret-resolved-value");
      expect(isManagedActiveCodexLbProvider(codexLb(), live)).toBe(true);
      expect(routeModel(live, "codex-lb/gpt-5.6-sol")).toMatchObject({
        providerName: "codex-lb",
        modelId: "gpt-5.6-sol",
        provider: {
          baseUrl: "https://chatgpt.tryvanta.bond/backend-api/codex",
          responsesPath: "/responses",
          apiKey: "super-secret-resolved-value",
        },
      });

      const second = adoptActiveCodexLbProvider(codexLb(), live, memory.mutate);
      expect(second.kind).toBe("already-managed");
    } finally {
      delete process.env.CODEX_LB_API_KEY;
    }
  });

  test("parses CRLF and preserves a compatible user-managed credential", () => {
    const live = config();
    live.providers["codex-lb"] = {
      ...providerForCodexLb({
        id: "codex-lb",
        baseUrl: "https://chatgpt.tryvanta.bond/backend-api/codex",
        envKey: "CODEX_LB_API_KEY",
        wireApi: "responses",
        requiresOpenAiAuth: true,
      }),
      apiKey: "${USER_MANAGED_CODEX_LB_KEY}",
    };
    const memory = memoryMutation(live);
    expect(adoptActiveCodexLbProvider(codexLb([], "\r\n"), live, memory.mutate).kind)
      .toBe("already-managed");
    expect(memory.read().providers["codex-lb"]?.apiKey).toBe("${USER_MANAGED_CODEX_LB_KEY}");
  });

  test("refuses unsupported wires, missing env references, and routing loops", () => {
    const live = config();
    const cases = [
      codexLb().replace('wire_api = "responses"', 'wire_api = "chat"'),
      codexLb().replace('env_key = "CODEX_LB_API_KEY"', 'env_key = ""'),
      codexLb().replace(
        "https://chatgpt.tryvanta.bond/backend-api/codex",
        "http://127.0.0.1:10100/v1",
      ),
    ];
    for (const content of cases) {
      expect(inspectActiveCodexLbProvider(content, live).kind).toBe("refused");
    }

    const namedSelf = config();
    namedSelf.hostname = "ocx.example.test";
    expect(inspectActiveCodexLbProvider(
      codexLb().replace(
        "https://chatgpt.tryvanta.bond/backend-api/codex",
        "http://ocx.example.test:10100/v1",
      ),
      namedSelf,
    )).toMatchObject({ kind: "refused", reason: expect.stringContaining("this Remodex server") });
  });

  test("does not overwrite an incompatible provider name collision", () => {
    const live = config();
    live.providers["codex-lb"] = {
      adapter: "openai-chat",
      baseUrl: "https://another.example.test/v1",
      apiKey: "${ANOTHER_KEY}",
    };
    const before = structuredClone(live);
    const memory = memoryMutation(live);
    expect(adoptActiveCodexLbProvider(codexLb(), live, memory.mutate)).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("not overwritten"),
    });
    expect(memory.read()).toEqual(before);
    expect(live).toEqual(before);
  });
});
