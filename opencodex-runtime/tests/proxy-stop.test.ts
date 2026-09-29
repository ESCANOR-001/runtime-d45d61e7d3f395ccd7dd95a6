import { describe, expect, test } from "bun:test";
import { prepareProxyStop, type ProxyStopPreparationIo } from "../src/server/proxy-stop";

function stopIo(overrides: Partial<ProxyStopPreparationIo> = {}) {
  const calls: string[] = [];
  const io: ProxyStopPreparationIo = {
    acquireDrain: () => {
      calls.push("drain:acquire");
      return { release: () => { calls.push("drain:release"); } };
    },
    assertServiceOwnership: () => { calls.push("service:preflight"); },
    restoreNativeCodex: async () => {
      calls.push("codex:restore");
      return { success: true, message: "restored" };
    },
    restoreGrok: () => {
      calls.push("grok:restore");
      return { ok: true, message: "restored" };
    },
    serviceInstalled: () => {
      calls.push("service:installed");
      return true;
    },
    stopService: () => {
      calls.push("service:stop");
      return true;
    },
    requestServiceStop: () => { calls.push("service:marker:set"); },
    clearServiceStopRequest: () => { calls.push("service:marker:clear"); },
    beginShutdown: () => { calls.push("shutdown:begin"); },
    ...overrides,
  };
  return { io, calls };
}

describe("proxy stop preparation", () => {
  test("fences new work, restores owned config, stops supervision, then commits shutdown", async () => {
    const { io, calls } = stopIo();
    expect(await prepareProxyStop(io)).toEqual({
      ok: true,
      message: "Proxy stopping; Remodex-owned client configuration was restored.",
    });
    expect(calls).toEqual([
      "drain:acquire",
      "service:preflight",
      "service:installed",
      "codex:restore",
      "grok:restore",
      "service:stop",
      "shutdown:begin",
      "drain:release",
    ]);
  });

  test("a Codex restoration failure keeps the proxy and service alive", async () => {
    const fixture = stopIo();
    fixture.io.restoreNativeCodex = async () => {
      fixture.calls.push("codex:restore");
      return { success: false, message: "managed marker conflict" };
    };
    const result = await prepareProxyStop(fixture.io);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.message).toContain("Proxy is still running");
    expect(fixture.calls).toEqual([
      "drain:acquire",
      "service:preflight",
      "service:installed",
      "codex:restore",
      "drain:release",
    ]);
  });

  test("a service stop failure never commits process shutdown", async () => {
    const fixture = stopIo();
    fixture.io.stopService = () => {
      fixture.calls.push("service:stop");
      return false;
    };
    const result = await prepareProxyStop(fixture.io);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(fixture.calls).not.toContain("shutdown:begin");
    expect(fixture.calls.at(-1)).toBe("drain:release");
  });

  test("a supervised service process does not force-stop its own manager", async () => {
    const fixture = stopIo({ isServiceProcess: () => true });
    expect(await prepareProxyStop(fixture.io)).toEqual({
      ok: true,
      message: "Proxy stopping; Remodex-owned client configuration was restored.",
    });
    expect(fixture.calls).toEqual([
      "drain:acquire",
      "service:preflight",
      "service:installed",
      "service:marker:set",
      "codex:restore",
      "grok:restore",
      "shutdown:begin",
      "drain:release",
    ]);
    expect(fixture.calls).not.toContain("service:stop");
  });

  test("clears the supervised-stop marker when restoration is refused", async () => {
    const fixture = stopIo({ isServiceProcess: () => true });
    fixture.io.restoreNativeCodex = async () => {
      fixture.calls.push("codex:restore");
      return { success: false, message: "managed marker conflict" };
    };

    const result = await prepareProxyStop(fixture.io);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(fixture.calls).toEqual([
      "drain:acquire",
      "service:preflight",
      "service:installed",
      "service:marker:set",
      "codex:restore",
      "service:marker:clear",
      "drain:release",
    ]);
  });

  test("a concurrent lifecycle action is refused without running teardown", async () => {
    const { io, calls } = stopIo({ acquireDrain: () => null });
    expect(await prepareProxyStop(io)).toEqual({
      ok: false,
      status: 409,
      message: "Another proxy lifecycle action is already in progress. Retry shortly.",
    });
    expect(calls).toEqual([]);
  });
});
