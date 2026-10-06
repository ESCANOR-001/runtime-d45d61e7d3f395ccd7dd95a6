import { describe, expect, test } from "bun:test";
import {
  AndroidDesktopIpcLiveSync,
  DESKTOP_IPC_OWNER_DISCOVERY_METHOD,
  DesktopIpcOwnershipError,
  type DesktopIpcDiscoveryResult,
  type DesktopIpcTransportLike,
} from "../src/android-remote/desktop-ipc";
import { createAndroidDesktopOwnershipStore } from "../src/android-remote/desktop-ownership-store";

const threadId = "owner-retry-thread";
const method = "thread-follower-start-turn";
const params = {
  conversationId: threadId,
  commandId: "stable-command",
  turnStart: {
    request: {
      threadId,
      clientUserMessageId: "stable-message",
      input: [{ type: "text", text: "Send exactly once." }],
    },
    context: { inheritThreadSettings: true },
  },
};

class OwnerRetryTransport implements DesktopIpcTransportLike {
  connected = true;
  localClientId = "private-bridge";
  handlers: Parameters<DesktopIpcTransportLike["setHandlers"]>[0] | null = null;
  requests: Array<{
    method: string;
    params: Record<string, unknown>;
    options?: { targetClientId?: string };
  }> = [];
  discoveries: Array<{ method: string; params: Record<string, unknown> }> = [];
  broadcasts: string[] = [];
  discoverOwner: () => Promise<DesktopIpcDiscoveryResult> = async () => ({ canHandle: false });
  handleMutation: () => Promise<unknown> = async () => ({ ok: true });

  start(): void {}
  stop(): void {}
  setHandlers(handlers: NonNullable<OwnerRetryTransport["handlers"]>): void {
    this.handlers = handlers;
  }
  sendBroadcast(method: string): boolean {
    this.broadcasts.push(method);
    return this.connected;
  }
  discover(method: string, params: Record<string, unknown>): Promise<DesktopIpcDiscoveryResult> {
    this.discoveries.push({ method, params: structuredClone(params) });
    return this.discoverOwner();
  }
  request(
    method: string,
    params: Record<string, unknown>,
    options?: { targetClientId?: string },
  ): Promise<unknown> {
    this.requests.push({ method, params: structuredClone(params), options });
    return this.handleMutation();
  }
  publishOwner(ownerClientId: string): void {
    this.handlers?.onBroadcast({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: ownerClientId,
      params: {
        conversationId: threadId,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: { id: threadId, turns: [], requests: [] },
        },
      },
    });
  }
}

function setup(ownerClientId?: string, openUrl: (url: string) => Promise<void> = async () => {
  throw new Error("Desktop opening unavailable in this fixture");
}) {
  const transport = new OwnerRetryTransport();
  const ownershipStore = createAndroidDesktopOwnershipStore();
  ownershipStore.remember(threadId);
  const localRequests: string[] = [];
  const historyReads: string[] = [];
  const sync = new AndroidDesktopIpcLiveSync({
    transport,
    openUrl,
    ownershipStore,
    ownerReacquireTimeoutMs: 10,
    readThread: async requestedThreadId => {
      historyReads.push(requestedThreadId);
      throw new Error("owner discovery must not read history");
    },
    sendCodexRequest: async requestedMethod => {
      localRequests.push(requestedMethod);
      throw new Error("must not start a private writer");
    },
    respondToCodexRequest: () => undefined,
  });
  if (ownerClientId) transport.publishOwner(ownerClientId);
  const checkSafety = () => {
    expect(localRequests).toEqual([]);
    expect(historyReads).toEqual([]);
    expect(transport.broadcasts).toEqual([]);
    expect(sync.threadOwnership(threadId).state).toBe("desktop-owned");
    expect(sync.isThreadOwned(threadId)).toBe(false);
    expect(() => sync.adoptLocalThread(threadId)).toThrow("explicit owner release");
    for (const discovery of transport.discoveries) {
      expect(discovery).toEqual({
        method: DESKTOP_IPC_OWNER_DISCOVERY_METHOD,
        params: { hostId: "local", conversationId: threadId },
      });
    }
    for (const request of transport.requests) {
      expect(request.method).toBe(method);
      expect(request.params).toEqual(params);
      expect(request.options?.targetClientId).toMatch(/^desktop-owner-/u);
    }
  };
  return { transport, sync, checkSafety };
}

