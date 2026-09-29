import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { providerPreStreamNonJsonRetryStatuses } from "../src/providers/registry";
import { handleResponses } from "../src/server/responses";
import type { RequestLogContext } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function config(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "opencode-zen",
    providers: {
      "opencode-zen": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/v1",
        authMode: "key",
        apiKey: "test-key",
      },
    },
  } as OcxConfig;
}

function request(stream: boolean): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "opencode-zen/x-preview-f-free",
      input: "Reply with OK",
      reasoning: { effort: "max" },
      stream,
    }),
  });
}

function chatCompletionSse(): Response {
  return new Response(
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n'
      + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("OpenCode Zen transient non-JSON 405 recovery", () => {
  test("the capability is exact-destination and provider opt-in only", () => {
    expect(providerPreStreamNonJsonRetryStatuses("opencode-zen", {
      adapter: "openai-chat",
      baseUrl: "https://opencode.ai/zen/v1",
      authMode: "key",
    })).toEqual([405]);
    expect(providerPreStreamNonJsonRetryStatuses("opencode-zen", {
      adapter: "openai-chat",
      baseUrl: "https://custom.example/v1",
      authMode: "key",
    })).toEqual([]);
    expect(providerPreStreamNonJsonRetryStatuses("vercel-ai-gateway", {
      adapter: "openai-chat",
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      authMode: "key",
    })).toEqual([]);
  });

  test("streaming request retries the HTML 405 on a fresh connection and records the recovery", async () => {
    let sends = 0;
    let failedBodyCancelled = false;
    let retryInit: RequestInit | undefined;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async (_input, init) => {
      sends += 1;
      if (sends === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<html>Method Not Allowed</html>"));
          },
          cancel() {
            failedBodyCancelled = true;
          },
        }), {
          status: 405,
          headers: {
            "content-type": "text/html",
            "retry-after": "0",
          },
        });
      }
      retryInit = init;
      return chatCompletionSse();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    try {
      const response = await handleResponses(request(true), config(), logCtx);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("OK");
      expect(sends).toBe(2);
      expect(failedBodyCancelled).toBe(true);
      expect(retryInit?.keepalive).toBe(false);
      expect(new Headers(retryInit?.headers).get("connection")).toBe("close");
      expect(logCtx.attempts?.[0]).toMatchObject({
        provider: "opencode-zen",
        model: "x-preview-f-free",
        adapter: "openai-chat",
        sendCount: 2,
        recoveryKinds: ["transient-non-json"],
        requestedEffort: "max",
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("a genuine JSON 405 remains terminal and is not replayed", async () => {
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return Response.json({
        error: {
          type: "invalid_request_error",
          message: "method is not allowed for this route",
        },
      }, { status: 405 });
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(false), config(), logCtx);

    expect(response.status).toBe(405);
    expect(sends).toBe(1);
    expect(logCtx.attempts?.[0]).toMatchObject({
      sendCount: 1,
      recoveryKinds: [],
    });
  });
});