describe("Desktop follower owner retry", () => {
  test("reactivates an unmounted remembered Desktop task before sending exactly once", async () => {
    const opened: string[] = [];
    const { transport, sync, checkSafety } = setup(undefined, async url => { opened.push(url); });
    transport.discoverOwner = async () => opened.length === 0
      ? { canHandle: false }
      : { canHandle: true, handledByClientId: "desktop-owner-remounted" };
    try {
      await expect(sync.requestFollowerAction(method, params)).resolves.toEqual({ ok: true });
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatch(/^codex:\/\/threads\/owner-retry-thread\?opencodex-reactivate=/u);
      expect(transport.requests).toHaveLength(1);
      expect(transport.requests[0]?.options?.targetClientId).toBe("desktop-owner-remounted");
      checkSafety();
    } finally { sync.stop(); }
  });

  test("waits for asynchronous Desktop mounting after opening the existing task", async () => {
    const opened: string[] = [];
    let mountingProbes = 0;
    const { transport, sync, checkSafety } = setup(undefined, async url => { opened.push(url); });
    transport.discoverOwner = async () => opened.length > 0 && ++mountingProbes >= 3
      ? { canHandle: true, handledByClientId: "desktop-owner-ready" }
      : { canHandle: false };
    try {
      await expect(sync.requestFollowerAction(method, params)).resolves.toEqual({ ok: true });
      expect(opened).toHaveLength(1);
      expect(mountingProbes).toBe(3);
      expect(transport.requests).toHaveLength(1);
      checkSafety();
    } finally { sync.stop(); }
  });

  test("replaces a rejected cached owner and waits for the reactivated follower handler", async () => {
    const opened: string[] = [];
    const { transport, sync, checkSafety } = setup("desktop-owner-old", async url => { opened.push(url); });
    transport.discoverOwner = async () => opened.length > 0
      ? { canHandle: true, handledByClientId: "desktop-owner-new" }
      : { canHandle: false };
    transport.handleMutation = async () => {
      if (transport.requests.length < 3) throw new Error("no-client-found");
      return { ok: true };
    };
    try {
      await expect(sync.requestFollowerAction(method, params)).resolves.toEqual({ ok: true });
      expect(opened).toHaveLength(1);
      expect(transport.requests.map(request => request.options?.targetClientId)).toEqual([
        "desktop-owner-old", "desktop-owner-new", "desktop-owner-new",
      ]);
      checkSafety();
    } finally { sync.stop(); }
  });

  test("coalesces concurrent activation for actions on the same task", async () => {
    const opened: string[] = [];
    const { transport, sync } = setup(undefined, async url => {
      opened.push(url);
      await Bun.sleep(40);
    });
    let ready = false;
    transport.discoverOwner = async () => ready
      ? { canHandle: true, handledByClientId: "desktop-owner-ready" }
      : { canHandle: false };
    const first = sync.requestFollowerAction(method, params);
    const second = sync.requestFollowerAction("thread-follower-submit-user-input", params);
    try {
      for (let attempt = 0; attempt < 100 && opened.length === 0; attempt += 1) await Bun.sleep(10);
      expect(opened).toHaveLength(1);
      ready = true;
      await Promise.all([first, second]);
      expect(opened).toHaveLength(1);
      expect(transport.requests.map(request => request.method).sort()).toEqual([
        method, "thread-follower-submit-user-input",
      ].sort());
      expect(transport.requests.every(request => request.options?.targetClientId === "desktop-owner-ready")).toBe(true);
      expect(transport.broadcasts).toEqual([]);
    } finally { sync.stop(); }
  });

  test.each([
    "thread-follower-load-history-page",
    "thread-follower-read-content-chunk",
    "thread-follower-load-complete-history",
    "unknown-follower-method",
  ])("never opens Desktop for a background read or unknown method: %s", async readMethod => {
    const opened: string[] = [];
    const { transport, sync } = setup(undefined, async url => { opened.push(url); });
    try {
      await expect(sync.requestFollowerAction(readMethod, params)).rejects.toBeInstanceOf(DesktopIpcOwnershipError);
      expect(opened).toEqual([]);
      expect(transport.requests).toEqual([]);
    } finally { sync.stop(); }
  });

  test.each(["disconnected", "timed-out", "failed-open"])("fails closed when recovery is %s", async failure => {
    const opened: string[] = [];
    const { transport, sync, checkSafety } = setup(undefined, async url => {
      opened.push(url);
      throw new Error("Desktop is unavailable");
    });
    if (failure === "disconnected") transport.connected = false;
    if (failure === "timed-out") transport.discoverOwner = async () => ({ canHandle: false, timedOut: true });
    try {
      await expect(sync.requestFollowerAction(method, params)).rejects.toBeInstanceOf(DesktopIpcOwnershipError);
      expect(opened).toHaveLength(failure === "failed-open" ? 1 : 0);
      expect(transport.requests).toEqual([]);
      checkSafety();
    } finally { sync.stop(); }
  });

  test("bounds mounting retries when Desktop opens but never mounts the task", async () => {
    const opened: string[] = [];
    const { transport, sync, checkSafety } = setup(undefined, async url => { opened.push(url); });
    try {
      await expect(sync.requestFollowerAction(method, params)).rejects.toBeInstanceOf(DesktopIpcOwnershipError);
      expect(opened).toHaveLength(1);
      expect(transport.discoveries).toHaveLength(10);
      expect(transport.requests).toEqual([]);
      checkSafety();
    } finally { sync.stop(); }
  }, 10_000);

  test("never resends a possibly delivered mutation after reactivation", async () => {
    const opened: string[] = [];
    const { transport, sync, checkSafety } = setup(undefined, async url => { opened.push(url); });
    transport.discoverOwner = async () => opened.length > 0
      ? { canHandle: true, handledByClientId: "desktop-owner-ready" }
      : { canHandle: false };
    const failure = new Error("Codex Desktop IPC request timed out");
    transport.handleMutation = async () => { throw failure; };
    try {
      await expect(sync.requestFollowerAction(method, params)).rejects.toBe(failure);
      expect(opened).toHaveLength(1);
      expect(transport.requests).toHaveLength(1);
      checkSafety();
    } finally { sync.stop(); }
  });

  test("does not deliver an action if the bridge stops while Desktop is opening", async () => {
    const { transport, sync } = setup(undefined, async () => { sync.stop(); });
    try {
      await expect(sync.requestFollowerAction(method, params)).rejects.toBeInstanceOf(DesktopIpcOwnershipError);
      expect(transport.requests).toEqual([]);
    } finally { sync.stop(); }
  });

  test("retries metadata reacquisition when the initial renderer is not ready", async () => {
    const { transport, sync, checkSafety } = setup();
    transport.discoverOwner = async () => transport.discoveries.length < 3
      ? { canHandle: false }
      : { canHandle: true, handledByClientId: "desktop-owner-ready" };
    try {
      await expect(sync.requestFollowerAction(method, params)).resolves.toEqual({ ok: true });
      expect(transport.discoveries).toHaveLength(3);
      expect(transport.requests).toHaveLength(1);
      expect(transport.requests[0]?.options?.targetClientId).toBe("desktop-owner-ready");
      checkSafety();
    } finally { sync.stop(); }
  });

  test("does not abandon a rejected owner when replacement discovery initially misses", async () => {
    const { transport, sync, checkSafety } = setup("desktop-owner-old");
    transport.handleMutation = async () => {
      if (transport.requests.length === 1) throw new Error("no-client-found");
      return { ok: true };
    };
    transport.discoverOwner = async () => transport.discoveries.length === 1
      ? { canHandle: false }
      : { canHandle: true, handledByClientId: "desktop-owner-replacement" };
    try {
      await expect(sync.requestFollowerAction(method, params)).resolves.toEqual({ ok: true });
      expect(transport.discoveries).toHaveLength(2);
      expect(transport.requests.map(request => request.options?.targetClientId)).toEqual([
        "desktop-owner-old", "desktop-owner-replacement",
      ]);
      checkSafety();
    } finally { sync.stop(); }
  });

  test("retries the same discovered owner until its follower handler is registered", async () => {
    const { transport, sync, checkSafety } = setup("desktop-owner-ready");
    transport.discoverOwner = async () => ({ canHandle: true, handledByClientId: "desktop-owner-ready" });
    transport.handleMutation = async () => {
      if (transport.requests.length < 3) throw new Error("No Codex IPC client can handle this request");
      return { ok: true };
    };
    try {
      await expect(sync.requestFollowerAction(method, params)).resolves.toEqual({ ok: true });
      expect(transport.requests).toHaveLength(3);
      expect(transport.discoveries).toHaveLength(2);
      checkSafety();
    } finally { sync.stop(); }
  });

  test.each([undefined, "desktop-owner-offline"])(
    "exhausts read-only discovery without sending to a missing owner (%s)",
    async ownerClientId => {
      const { transport, sync, checkSafety } = setup(ownerClientId);
      transport.handleMutation = async () => { throw new Error("no-client-found"); };
      try {
        const error = await sync.requestFollowerAction(method, params).catch(error => error);
        expect(error).toBeInstanceOf(DesktopIpcOwnershipError);
        expect(error).toMatchObject({
          threadId, method, reason: "owner-unavailable", attempts: ownerClientId ? 1 : 0,
        });
        expect(transport.discoveries).toHaveLength(ownerClientId ? 3 : 4);
        expect(transport.requests).toHaveLength(ownerClientId ? 1 : 0);
        expect(sync.desktopOwnerClientId(threadId)).toBeNull();
        checkSafety();
      } finally { sync.stop(); }
    },
  );

  test("bounds definitive no-handler retries and does not rediscover after the final send", async () => {
    const { transport, sync, checkSafety } = setup("desktop-owner-ready");
    transport.discoverOwner = async () => ({ canHandle: true, handledByClientId: "desktop-owner-ready" });
    transport.handleMutation = async () => { throw new Error("no-client-found"); };
    try {
      const error = await sync.requestFollowerAction(method, params).catch(error => error);
      expect(error).toBeInstanceOf(DesktopIpcOwnershipError);
      expect(error).toMatchObject({ threadId, method, reason: "no-client-found", attempts: 3 });
      expect(transport.requests).toHaveLength(3);
      expect(transport.discoveries).toHaveLength(2);
      checkSafety();
    } finally { sync.stop(); }
  });

  test.each([
    "Codex Desktop IPC request timed out",
    "Codex Desktop IPC connection closed",
    "Codex Desktop IPC is not connected",
    "Codex Desktop IPC write failed",
    "Codex Desktop IPC response method mismatch",
    "unsupported method version",
    "conversation-not-owned",
    "thread not found",
    "Desktop application error",
    "Desktop application error: no-client-found",
    "Codex Desktop IPC request timed out: no-client-found",
    "Codex Desktop IPC response method mismatch: expected thread-follower-start-turn, received no-client-found",
  ])("never replays or rediscovers after %s", async message => {
    const { transport, sync, checkSafety } = setup("desktop-owner-ready");
    const failure = new Error(message);
    transport.handleMutation = async () => { throw failure; };
    try {
      await expect(sync.requestFollowerAction(method, params)).rejects.toBe(failure);
      expect(transport.requests).toHaveLength(1);
      expect(transport.discoveries).toHaveLength(0);
      expect(sync.desktopOwnerClientId(threadId)).toBe("desktop-owner-ready");
      checkSafety();
    } finally { sync.stop(); }
  });

  test("stops after an ambiguous replacement-owner result rather than duplicating the prompt", async () => {
    const { transport, sync, checkSafety } = setup("desktop-owner-old");
    const failure = new Error("Codex Desktop IPC request timed out");
    transport.discoverOwner = async () => ({ canHandle: true, handledByClientId: "desktop-owner-replacement" });
    transport.handleMutation = async () => {
      if (transport.requests.length === 1) throw new Error("no-client-found");
      throw failure;
    };
    try {
      await expect(sync.requestFollowerAction(method, params)).rejects.toBe(failure);
      expect(transport.requests).toHaveLength(2);
      expect(transport.discoveries).toHaveLength(1);
      checkSafety();
    } finally { sync.stop(); }
  });

  test("retains a newer authoritative renderer observed before the old route is rejected", async () => {
    const { transport, sync, checkSafety } = setup("desktop-owner-old");
    transport.handleMutation = async () => {
      if (transport.requests.length === 1) {
        transport.publishOwner("desktop-owner-replacement");
        throw new Error("no-client-found");
      }
      return { ok: true };
    };
    try {
      await expect(sync.requestFollowerAction(method, params)).resolves.toEqual({ ok: true });
      expect(transport.requests.map(request => request.options?.targetClientId)).toEqual([
        "desktop-owner-old", "desktop-owner-replacement",
      ]);
      expect(transport.discoveries).toHaveLength(0);
      checkSafety();
    } finally { sync.stop(); }
  });
});
