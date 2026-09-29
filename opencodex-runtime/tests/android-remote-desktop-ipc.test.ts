import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import {
  AndroidDesktopIpcLiveSync,
  DesktopIpcFrameReader,
  DesktopIpcTransport,
  buildDesktopStatePatches,
  codexDesktopOpenCommands,
  DESKTOP_IPC_METHOD_VERSIONS,
  DESKTOP_IPC_OWNER_DISCOVERY_METHOD,
  desktopIpcRequestVersion,
  desktopIpcSocketPaths,
  encodeDesktopIpcFrame,
  openCodexDesktopThread,
  type DesktopIpcEnvelope,
  type DesktopIpcResponseSettled,
  type DesktopIpcTransportLike,
} from "../src/android-remote/desktop-ipc";

type TransportHandlers = Parameters<DesktopIpcTransportLike["setHandlers"]>[0];

class FakeLiveTransport implements DesktopIpcTransportLike {
  connected = true;
  localClientId = "local-opencodex-client";
  generation = 1;
  starts = 0;
  stops = 0;
  resets = 0;
  broadcasts: Array<{ method: string; params: Record<string, unknown> }> = [];
  handlers: TransportHandlers | null = null;
  requestOverride: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | null = null;

  start(): void { this.starts += 1; }
  stop(): void { this.stops += 1; }
  reset(): void {
    this.resets += 1;
    this.disconnect();
  }
  setHandlers(handlers: TransportHandlers): void { this.handlers = handlers; }
  sendBroadcast(method: string, params: Record<string, unknown>): boolean {
    this.broadcasts.push({ method, params: structuredClone(params) });
    return this.connected;
  }
  connect(): void {
    this.connected = true;
    this.handlers?.onConnected();
  }
  disconnect(): void {
    this.connected = false;
    this.handlers?.onDisconnected?.();
  }
  broadcast(envelope: DesktopIpcEnvelope): void { this.handlers?.onBroadcast(envelope); }
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.requestOverride) return this.requestOverride(method, params);
    if (!this.handlers) throw new Error("handlers not installed");
    return this.handlers.handleRequest({ type: "request", method, params, requestId: "desktop-test" });
  }
}

/** Transport double that preserves the target id exactly as the router does. */
class TargetedLiveTransport implements DesktopIpcTransportLike {
  connected = true;
  localClientId = "opencodex-local";
  generation = 1;
  handlers: TransportHandlers | null = null;
  broadcasts: Array<{ method: string; params: Record<string, unknown> }> = [];
  requests: Array<{
    method: string;
    params: Record<string, unknown>;
    options?: { targetClientId?: string };
  }> = [];
  requestOverride: ((
    method: string,
    params: Record<string, unknown>,
    options?: { targetClientId?: string },
  ) => Promise<unknown>) | null = null;

  start(): void {}
  stop(): void {}
  setHandlers(handlers: TransportHandlers): void { this.handlers = handlers; }
  sendBroadcast(method: string, params: Record<string, unknown>): boolean {
    this.broadcasts.push({ method, params: structuredClone(params) });
    return this.connected;
  }
  request(
    method: string,
    params: Record<string, unknown>,
    options?: { targetClientId?: string },
  ): Promise<unknown> {
    this.requests.push({ method, params: structuredClone(params), options: structuredClone(options) });
    if (this.requestOverride) return this.requestOverride(method, params, options);
    throw new Error("no-client-found");
  }
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes: Buffer[] = [];
  onWrite: ((envelope: DesktopIpcEnvelope) => void) | null = null;

  write(buffer: Buffer): boolean {
    this.writes.push(Buffer.from(buffer));
    const size = buffer.readUInt32LE(0);
    const envelope = JSON.parse(buffer.subarray(4, 4 + size).toString("utf8")) as DesktopIpcEnvelope;
    this.onWrite?.(envelope);
    return true;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

async function settle(): Promise<void> {
  await Bun.sleep(10);
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Desktop IPC state");
    await Bun.sleep(5);
  }
}

describe("Android Remote Codex Desktop IPC", () => {
  test("uses the installed Desktop v2/v4 envelopes and preserves the target id", async () => {
    expect(DESKTOP_IPC_METHOD_VERSIONS.get("thread-follower-start-turn")).toBe(2);
    expect(DESKTOP_IPC_METHOD_VERSIONS.get("thread-follower-interrupt-turn")).toBe(4);
    expect(desktopIpcRequestVersion("thread-follower-interrupt-turn", {
      conversationId: "envelope-thread",
      expectedTurnId: "turn-1",
    })).toBe(4);
    expect(desktopIpcRequestVersion("thread-follower-interrupt-turn", {
      conversationId: "envelope-thread",
    })).toBe(3);

    const socket = new FakeSocket();
    const transport = new DesktopIpcTransport({
      paths: () => ["test-pipe"],
      connect: () => {
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as Socket;
      },
      now: () => 42,
      reconnectMs: 60_000,
      warn: () => undefined,
    });
    transport.setHandlers({
      onConnected: () => undefined,
      onBroadcast: () => undefined,
      canHandleRequest: () => false,
      handleRequest: async () => null,
    });
    socket.onWrite = envelope => {
      queueMicrotask(() => socket.emit("data", encodeDesktopIpcFrame({
        type: "response",
        requestId: envelope.requestId,
        resultType: "success",
        result: envelope.method === "initialize"
          ? { clientId: "opencodex-local" }
          : { handledByClientId: "desktop-owner-reconnected" },
        handledByClientId: envelope.method === "initialize"
          ? "router"
          : "desktop-owner-reconnected",
      })));
    };
    transport.start();
    await settle();
    await transport.request("thread-follower-start-turn", {
      conversationId: "envelope-thread",
      commandId: "stable-command",
      turnStart: {
        request: {
          threadId: "envelope-thread",
          clientUserMessageId: "stable-message",
          input: [],
        },
        context: { inheritThreadSettings: true },
      },
    }, { targetClientId: "desktop-owner-reconnected" });
    await transport.request("thread-follower-interrupt-turn", {
      conversationId: "envelope-thread",
      mode: "user-stop",
      expectedTurnId: "turn-1",
    }, { targetClientId: "desktop-owner-reconnected" });

    const envelopes = socket.writes.map(frame =>
      JSON.parse(frame.subarray(4).toString("utf8")) as DesktopIpcEnvelope,
    );
    expect(envelopes.find(row => row.method === "thread-follower-start-turn")).toMatchObject({
      version: 2,
      targetClientId: "desktop-owner-reconnected",
      params: {
        turnStart: { context: { inheritThreadSettings: true } },
      },
    });
    expect(envelopes.find(row => row.method === "thread-follower-interrupt-turn")).toMatchObject({
      version: 4,
      targetClientId: "desktop-owner-reconnected",
      params: {
        conversationId: "envelope-thread",
        mode: "user-stop",
        expectedTurnId: "turn-1",
      },
    });
    expect(envelopes.find(row => row.method === "thread-follower-interrupt-turn")?.params)
      .not.toHaveProperty("turnId");
    transport.stop();
  });

  test("targets the authoritative owner, retries only no-client-found, and never falls back locally", async () => {
    const transport = new TargetedLiveTransport();
    const threadId = "owner-target-thread";
    let attempts = 0;
    transport.requestOverride = async (method, _params, options) => {
      if (method === DESKTOP_IPC_OWNER_DISCOVERY_METHOD) {
        return { handledByClientId: "desktop-owner-a" };
      }
      attempts += 1;
      expect(options?.targetClientId).toBe("desktop-owner-a");
      if (attempts === 1) throw new Error("no-client-found");
      return { handledByClientId: "desktop-owner-a", ok: true };
    };
    const localRequests: string[] = [];
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      ownerReacquireTimeoutMs: 20,
      readThread: async () => null,
      sendCodexRequest: async method => {
        localRequests.push(method);
        return {};
      },
      respondToCodexRequest: () => undefined,
    });
    transport.handlers?.onBroadcast({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "desktop-owner-a",
      params: {
        conversationId: threadId,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: { id: threadId, turns: [], requests: [] },
        },
      },
    });

    await expect(sync.requestFollowerAction("thread-follower-start-turn", {
      conversationId: threadId,
      commandId: "stable-command",
      turnStart: {
        request: { threadId, clientUserMessageId: "stable-message", input: [] },
        context: { inheritThreadSettings: true },
      },
    })).resolves.toMatchObject({ ok: true });
    expect(attempts).toBe(2);
    expect(transport.requests
      .filter(row => row.method === "thread-follower-start-turn")
      .map(row => row.options?.targetClientId)).toEqual([
        "desktop-owner-a",
        "desktop-owner-a",
      ]);
    expect(localRequests).toEqual([]);
    sync.stop();
  });

  test("retains Desktop ownership across disconnect and reacquires a replacement renderer id", async () => {
    const transport = new TargetedLiveTransport();
    const threadId = "owner-reconnect-thread";
    let sync!: AndroidDesktopIpcLiveSync;
    transport.requestOverride = async (method, _params, options) => {
      if (method === DESKTOP_IPC_OWNER_DISCOVERY_METHOD) {
        transport.handlers?.onBroadcast({
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: "desktop-owner-b",
          params: {
            conversationId: threadId,
            change: {
              type: "snapshot",
              revision: 2,
              conversationState: { id: threadId, turns: [], requests: [] },
            },
          },
        });
        return { handledByClientId: "desktop-owner-b" };
      }
      expect(options?.targetClientId).toBe("desktop-owner-b");
      return { ok: true, handledByClientId: "desktop-owner-b" };
    };
    sync = new AndroidDesktopIpcLiveSync({
      transport,
      ownerReacquireTimeoutMs: 50,
      readThread: async () => null,
      sendCodexRequest: async () => { throw new Error("local writer must not be used"); },
      respondToCodexRequest: () => undefined,
    });
    transport.handlers?.onBroadcast({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "desktop-owner-a",
      params: {
        conversationId: threadId,
        change: { type: "snapshot", revision: 1, conversationState: { id: threadId, turns: [], requests: [] } },
      },
    });
    expect(sync.threadOwnership(threadId)).toMatchObject({
      state: "desktop-owned",
      ownerClientId: "desktop-owner-a",
      everDesktopOwned: true,
    });
    transport.connected = false;
    transport.handlers?.onDisconnected?.();
    expect(sync.threadOwnership(threadId)).toMatchObject({
      state: "desktop-owned",
      ownerClientId: null,
      everDesktopOwned: true,
    });
    transport.connected = true;
    transport.handlers?.onConnected();

    await expect(sync.requestFollowerAction("thread-follower-start-turn", {
      conversationId: threadId,
      turnStart: {
        request: { threadId, clientUserMessageId: "reconnect-message", input: [] },
        context: { inheritThreadSettings: true },
      },
    })).resolves.toMatchObject({ ok: true });
    expect(sync.threadOwnership(threadId)).toMatchObject({
      state: "desktop-owned",
      ownerClientId: "desktop-owner-b",
      everDesktopOwned: true,
    });
    sync.stop();
  });

  test("reacquires a replacement renderer after targeted no-client-found", async () => {
    const threadId = "owner-replaced-thread";
    const discoveries: string[] = [];
    const transport = Object.assign(new TargetedLiveTransport(), {
      discover: async (method: string) => {
        discoveries.push(method);
        return {
          canHandle: true,
          handledByClientId: "desktop-owner-b",
        };
      },
    });
    transport.requestOverride = async (method, _params, options) => {
      if (method !== "thread-follower-steer-turn") {
        throw new Error(`unexpected request: ${method}`);
      }
      if (options?.targetClientId === "desktop-owner-a") {
        throw new Error("no-client-found");
      }
      expect(options?.targetClientId).toBe("desktop-owner-b");
      return { turnId: "turn-1", handledByClientId: "desktop-owner-b" };
    };
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      ownerReacquireTimeoutMs: 20,
      readThread: async () => null,
      sendCodexRequest: async () => { throw new Error("local writer must not be used"); },
      respondToCodexRequest: () => undefined,
    });
    transport.handlers?.onBroadcast({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "desktop-owner-a",
      params: {
        conversationId: threadId,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: {
            id: threadId,
            turns: [{ id: "turn-1", status: "inProgress" }],
            requests: [],
          },
        },
      },
    });

    await expect(sync.requestFollowerAction("thread-follower-steer-turn", {
      conversationId: threadId,
      expectedTurnId: "turn-1",
      clientUserMessageId: "replacement-steer",
      input: [{ type: "text", text: "Use the replacement renderer." }],
    })).resolves.toMatchObject({ turnId: "turn-1" });
    expect(discoveries).toEqual([DESKTOP_IPC_OWNER_DISCOVERY_METHOD]);
    expect(transport.requests
      .filter(row => row.method === "thread-follower-steer-turn")
      .map(row => row.options?.targetClientId)).toEqual([
        "desktop-owner-a",
        "desktop-owner-b",
      ]);
    expect(sync.threadOwnership(threadId)).toMatchObject({
      state: "desktop-owned",
      ownerClientId: "desktop-owner-b",
      everDesktopOwned: true,
    });
    sync.stop();
  });

  test("refreshes a rejected writer route without forgetting Desktop ownership", async () => {
    const transport = new TargetedLiveTransport();
    const threadId = "refresh-writer-thread";
    let available = false;
    Object.assign(transport, {
      discover: async () => available
        ? { canHandle: true, handledByClientId: "replacement-owner" }
        : { canHandle: false },
    });
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      readThread: async () => { throw new Error("must not load history to discover an owner"); },
      sendCodexRequest: async () => { throw new Error("must not start a competing writer"); },
      respondToCodexRequest: () => undefined,
    });
    try {
      transport.handlers?.onBroadcast({ type: "broadcast", method: "thread-stream-state-changed",
        sourceClientId: "old-owner", params: { conversationId: threadId,
          change: { type: "snapshot", revision: 1, conversationState: { id: threadId, turns: [], requests: [] } } } });
      expect(await sync.probeFollowerRoute(threadId, { refreshOwner: true })).toBe("unhealthy");
      expect(sync.threadOwnership(threadId)).toMatchObject({ state: "desktop-owned", ownerClientId: null });
      available = true;
      expect(await sync.probeFollowerRoute(threadId, { refreshOwner: true })).toBe("ready");
      expect(sync.desktopOwnerClientId(threadId)).toBe("replacement-owner");
      expect(transport.requests).toHaveLength(0);
    } finally { sync.stop(); }
  });

  test("owner discovery is metadata-only and never asks for transcript state", async () => {
    const transport = new TargetedLiveTransport();
    const threadId = "owner-discovery-only-thread";
    const discovered: Array<{ method: string; params: Record<string, unknown> }> = [];
    const withDiscovery = Object.assign(transport, {
      discover: async (
        method: string,
        params: Record<string, unknown>,
      ) => {
        discovered.push({ method, params: structuredClone(params) });
        return { canHandle: true, handledByClientId: "desktop-owner-replacement" };
      },
    });
    withDiscovery.requestOverride = async (method: string) => {
      if (method === "thread-follower-load-complete-history") {
        throw new Error("unsafe complete-history request was attempted");
      }
      return { ok: true, handledByClientId: "desktop-owner-replacement" };
    };
    const sync = new AndroidDesktopIpcLiveSync({
      transport: withDiscovery,
      ownerReacquireTimeoutMs: 20,
      readThread: async () => ({ id: threadId, turns: [] }),
      sendCodexRequest: async () => { throw new Error("local writer must not be used"); },
      respondToCodexRequest: () => undefined,
    });
    transport.handlers?.onBroadcast({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "desktop-owner-old",
      params: {
        conversationId: threadId,
        change: { type: "snapshot", revision: 1, conversationState: { id: threadId, turns: [], requests: [] } },
      },
    });
    transport.handlers?.onDisconnected?.();
    transport.broadcasts = [];
    transport.handlers?.onConnected();
    await expect(sync.requestFollowerAction("thread-follower-start-turn", {
      conversationId: threadId,
      turnStart: { request: { threadId, input: [] }, context: {} },
    })).resolves.toMatchObject({ ok: true });
    expect(discovered).toEqual([{
      method: DESKTOP_IPC_OWNER_DISCOVERY_METHOD,
      params: { hostId: "local", conversationId: threadId },
    }]);
    expect(transport.broadcasts.some(row =>
      row.method === "thread-follower-load-complete-history"
      || row.method === "thread-stream-following-changed"
      || row.method === "thread-stream-following-status-requested",
    )).toBe(false);
    sync.stop();
  });

  test("a large logical conversation is always published as a bounded wire page", async () => {
    const transport = new FakeLiveTransport();
    const threadId = "large-wire-page-thread";
    const hugeText = "z".repeat(3 * 1024 * 1024);
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      snapshotDebounceMs: 0,
      followConfirmMs: 60_000,
      readThread: async id => ({
        id,
        hostId: "local",
        updatedAt: Date.now(),
        turns: Array.from({ length: 30 }, (_, index) => ({
          id: `turn-${index}`,
          status: "completed",
          items: [{ id: `item-${index}`, type: "agentMessage", text: hugeText }],
        })),
      }),
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
    });
    sync.claimThread({ threadId, turnStartParams: { input: [] } });
    await waitFor(() => transport.broadcasts.some(row =>
      row.method === "thread-stream-state-changed"
      && (row.params.change as { type?: string } | undefined)?.type === "snapshot",
    ), 1_000);
    const snapshot = transport.broadcasts.find(row =>
      row.method === "thread-stream-state-changed"
      && (row.params.change as { type?: string } | undefined)?.type === "snapshot");
    const envelope: DesktopIpcEnvelope = {
      type: "broadcast",
      method: snapshot!.method,
      params: snapshot!.params,
    };
    expect(() => encodeDesktopIpcFrame(envelope)).not.toThrow();
    const wire = encodeDesktopIpcFrame(envelope);
    expect(wire.byteLength).toBeLessThan(4 * 1024 * 1024);
    const state = (snapshot!.params.change as { conversationState: Record<string, unknown> }).conversationState;
    expect(Array.isArray(state.turns)).toBe(true);
    expect((state.historyPage as Record<string, unknown>).hasOlder).toBe(true);
    sync.stop();
  });

  test("serves bounded older pages and content chunks from the local owner", async () => {
    const transport = new FakeLiveTransport();
    const threadId = "local-page-owner-thread";
    const huge = "q".repeat(400_000);
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      snapshotDebounceMs: 0,
      readThread: async () => null,
      readThreadPage: async id => ({
        id,
        hostId: "local",
        updatedAt: 1,
        turns: Array.from({ length: 12 }, (_, index) => ({
          id: `turn-${index}`,
          status: "completed",
          items: [{ id: `item-${index}`, type: "agentMessage", text: index === 11 ? huge : `text-${index}` }],
        })),
        requests: [],
      }),
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
    });
    sync.claimThread({ threadId, turnStartParams: { input: [] } });
    await Bun.sleep(25);
    const recent = await transport.request("thread-follower-load-history-page", {
      hostId: "local",
      conversationId: threadId,
      direction: "recent",
      pageToken: null,
    }) as Record<string, unknown>;
    const state = recent.conversationState as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(state), "utf8")).toBeLessThan(3 * 1024 * 1024);
    const pageInfo = state.historyPage as Record<string, unknown>;
    expect(pageInfo.hasOlder).toBe(true);
    expect(pageInfo.olderPageToken).toBeString();
    const older = await transport.request("thread-follower-load-history-page", {
      hostId: "local",
      conversationId: threadId,
      direction: "older",
      pageToken: pageInfo.olderPageToken,
    }) as Record<string, unknown>;
    expect((older.conversationState as Record<string, unknown>).turns).toBeArray();
    const allText = JSON.stringify(state);
    const handleMatch = allText.match(/desktop_content_v1_[a-f0-9]+/);
    expect(handleMatch).not.toBeNull();
    const handle = handleMatch![0]!;
    const sourceRevision = String(pageInfo.sourceRevision);
    const chunk = await transport.request("thread-follower-read-content-chunk", {
      hostId: "local",
      conversationId: threadId,
      handle,
      sourceRevision,
      offset: 0,
    }) as Record<string, unknown>;
    expect(chunk.kind).toBe("chunk");
    expect(Number(chunk.chunkByteLength)).toBeLessThanOrEqual(1024 * 1024);
    sync.stop();
  });

  test("falls back to bounded thread/turns/list reads when an older Desktop lacks page methods", async () => {
    const transport = new TargetedLiveTransport();
    const threadId = "legacy-page-method-thread";
    const owner = "legacy-desktop-owner";
    let pageReads = 0;
    transport.requestOverride = async method => {
      if (method === "thread-follower-load-history-page") throw new Error("unknown method: thread-follower-load-history-page");
      throw new Error(`unexpected Desktop method ${method}`);
    };
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      readThread: async () => { throw new Error("unsafe full thread/read fallback"); },
      readThreadPage: async id => {
        pageReads += 1;
        return {
          id,
          hostId: "local",
          updatedAt: 1,
          turns: Array.from({ length: 20 }, (_, index) => ({
            id: `turn-${index}`,
            status: "completed",
            items: [{ id: `item-${index}`, type: "agentMessage", text: `bounded-${index}` }],
          })),
          requests: [],
        };
      },
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
    });
    transport.handlers?.onBroadcast({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: owner,
      params: {
        conversationId: threadId,
        change: { type: "snapshot", revision: 1, conversationState: { id: threadId, turns: [], requests: [] } },
      },
    });

    const state = await sync.readFollowerThreadState(threadId, { fresh: true });
    expect(state?.turns).toHaveLength(10);
    expect(pageReads).toBe(1);
    // Capability is cached for this connection; a second read must not send
    // another unsupported private IPC request.
    expect(await sync.readFollowerThreadState(threadId)).toMatchObject({ id: threadId });
    expect(transport.requests.filter(row => row.method === "thread-follower-load-history-page")).toHaveLength(1);
    expect(await sync.readFollowerHistoryPage?.(threadId, { direction: "recent" })).toMatchObject({ id: threadId });
    sync.stop();
  });

  test("bounds a legacy inbound Desktop snapshot before retaining it", async () => {
    const transport = new FakeLiveTransport();
    const threadId = "inbound-large-snapshot-thread";
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      readThread: async () => null,
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
    });
    const huge = "h".repeat(5 * 1024 * 1024);
    transport.requestOverride = async () => {
      transport.handlers?.onBroadcast({
        type: "broadcast",
        method: "thread-stream-state-changed",
        sourceClientId: "desktop-owner-large",
        params: {
          conversationId: threadId,
          change: {
            type: "snapshot",
            revision: 1,
            conversationState: {
              id: threadId,
              turns: [{ id: "turn-1", status: "completed", items: [{ id: "item-1", text: huge }] }],
              requests: [],
            },
          },
        },
      });
      return { revision: 1 };
    };
    const state = await sync.readFollowerThreadState(threadId);
    expect(state).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(state), "utf8")).toBeLessThan(3 * 1024 * 1024);
    expect(JSON.stringify(state)).not.toContain(huge);
    sync.stop();
  });

  test("sanitizes Windows owner snapshots and patches without shifting item indexes", async () => {
    const transport = new FakeLiveTransport();
    const threadId = "windows-private-transcript-thread";
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      readThread: async () => null,
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
    });
    transport.broadcast({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "windows-desktop-owner",
      params: {
        conversationId: threadId,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: {
            id: threadId,
            turns: [{
              id: "turn-1",
              status: "interrupted",
              params: {
                threadId,
                input: [{
                  text: "<skills_instructions>private turn input</skills_instructions>",
                }, {
                  type: "text",
                  text: "Original prompt",
                }],
              },
              items: [{
                id: "plain-developer-context",
                type: "message",
                role: "developer",
                content: [{
                  type: "text",
                  text: "# AGENTS.md\nPrivate instructions and MCP tool catalog",
                }],
              }, {
                id: "typed-system-context",
                type: "systemMessage",
                content: [{
                  type: "text",
                  text: "Plain system context without a protocol wrapper",
                }],
              }, {
                id: "private-context",
                type: "userMessage",
                content: [{ type: "text", text: "<skills_instructions>private tools</skills_instructions>" }],
              }, {
                id: "typeless-private-context",
                type: "userMessage",
                content: [{ text: "<app-context>private app state</app-context>" }],
              }, {
                id: "public-prompt",
                type: "userMessage",
                text: "<plugins_instructions>private duplicate context</plugins_instructions>",
                content: [{
                  type: "text",
                  text: "<environment_context>private path</environment_context>",
                }, {
                  type: "text",
                  text: "Original prompt",
                }, {
                  type: "localImage",
                  path: "C:\\Users\\Example\\prompt.png",
                }],
              }, {
                id: "headed-project-instructions",
                type: "userMessage",
                content: [{ type: "text", text: "# AGENTS.md instructions for C:\\Users\\Example\\project\r\n<INSTRUCTIONS>private project instructions</INSTRUCTIONS>" }],
              }, {
                id: "raw-stop-message",
                type: "agentMessage",
                text: "<turn_aborted>The previous turn was interrupted.</turn_aborted>",
              }],
            }],
            requests: [],
          },
        },
      },
    });

    const snapshot = await sync.readFollowerThreadState(threadId);
    const snapshotTurn = (snapshot!.turns as Array<Record<string, unknown>>)[0]!;
    const snapshotItems = snapshotTurn.items as Array<Record<string, unknown>>;
    expect(snapshotItems).toEqual([expect.objectContaining({
      id: "public-prompt",
      content: [
        { type: "text", text: "Original prompt" },
        { type: "localImage", path: "C:\\Users\\Example\\prompt.png" },
      ],
    })]);
    expect((snapshotTurn.params as Record<string, unknown>).input).toEqual([
      { type: "text", text: "Original prompt" },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("AGENTS.md");
    expect(JSON.stringify(snapshot)).not.toContain("MCP tool catalog");
    expect(JSON.stringify(snapshot)).not.toContain("private turn input");
    expect(JSON.stringify(snapshot)).not.toContain("private tools");
    expect(JSON.stringify(snapshot)).not.toContain("private app state");
    expect(JSON.stringify(snapshot)).not.toContain("private duplicate context");
    expect(JSON.stringify(snapshot)).not.toContain("private path");
    expect(JSON.stringify(snapshot)).not.toContain("turn_aborted");

    // Desktop patches are indexed against its original unsanitized arrays. The
    // private rows and turn-input entries remain internal placeholders until
    // these patches are applied, so Desktop's indexes still target the real
    // prompt in both arrays.
    transport.broadcast({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "windows-desktop-owner",
      params: {
        conversationId: threadId,
        change: {
          type: "patches",
          baseRevision: 1,
          revision: 2,
          patches: [{
            op: "replace",
            path: ["turns", 0, "items", 4, "content", 0, "text"],
            value: "<environment_context>new private path</environment_context>",
          }, {
            op: "replace",
            path: ["turns", 0, "items", 4, "content", 1, "text"],
            value: "Updated prompt",
          }, {
            op: "replace",
            path: ["turns", 0, "params", "input", 1, "text"],
            value: "Updated prompt",
          }],
        },
      },
    });

    const patched = await sync.readFollowerThreadState(threadId);
    const patchedTurn = (patched!.turns as Array<Record<string, unknown>>)[0]!;
    const patchedItems = patchedTurn.items as Array<Record<string, unknown>>;
    expect(patchedItems).toHaveLength(1);
    expect(patchedItems[0]).toMatchObject({
      id: "public-prompt",
      content: [
        { type: "text", text: "Updated prompt" },
        { type: "localImage", path: "C:\\Users\\Example\\prompt.png" },
      ],
    });
    expect((patchedTurn.params as Record<string, unknown>).input).toEqual([
      { type: "text", text: "Updated prompt" },
    ]);
    expect(JSON.stringify(patched)).not.toContain("new private path");

    // A Desktop renderer may publish an intermediate patch before the closing
    // private tag arrives. Keep the original placeholder (and therefore the
    // owner's array indexes) without exposing that partial bootstrap text.
    transport.broadcast({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "windows-desktop-owner",
      params: {
        conversationId: threadId,
        change: {
          type: "patches",
          baseRevision: 2,
          revision: 3,
          patches: [{
            op: "replace",
            path: ["turns", 0, "items", 2, "content", 0, "text"],
            value: "<skills_instructions>private tools still arriving",
          }, {
            op: "replace",
            path: ["turns", 0, "params", "input", 0, "text"],
            value: "<skills_instructions>private input still arriving",
          }],
        },
      },
    });

    const partial = await sync.readFollowerThreadState(threadId);
    const partialTurn = (partial!.turns as Array<Record<string, unknown>>)[0]!;
    expect((partialTurn.items as Array<Record<string, unknown>>).map(item => item.id)).toEqual([
      "public-prompt",
    ]);
    expect((partialTurn.params as Record<string, unknown>).input).toEqual([
      { type: "text", text: "Updated prompt" },
    ]);
    expect(JSON.stringify(partial)).not.toContain("still arriving");
    sync.stop();
  });

  test("fails closed after all targeted retries and blocks local claims until explicit release", async () => {
    const transport = new TargetedLiveTransport();
    const threadId = "owner-fail-closed-thread";
    transport.requestOverride = async (_method, _params, options) => {
      // Owner discovery is deliberately untargeted and read-only. Mutations
      // must still address the exact renderer that owns this task.
      if (_method !== DESKTOP_IPC_OWNER_DISCOVERY_METHOD) {
        expect(options?.targetClientId).toBe("desktop-owner");
      }
      throw new Error("no-client-found");
    };
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      ownerReacquireTimeoutMs: 20,
      readThread: async () => null,
      sendCodexRequest: async () => { throw new Error("local writer must not be used"); },
      respondToCodexRequest: () => undefined,
    });
    transport.handlers?.onBroadcast({
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "desktop-owner",
      params: {
        conversationId: threadId,
        change: { type: "snapshot", revision: 1, conversationState: { id: threadId, turns: [], requests: [] } },
      },
    });
    let ownerError: unknown;
    try {
      await sync.requestFollowerAction("thread-follower-start-turn", {
        conversationId: threadId,
        turnStart: { request: { threadId, input: [] }, context: { inheritThreadSettings: true } },
      });
    } catch (error) { ownerError = error; }
    expect(ownerError).toBeInstanceOf(Error);
    expect((ownerError as Error).message).toContain("still owns task");
    expect(sync.threadOwnership(threadId).state).toBe("desktop-owned");
    expect(() => sync.claimThread({ threadId, turnStartParams: { threadId, input: [] } }))
      .toThrow("explicit owner release");
    sync.releaseDesktopOwnership(threadId);
    expect(sync.threadOwnership(threadId).state).toBe("unknown");
    sync.claimThread({ threadId, turnStartParams: { threadId, input: [] } });
    expect(sync.threadOwnership(threadId).state).toBe("local-owned");
    sync.stop();
  });

  test("routes follower rollback through the owning Codex connection and replaces removed turns", async () => {
    const transport = new FakeLiveTransport();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const threadId = "019fff9d-2b6b-7282-9c2e-cc519d73135b";
    const rolledBackThread = {
      id: threadId,
      turns: [{
        id: "turn-retained",
        status: "completed",
        items: [{ id: "answer-retained", type: "agentMessage", text: "Retained" }],
      }],
    };
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      readThread: async () => rolledBackThread,
      sendCodexRequest: async (method, params) => {
        requests.push({ method, params });
        return { thread: rolledBackThread };
      },
      respondToCodexRequest: () => undefined,
    });
    sync.claimThread({
      threadId,
      turnStartParams: { input: [{ type: "text", text: "Pending replacement" }] },
    });

    await transport.request("thread-follower-rollback-thread", {
      conversationId: threadId,
      numTurns: 2,
    });

    expect(requests).toContainEqual({
      method: "thread/rollback",
      params: { threadId, numTurns: 2 },
    });
    // The owning bridge must replace the open Desktop task before it
    // acknowledges rollback; waiting for a later history reload leaves the
    // original and edited prompts visible together.
    const latestSnapshot = [...transport.broadcasts].reverse().find(row =>
      (row.params.change as { type?: string } | undefined)?.type === "snapshot");
    expect(latestSnapshot).toBeDefined();
    const state = (latestSnapshot!.params.change as {
      conversationState: { turns: Array<{ id: string }> };
    }).conversationState;
    expect(state.turns.map(turn => turn.id)).toEqual(["turn-retained"]);
    sync.stop();
  });

  test("persists follower model and reasoning changes through Codex thread settings", async () => {
    const transport = new FakeLiveTransport();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const threadId = "019fff9d-2b6b-7282-9c2e-cc519d73135c";
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      readThread: async () => ({ id: threadId, turns: [] }),
      sendCodexRequest: async (method, params) => {
        requests.push({ method, params });
        return {};
      },
      respondToCodexRequest: () => undefined,
    });
    sync.claimThread({ threadId, turnStartParams: { threadId, input: [] } });

    await transport.request("thread-follower-update-thread-settings", {
      conversationId: threadId,
      threadSettings: {
        model: "cursor/gpt-5.6-sol",
        effort: "xhigh",
        serviceTier: "fast",
      },
    });

    expect(requests).toContainEqual({
      method: "thread/settings/update",
      params: {
        threadId,
        model: "cursor/gpt-5.6-sol",
        effort: "xhigh",
        serviceTier: "fast",
      },
    });
    sync.stop();
  });

  test("reads an owner snapshot so Android can answer with the real pending request id", async () => {
    const transport = new FakeLiveTransport();
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      readThread: async threadId => ({ id: threadId, turns: [] }),
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
    });
    const conversationId = "019fff9d-2b6b-7282-9c2e-cc519d73135b";
    transport.requestOverride = async (method, params) => {
      expect(method).toBe("thread-follower-load-history-page");
      expect(params).toMatchObject({
        hostId: "local",
        conversationId,
        direction: "recent",
        pageToken: null,
      });
      transport.broadcast({
        type: "broadcast",
        method: "thread-stream-state-changed",
        params: {
          conversationId,
          change: {
            type: "snapshot",
            revision: 4,
            conversationState: {
              id: conversationId,
              requests: [{
                id: 42,
                method: "item/tool/requestUserInput",
                params: { itemId: "input-item-1", questions: [] },
              }],
            },
          },
        },
      });
      return { revision: 4 };
    };
    sync.start();

    expect(await sync.readFollowerThreadState(conversationId)).toMatchObject({
      id: conversationId,
      requests: [{ id: 42, method: "item/tool/requestUserInput" }],
    });
    transport.requestOverride = async () => {
      throw new Error("cached follower state should not request history again");
    };
    expect(await sync.readFollowerThreadState(conversationId)).toMatchObject({
      id: conversationId,
      requests: [{ id: 42, method: "item/tool/requestUserInput" }],
    });
    transport.requestOverride = async (method, params) => {
      expect(method).toBe("thread-follower-load-history-page");
      expect(params).toMatchObject({
        hostId: "local",
        conversationId,
        direction: "recent",
        pageToken: null,
      });
      transport.broadcast({
        type: "broadcast",
        method: "thread-stream-state-changed",
        params: {
          conversationId,
          change: {
            type: "snapshot",
            revision: 5,
            conversationState: {
              id: conversationId,
              threadRuntimeStatus: { type: "idle", activeFlags: [] },
              turns: [],
              requests: [],
            },
          },
        },
      });
      return { revision: 5 };
    };
    expect(await sync.readFollowerThreadState(conversationId, { fresh: true })).toMatchObject({
      id: conversationId,
      threadRuntimeStatus: { type: "idle" },
      turns: [],
      requests: [],
    });
    expect(transport.broadcasts.filter(row =>
      row.method === "thread-stream-following-changed"
      && row.params.conversationId === conversationId,
    )).toHaveLength(0);
    sync.stop();
    expect(transport.broadcasts.filter(row =>
      row.method === "thread-stream-following-changed"
      && row.params.conversationId === conversationId,
    )).toHaveLength(0);
  });

  test("settles a follower-state timeout without waiting for the slower Desktop request", async () => {
    const transport = new FakeLiveTransport();
    let releaseRequest!: () => void;
    let requestStarted = false;
    let requestSettled = false;
    const heldRequest = new Promise<void>(resolve => { releaseRequest = resolve; });
    transport.requestOverride = async () => {
      requestStarted = true;
      await heldRequest;
      requestSettled = true;
      return { ok: true };
    };
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      followerStateTimeoutMs: 5,
      readThread: async () => null,
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
    });
    try {
      await expect(
        sync.readFollowerThreadState("019fff9d-2b6b-7282-9c2e-cc519d73135d"),
      ).rejects.toThrow("Codex Desktop did not publish the requested task state");
      expect(requestStarted).toBe(true);
      expect(requestSettled).toBe(false);
      expect(transport.connected).toBe(true);
      expect(transport.resets).toBe(0);
    } finally {
      releaseRequest();
      sync.stop();
    }
  });

  test("never advertises a locally owned task back to the same IPC client", async () => {
    const transport = new FakeLiveTransport();
    const threadId = "019fff9d-2b6b-7282-9c2e-cc519d73135e";
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      readThread: async id => ({ id, turns: [] }),
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
    });
    sync.claimThread({ threadId, turnStartParams: { threadId, input: [] } });
    expect(transport.handlers).not.toBeNull();

    const localRequest: DesktopIpcEnvelope = {
      type: "request",
      sourceClientId: transport.localClientId,
      method: "thread-follower-start-turn",
      params: { conversationId: threadId },
    };
    const externalRequest: DesktopIpcEnvelope = {
      ...localRequest,
      sourceClientId: "codex-desktop-client",
    };

    expect(transport.handlers!.canHandleRequest(localRequest)).toBe(false);
    expect(transport.handlers!.canHandleRequest(externalRequest)).toBe(true);
    sync.stop();
  });

  test("opens an idle Desktop-owned task as the owner before Android retries a response", async () => {
    const transport = new FakeLiveTransport();
    const opened: string[] = [];
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      openUrl: async url => { opened.push(url); },
      readThread: async () => null,
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
    });

    await sync.activateFollowerThread("019fff9d-2b6b-7282-9c2e-cc519d73135b");
    await sync.activateFollowerThread("019fff9d-2b6b-7282-9c2e-cc519d73135b");

    expect(transport.starts).toBe(2);
    expect(opened).toHaveLength(2);
    expect(opened[0]).toMatch(
      /^codex:\/\/threads\/019fff9d-2b6b-7282-9c2e-cc519d73135b\?opencodex-reactivate=[0-9a-f-]+$/u,
    );
    expect(opened[1]).toMatch(
      /^codex:\/\/threads\/019fff9d-2b6b-7282-9c2e-cc519d73135b\?opencodex-reactivate=[0-9a-f-]+$/u,
    );
    expect(opened[1]).not.toBe(opened[0]);
  });

  test("resolves the real Windows pipe and both macOS and Linux socket locations", () => {
    expect(desktopIpcSocketPaths("win32", {})).toEqual(["\\\\.\\pipe\\codex-ipc"]);
    const macPaths = desktopIpcSocketPaths("darwin", { CODEX_HOME: "/Users/test/custom-codex" });
    expect(macPaths[0]).toBe("/Users/test/custom-codex/ipc/ipc.sock");
    expect(macPaths[1]).toContain("codex-ipc");
    expect(macPaths[1]).toEndWith(".sock");
    const linuxPaths = desktopIpcSocketPaths("linux", { CODEX_HOME: "/home/test/custom-codex" });
    expect(linuxPaths[0]).toBe("/home/test/custom-codex/ipc/ipc.sock");
    expect(linuxPaths[1]).toContain("codex-ipc");
    expect(linuxPaths[1]).toEndWith(".sock");
    expect(desktopIpcSocketPaths("freebsd", {})).toEqual([]);
  });

  test("reads split and coalesced frames without losing their boundaries", () => {
    const received: DesktopIpcEnvelope[] = [];
    const reader = new DesktopIpcFrameReader(value => received.push(value));
    const first = encodeDesktopIpcFrame({ type: "broadcast", method: "one" });
    const second = encodeDesktopIpcFrame({ type: "broadcast", method: "two" });
    reader.push(first.subarray(0, 2));
    reader.push(Buffer.concat([first.subarray(2), second]));
    expect(received.map(value => value.method)).toEqual(["one", "two"]);
  });

  test("rejects malformed and oversized frames instead of parsing later bytes on a poisoned stream", () => {
    const received: DesktopIpcEnvelope[] = [];
    const corruptions: string[] = [];
    const reader = new DesktopIpcFrameReader(
      value => received.push(value),
      error => corruptions.push(error.message),
    );
    const malformedBody = Buffer.from("{no", "utf8");
    const malformedHeader = Buffer.alloc(4);
    malformedHeader.writeUInt32LE(malformedBody.length);
    reader.push(Buffer.concat([malformedHeader, malformedBody, encodeDesktopIpcFrame({ method: "three" })]));
    expect(received).toEqual([]);
    expect(corruptions).toEqual(["Codex Desktop IPC received a malformed frame"]);

    const overflow = Buffer.alloc(4);
    overflow.writeUInt32LE(64 * 1024 * 1024 + 1);
    reader.push(overflow);
    expect(corruptions).toEqual([
      "Codex Desktop IPC received a malformed frame",
      "Codex Desktop IPC frame length exceeded the 64 MB limit",
    ]);
  });

  test("fails pending requests immediately on frame corruption and reconnects cleanly", async () => {
    const sockets: FakeSocket[] = [];
    const warnings: string[] = [];
    const transport = new DesktopIpcTransport({
      paths: () => ["test-pipe"],
      connect: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        socket.onWrite = envelope => {
          if (envelope.method !== "initialize") return;
          queueMicrotask(() => socket.emit("data", encodeDesktopIpcFrame({
            type: "response",
            requestId: envelope.requestId,
            resultType: "success",
            result: { clientId: `desktop-${sockets.length}` },
          })));
        };
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as Socket;
      },
      now: () => Date.now(),
      reconnectMs: 1,
      warn: message => warnings.push(message),
    });
    transport.setHandlers({
      onConnected: () => undefined,
      onBroadcast: () => undefined,
      canHandleRequest: () => false,
      handleRequest: async () => null,
    });
    transport.start();
    await waitFor(() => transport.connected);

    const pending = transport.request("thread-follower-load-complete-history", {
      conversationId: "corrupt-thread",
    });
    const overflow = Buffer.alloc(4);
    overflow.writeUInt32LE(64 * 1024 * 1024 + 1);
    sockets[0]!.emit("data", overflow);

    await expect(pending).rejects.toThrow(
      "Codex Desktop IPC frame length exceeded the 64 MB limit",
    );
    await waitFor(() => sockets.length >= 2 && transport.connected);
    expect(warnings).toContain(
      "Codex Desktop IPC frame length exceeded the 64 MB limit",
    );
    transport.stop();
  });

  test("increments connection generations and ignores callbacks from replaced sockets", async () => {
    const sockets: FakeSocket[] = [];
    const broadcasts: string[] = [];
    const transport = new DesktopIpcTransport({
      paths: () => ["test-pipe"],
      connect: () => {
        const socket = new FakeSocket();
        const connectionNumber = sockets.push(socket);
        socket.onWrite = envelope => {
          if (envelope.method !== "initialize") return;
          queueMicrotask(() => socket.emit("data", encodeDesktopIpcFrame({
            type: "response",
            requestId: envelope.requestId,
            resultType: "success",
            result: { clientId: `local-client-${connectionNumber}` },
          })));
        };
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as Socket;
      },
      now: () => Date.now(),
      reconnectMs: 1,
      warn: () => undefined,
    });
    transport.setHandlers({
      onConnected: () => undefined,
      onBroadcast: envelope => broadcasts.push(String(envelope.method ?? "")),
      canHandleRequest: () => false,
      handleRequest: async () => null,
    });
    transport.start();
    await waitFor(() => transport.connected);
    const firstSocket = sockets[0]!;
    const firstGeneration = transport.generation;
    expect(transport.localClientId).toBe("local-client-1");

    firstSocket.destroy();
    await waitFor(() => sockets.length === 2 && transport.connected);
    expect(transport.generation).toBeGreaterThan(firstGeneration);
    expect(transport.localClientId).toBe("local-client-2");

    firstSocket.emit("data", encodeDesktopIpcFrame({
      type: "broadcast",
      method: "stale-generation",
    }));
    firstSocket.emit("close");
    firstSocket.emit("error", new Error("late stale error"));
    await settle();
    expect(transport.connected).toBe(true);
    expect(transport.localClientId).toBe("local-client-2");
    expect(broadcasts).toEqual([]);

    sockets[1]!.emit("data", encodeDesktopIpcFrame({
      type: "broadcast",
      method: "current-generation",
    }));
    await settle();
    expect(broadcasts).toEqual(["current-generation"]);
    transport.stop();
  });

  test("reconnects when IPC initialization times out", async () => {
    const sockets: FakeSocket[] = [];
    const transport = new DesktopIpcTransport({
      paths: () => ["test-pipe"],
      connect: () => {
        const socket = new FakeSocket();
        const connectionNumber = sockets.push(socket);
        socket.onWrite = envelope => {
          if (envelope.method !== "initialize" || connectionNumber === 1) return;
          queueMicrotask(() => socket.emit("data", encodeDesktopIpcFrame({
            type: "response",
            requestId: envelope.requestId,
            resultType: "success",
            result: { clientId: `local-client-${connectionNumber}` },
          })));
        };
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as Socket;
      },
      now: () => Date.now(),
      reconnectMs: 1,
      requestTimeoutMs: 10,
      warn: () => undefined,
    });
    transport.setHandlers({
      onConnected: () => undefined,
      onBroadcast: () => undefined,
      canHandleRequest: () => false,
      handleRequest: async () => null,
    });

    transport.start();
    await waitFor(() => sockets.length >= 2 && transport.connected);

    expect(sockets[0]!.destroyed).toBe(true);
    expect(transport.localClientId).toBe("local-client-2");
    expect(transport.generation).toBe(2);
    transport.stop();
  });

  test("initializes against the Codex Desktop bus with the exact framed envelope", async () => {
    const socket = new FakeSocket();
    const transport = new DesktopIpcTransport({
      paths: () => ["test-pipe"],
      connect: () => {
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as Socket;
      },
      now: () => 123,
      reconnectMs: 60_000,
      warn: () => undefined,
    });
    let connected = false;
    transport.setHandlers({
      onConnected: () => { connected = true; },
      onBroadcast: () => undefined,
      canHandleRequest: () => false,
      handleRequest: async () => null,
    });
    socket.onWrite = envelope => {
      if (envelope.method !== "initialize") return;
      queueMicrotask(() => socket.emit("data", encodeDesktopIpcFrame({
        type: "response",
        requestId: envelope.requestId,
        resultType: "success",
        result: { clientId: "desktop-owner-test" },
      })));
    };
    transport.start();
    await settle();
    const envelope = JSON.parse(socket.writes[0]!.subarray(4).toString("utf8")) as DesktopIpcEnvelope;
    expect(envelope).toMatchObject({
      type: "request",
      sourceClientId: "initializing-client",
      version: 1,
      method: "initialize",
      params: { clientType: "opencodex-android-bridge" },
    });
    expect(connected).toBe(true);
    expect(transport.connected).toBe(true);
    transport.stop();
  });

  test("reports which Desktop IPC client settled a follower request without exposing its payload", async () => {
    const socket = new FakeSocket();
    const settled: DesktopIpcResponseSettled[] = [];
    const transport = new DesktopIpcTransport({
      paths: () => ["test-pipe"],
      connect: () => {
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as Socket;
      },
      now: () => 789,
      reconnectMs: 60_000,
      warn: () => undefined,
      onResponseSettled: response => settled.push(response),
    });
    transport.setHandlers({
      onConnected: () => undefined,
      onBroadcast: () => undefined,
      canHandleRequest: () => false,
      handleRequest: async () => null,
    });
    socket.onWrite = envelope => {
      if (envelope.type !== "request") return;
      queueMicrotask(() => socket.emit("data", encodeDesktopIpcFrame({
        type: "response",
        requestId: envelope.requestId,
        resultType: envelope.method === "initialize" ? "success" : "error",
        handledByClientId: envelope.method === "initialize"
          ? "desktop-ipc-broker"
          : "stale-opencodex-owner",
        ...(envelope.method === "initialize"
          ? { result: { clientId: "local-opencodex-client" } }
          : { error: "thread thread-diagnostic already has an active writer" }),
      })));
    };
    transport.start();
    await settle();

    await expect(transport.request("thread-follower-start-turn", {
      conversationId: "thread-diagnostic",
      senderRequestId: "message-diagnostic",
      turnStart: {
        request: {
          threadId: "thread-diagnostic",
          clientUserMessageId: "message-diagnostic",
          input: [{ type: "text", text: "sensitive prompt must not enter diagnostics" }],
        },
      },
    }, { targetClientId: "stale-opencodex-owner" })).rejects.toThrow("already has an active writer");

    expect(settled.find(response => response.method === "thread-follower-start-turn")).toEqual({
      requestId: expect.any(String),
      method: "thread-follower-start-turn",
      threadId: "thread-diagnostic",
      commandId: "message-diagnostic",
      localClientId: "local-opencodex-client",
      handledByClientId: "stale-opencodex-owner",
      targetClientId: "stale-opencodex-owner",
      resultType: "error",
    });
    expect(JSON.stringify(settled)).not.toContain("sensitive prompt");
    transport.stop();
  });

  test("sends the Codex Desktop atomic edit action with protocol version 2", async () => {
    const socket = new FakeSocket();
    const transport = new DesktopIpcTransport({
      paths: () => ["test-pipe"],
      connect: () => {
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as Socket;
      },
      now: () => 456,
      reconnectMs: 60_000,
      warn: () => undefined,
    });
    transport.setHandlers({
      onConnected: () => undefined,
      onBroadcast: () => undefined,
      canHandleRequest: () => false,
      handleRequest: async () => null,
    });
    socket.onWrite = envelope => {
      if (envelope.type !== "request") return;
      queueMicrotask(() => socket.emit("data", encodeDesktopIpcFrame({
        type: "response",
        requestId: envelope.requestId,
        resultType: "success",
        result: envelope.method === "initialize"
          ? { clientId: "atomic-edit-test" }
          : { ok: true },
      })));
    };
    transport.start();
    await settle();

    await transport.request("thread-follower-edit-last-user-turn", {
      conversationId: "thread-edit",
      turnId: "turn-original",
      message: "Edited prompt",
      agentMode: "full-access",
      shouldSendPermissionOverrides: true,
      serviceTier: null,
    });

    const editEnvelope = socket.writes
      .map(frame => JSON.parse(frame.subarray(4).toString("utf8")) as DesktopIpcEnvelope)
      .find(envelope => envelope.method === "thread-follower-edit-last-user-turn");
    expect(editEnvelope).toMatchObject({
      type: "request",
      version: 2,
      method: "thread-follower-edit-last-user-turn",
      params: {
        conversationId: "thread-edit",
        turnId: "turn-original",
        message: "Edited prompt",
      },
    });
    transport.stop();
  });

  test("notifies live sync when the Desktop IPC connection closes", async () => {
    const socket = new FakeSocket();
    const transport = new DesktopIpcTransport({
      paths: () => ["test-pipe"],
      connect: () => {
        queueMicrotask(() => socket.emit("connect"));
        return socket as unknown as Socket;
      },
      now: () => 123,
      reconnectMs: 60_000,
      warn: () => undefined,
    });
    let disconnects = 0;
    transport.setHandlers({
      onConnected: () => undefined,
      onDisconnected: () => { disconnects += 1; },
      onBroadcast: () => undefined,
      canHandleRequest: () => false,
      handleRequest: async () => null,
    });
    socket.onWrite = envelope => {
      if (envelope.method !== "initialize") return;
      queueMicrotask(() => socket.emit("data", encodeDesktopIpcFrame({
        type: "response",
        requestId: envelope.requestId,
        resultType: "success",
        result: { clientId: "disconnect-test" },
      })));
    };
    transport.start();
    await settle();
    socket.destroy();
    await settle();
    expect(disconnects).toBe(1);
    transport.stop();
  });

  test("builds bounded message and array patches without replacing an unchanged state", () => {
    expect(buildDesktopStatePatches({ rows: ["a"] }, { rows: ["a"] })).toEqual([]);
    expect(buildDesktopStatePatches(
      { rows: [{ id: "one", text: "a" }] },
      { rows: [{ id: "one", text: "ab" }, { id: "two" }] },
    )).toEqual([
      { op: "replace", path: ["rows", 0, "text"], value: "ab" },
      { op: "add", path: ["rows", 1], value: { id: "two" } },
    ]);
  });

  test("waits for complete history before publishing the first Desktop snapshot", async () => {
    const transport = new FakeLiveTransport();
    let finishRead!: (value: Record<string, unknown>) => void;
    const read = new Promise<Record<string, unknown>>(resolve => { finishRead = resolve; });
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      snapshotDebounceMs: 0,
      followConfirmMs: 60_000,
      readThread: async () => await read,
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
      openUrl: async () => undefined,
    });

    sync.claimThread({
      threadId: "hydrate-first-1",
      turnStartParams: { input: [{ type: "text", text: "New prompt" }] },
    });
    await settle();
    expect(transport.broadcasts.some(row =>
      (row.params.change as { type?: string } | undefined)?.type === "snapshot"
    )).toBe(false);

    finishRead({
      id: "hydrate-first-1",
      turns: [{ id: "old-turn", status: "completed", items: [{ id: "old-answer", type: "agentMessage", text: "History" }] }],
    });
    await settle();
    const snapshot = transport.broadcasts.find(row =>
      (row.params.change as { type?: string } | undefined)?.type === "snapshot"
    )!;
    const state = (snapshot.params.change as { conversationState: Record<string, unknown> }).conversationState;
    expect((state.turns as Array<{ id: string }>).map(turn => turn.id)).toContain("old-turn");
    sync.stop();
  });

  test("retries initial history hydration before exposing or abandoning an owner stream", async () => {
    const transport = new FakeLiveTransport();
    let reads = 0;
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      snapshotDebounceMs: 0,
      initialHistoryRetryMs: 1,
      initialHistoryMaxAttempts: 3,
      followConfirmMs: 60_000,
      readThread: async threadId => {
        reads += 1;
        return reads === 1 ? null : { id: threadId, turns: [] };
      },
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
      openUrl: async () => undefined,
    });

    sync.claimThread({ threadId: "hydrate-retry-1", turnStartParams: { input: [] } });
    await waitFor(() => reads >= 2 && transport.broadcasts.some(row =>
      (row.params.change as { type?: string } | undefined)?.type === "snapshot"
    ));
    expect(reads).toBe(2);
    expect(sync.isThreadOwned("hydrate-retry-1")).toBe(true);
    expect(transport.broadcasts.some(row =>
      (row.params.change as { type?: string } | undefined)?.type === "snapshot"
    )).toBe(true);
    sync.stop();
  });

  test("reconfirms followers and sends a full owner baseline after IPC reconnect", async () => {
    const transport = new FakeLiveTransport();
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      snapshotDebounceMs: 0,
      followConfirmMs: 60_000,
      readThread: async threadId => ({ id: threadId, turns: [] }),
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
      openUrl: async () => undefined,
    });
    sync.claimThread({ threadId: "reconnect-owner-1", turnStartParams: { input: [] } });
    await settle();
    transport.broadcast({
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: "desktop-window",
      params: { conversationId: "reconnect-owner-1", following: true },
    });
    transport.broadcasts = [];

    transport.disconnect();
    transport.connect();

    expect(transport.broadcasts.some(row =>
      row.method === "thread-stream-following-status-requested"
      && row.params.conversationId === "reconnect-owner-1"
    )).toBe(true);
    expect(transport.broadcasts.some(row =>
      (row.params.change as { type?: string } | undefined)?.type === "snapshot"
    )).toBe(true);
    sync.stop();
  });

  test("recovers a missing follower patch baseline and replays the queued patch", async () => {
    const transport = new FakeLiveTransport();
    const conversationId = "patch-recovery-1";
    let requests = 0;
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      followerBaselineRetryMs: 1,
      readThread: async () => null,
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
    });
    transport.requestOverride = async method => {
      expect(method).toBe("thread-follower-load-history-page");
      requests += 1;
      if (requests === 1) {
        transport.broadcast({
          type: "broadcast",
          method: "thread-stream-state-changed",
          params: {
            conversationId,
            change: {
              type: "patches",
              baseRevision: 1,
              revision: 2,
              patches: [{ op: "replace", path: ["title"], value: "Patched title" }],
            },
          },
        });
      } else {
        transport.broadcast({
          type: "broadcast",
          method: "thread-stream-state-changed",
          params: {
            conversationId,
            change: {
              type: "snapshot",
              revision: 1,
              conversationState: { id: conversationId, title: "Baseline", turns: [], requests: [] },
            },
          },
        });
      }
      return { revision: requests === 1 ? 2 : 1 };
    };

    expect(await sync.readFollowerThreadState(conversationId)).toMatchObject({
      id: conversationId,
      title: "Patched title",
    });
    expect(requests).toBe(2);
    sync.stop();
  });

  test("yields idle ownership to a peer snapshot but protects an active local turn", async () => {
    const transport = new FakeLiveTransport();
    const threadId = "peer-owner-1";
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      snapshotDebounceMs: 0,
      followConfirmMs: 60_000,
      readThread: async id => ({ id, turns: [] }),
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
      openUrl: async () => undefined,
    });
    sync.claimThread({ threadId, turnStartParams: { input: [{ type: "text", text: "Run" }] } });
    await settle();
    const peerIdleSnapshot: DesktopIpcEnvelope = {
      type: "broadcast",
      method: "thread-stream-state-changed",
      sourceClientId: "desktop-peer",
      params: {
        conversationId: threadId,
        change: { type: "snapshot", revision: 9, conversationState: { id: threadId, turns: [], requests: [] } },
      },
    };
    transport.broadcast(peerIdleSnapshot);
    expect(sync.isThreadOwned(threadId)).toBe(true);

    sync.observeCodexMessage({ method: "turn/started", params: { threadId, turn: { id: "real-turn", status: "inProgress", items: [] } } });
    sync.observeCodexMessage({ method: "turn/completed", params: { threadId, turn: { id: "real-turn", status: "completed", items: [] } } });
    transport.broadcast(peerIdleSnapshot);
    expect(sync.isThreadOwned(threadId)).toBe(false);
    sync.stop();
  });

  test("keeps a submitted server request pending until Codex confirms resolution", async () => {
    const transport = new FakeLiveTransport();
    const responses: Array<{ id: string | number; result: Record<string, unknown> }> = [];
    const threadId = "pending-resolution-1";
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      snapshotDebounceMs: 0,
      followConfirmMs: 60_000,
      readThread: async id => ({ id, turns: [] }),
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: (id, result) => responses.push({ id, result }),
      openUrl: async () => undefined,
    });
    sync.claimThread({ threadId, turnStartParams: { input: [] } });
    await settle();
    sync.observeCodexMessage({
      id: 77,
      method: "item/tool/requestUserInput",
      params: { threadId, itemId: "question-1", questions: [{ id: "choice" }] },
    });
    await transport.request("thread-follower-submit-user-input", {
      conversationId: threadId,
      requestId: "77",
      response: { answers: { choice: { answers: ["Alpha"] } } },
    });
    expect(responses[0]?.id).toBe(77);
    await transport.request("thread-follower-load-complete-history", { conversationId: threadId });
    let snapshot = [...transport.broadcasts].reverse().find(row =>
      (row.params.change as { type?: string } | undefined)?.type === "snapshot"
    )!;
    let state = (snapshot.params.change as { conversationState: Record<string, unknown> }).conversationState;
    expect(state.requests).toHaveLength(1);

    sync.observeCodexMessage({ method: "serverRequest/resolved", params: { threadId, requestId: 77 } });
    await transport.request("thread-follower-load-complete-history", { conversationId: threadId });
    snapshot = [...transport.broadcasts].reverse().find(row =>
      (row.params.change as { type?: string } | undefined)?.type === "snapshot"
    )!;
    state = (snapshot.params.change as { conversationState: Record<string, unknown> }).conversationState;
    expect(state.requests).toEqual([]);
    sync.stop();
  });

  test("promotes the optimistic turn id to the canonical Codex turn id", async () => {
    const transport = new FakeLiveTransport();
    const threadId = "turn-promotion-1";
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      snapshotDebounceMs: 0,
      followConfirmMs: 60_000,
      readThread: async id => ({ id, turns: [] }),
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
      openUrl: async () => undefined,
    });
    sync.claimThread({ threadId, turnStartParams: { input: [{ type: "text", text: "Canonical" }] } });
    await settle();
    sync.observeCodexMessage({
      method: "turn/started",
      params: { threadId, turn: { id: "turn-canonical", status: "inProgress", items: [] } },
    });
    await transport.request("thread-follower-load-complete-history", { conversationId: threadId });
    const snapshot = [...transport.broadcasts].reverse().find(row =>
      (row.params.change as { type?: string } | undefined)?.type === "snapshot"
    )!;
    const state = (snapshot.params.change as { conversationState: Record<string, unknown> }).conversationState;
    expect((state.turns as Array<{ id: string }>).map(turn => turn.id)).toEqual(["turn-canonical"]);
    sync.stop();
  });

  test("publishes terminal turn state to a mounted Desktop without a history refresh", async () => {
    const transport = new FakeLiveTransport();
    const threadId = "live-completion-1";
    let reads = 0;
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      snapshotDebounceMs: 0,
      followConfirmMs: 60_000,
      readThread: async id => {
        reads += 1;
        return { id, turns: [] };
      },
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
      openUrl: async () => undefined,
    });
    sync.claimThread({ threadId, turnStartParams: { input: [{ type: "text", text: "Complete" }] } });
    await settle();
    transport.broadcast({
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: "mounted-desktop",
      params: { conversationId: threadId, following: true },
    });
    transport.broadcasts = [];

    sync.observeCodexMessage({
      method: "turn/started",
      params: { threadId, turn: { id: "terminal-turn", status: "inProgress", items: [] } },
    });
    sync.observeCodexMessage({
      method: "item/completed",
      params: { threadId, turnId: "terminal-turn", item: { id: "final-answer", type: "agentMessage", text: "Done" } },
    });
    sync.observeCodexMessage({
      method: "turn/completed",
      params: { threadId, turn: { id: "terminal-turn", status: "completed", items: [] } },
    });
    await settle();

    expect(reads).toBe(1);
    const stateChange = [...transport.broadcasts].reverse().find(row => row.method === "thread-stream-state-changed");
    expect(stateChange?.params.change).toMatchObject({ type: "snapshot" });
    expect(JSON.stringify(stateChange?.params.change)).toContain("completed");
    expect(JSON.stringify(stateChange?.params.change)).toContain("Done");
    sync.stop();
  });

  test("claims an Android task, shows its prompt once, and streams ordered patches", async () => {
    const transport = new FakeLiveTransport();
    const opened: string[] = [];
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      snapshotDebounceMs: 0,
      followConfirmMs: 60_000,
      readThread: async threadId => ({ id: threadId, turns: [] }),
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
      openUrl: async url => { opened.push(url); },
      now: () => 1_000,
    });
    sync.start();
    sync.claimThread({
      threadId: "thread-android-1",
      cwd: "C:\\work",
      title: "Phone task",
      turnStartParams: {
        threadId: "thread-android-1",
        input: [{ type: "text", text: "Prompt from Android" }],
        model: "gpt-5.6-sol",
        effort: "high",
      },
    });
    await settle();
    const snapshot = transport.broadcasts.find(row =>
      (row.params.change as { type?: string } | undefined)?.type === "snapshot")!;
    const state = (snapshot.params.change as { conversationState: Record<string, unknown> }).conversationState;
    const turns = state.turns as Array<Record<string, unknown>>;
    expect((turns[0]!.params as Record<string, unknown>).input).toEqual([
      { type: "text", text: "Prompt from Android" },
    ]);
    expect(turns[0]!.items).toEqual([]);
    expect(state).toMatchObject({
      id: "thread-android-1",
      title: "Phone task",
      latestModel: "gpt-5.6-sol",
      latestReasoningEffort: "high",
    });
    expect(opened[0]).toStartWith("codex://threads/thread-android-1?opencodex-follow=");

    sync.observeCodexMessage({
      method: "turn/started",
      params: { threadId: "thread-android-1", turn: { id: "turn-1", status: "inProgress", items: [] } },
    });
    sync.observeCodexMessage({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-android-1", turnId: "turn-1", itemId: "answer-1", delta: "Hello" },
    });
    sync.observeCodexMessage({
      method: "item/started",
      params: {
        threadId: "thread-android-1",
        turnId: "turn-1",
        item: { id: "command-1", type: "commandExecution", command: "bun test", status: "inProgress" },
      },
    });
    sync.observeCodexMessage({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-android-1", turnId: "turn-1", itemId: "answer-1", delta: " world" },
    });
    await settle();
    const patchBroadcast = transport.broadcasts.at(-1)!;
    expect(patchBroadcast.params.change).toMatchObject({
      type: "patches",
      baseRevision: 1,
      revision: 2,
    });
    const serialized = JSON.stringify(patchBroadcast.params.change);
    expect(serialized).toContain("Hello world");
    const patches = (patchBroadcast.params.change as { patches: Array<{ value?: unknown }> }).patches;
    const insertedIds = patches.flatMap(patch => {
      const value = patch.value as { id?: unknown } | undefined;
      return typeof value?.id === "string" ? [value.id] : [];
    });
    expect(insertedIds).toEqual(["answer-1", "command-1"]);
    sync.stop();
  });

  test("reconciles an Android attachment prompt when Codex omits the echoed client id", async () => {
    const transport = new FakeLiveTransport();
    const threadId = "android-attachment-desktop-dedup";
    const clientUserMessageId = "msg-android-attachment";
    const prompt = "ATTACHMENT_DESKTOP_DEDUP";
    const imagePath = "/home/example/.opencodex/android-remote-files/client/turn/attachment.jpg";
    const serverUserItem = {
      id: "server-user-item",
      type: "userMessage",
      content: [
        { type: "text", text: prompt },
        { type: "text", text: `<image name=[Image #1] path="${imagePath}">` },
        { type: "text", text: "</image>" },
      ],
    };
    let reads = 0;
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      snapshotDebounceMs: 0,
      followConfirmMs: 60_000,
      readThread: async id => {
        reads += 1;
        return reads === 1
          ? { id, turns: [] }
          : {
              id,
              turns: [{
                id: "attachment-turn",
                status: "completed",
                items: [
                  serverUserItem,
                  { id: "attachment-answer", type: "agentMessage", text: "ATTACHMENT_OK" },
                ],
              }],
            };
      },
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
      openUrl: async () => undefined,
    });

    sync.claimThread({
      threadId,
      turnStartParams: {
        threadId,
        clientUserMessageId,
        input: [
          {
            type: "text",
            text: `${prompt}\n\nFiles uploaded from Android and staged on this PC:\n- ${imagePath}`,
          },
          { type: "image", url: "data:image/jpeg;base64,dGVzdA==" },
        ],
      },
    });
    await settle();
    sync.observeCodexMessage({
      method: "turn/started",
      params: { threadId, turn: { id: "attachment-turn", status: "inProgress", items: [] } },
    });
    sync.observeCodexMessage({
      method: "item/completed",
      params: { threadId, turnId: "attachment-turn", item: serverUserItem },
    });
    sync.observeCodexMessage({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: "attachment-turn",
          status: "completed",
          items: [
            serverUserItem,
            { id: "attachment-answer", type: "agentMessage", text: "ATTACHMENT_OK" },
          ],
        },
      },
    });
    await transport.request("thread-follower-load-complete-history", { conversationId: threadId });

    const snapshot = [...transport.broadcasts].reverse().find(row =>
      (row.params.change as { type?: string } | undefined)?.type === "snapshot"
    )!;
    const state = (snapshot.params.change as { conversationState: Record<string, unknown> }).conversationState;
    const turn = (state.turns as Array<Record<string, unknown>>)[0]!;
    expect(turn.params).toMatchObject({ clientUserMessageId });
    expect((turn.items as Array<{ type: string }>).map(item => item.type)).toEqual(["agentMessage"]);
    sync.stop();
  });

  test("stops follow retries after Desktop confirms the task", async () => {
    const transport = new FakeLiveTransport();
    const opened: string[] = [];
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      snapshotDebounceMs: 0,
      followConfirmMs: 10,
      followMaxAttempts: 3,
      readThread: async () => null,
      sendCodexRequest: async () => ({}),
      respondToCodexRequest: () => undefined,
      openUrl: async url => { opened.push(url); },
    });
    sync.claimThread({ threadId: "follow-1", turnStartParams: { input: [] } });
    transport.broadcast({
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: "desktop-window",
      params: { conversationId: "follow-1", following: true },
    });
    await Bun.sleep(35);
    expect(opened).toHaveLength(1);
    sync.stop();
  });

  test("routes Desktop Stop, history, and approval responses to the same Codex runtime", async () => {
    const transport = new FakeLiveTransport();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const responses: Array<{ id: string | number; result: Record<string, unknown> }> = [];
    const sync = new AndroidDesktopIpcLiveSync({
      transport,
      snapshotDebounceMs: 0,
      followConfirmMs: 60_000,
      readThread: async threadId => ({
        id: threadId,
        cwd: "C:\\work",
        turns: [{
          id: "turn-old",
          status: "completed",
          items: [
            { id: "user-old", type: "userMessage", content: [{ type: "text", text: "Old prompt" }] },
            { id: "answer-old", type: "agentMessage", text: "Old answer" },
          ],
        }],
      }),
      sendCodexRequest: async (method, params) => {
        requests.push({ method, params });
        return {};
      },
      respondToCodexRequest: (id, result) => responses.push({ id, result }),
      openUrl: async () => undefined,
    });
    sync.claimThread({ threadId: "controls-1", turnStartParams: { input: [{ type: "text", text: "New prompt" }] } });
    sync.observeCodexMessage({
      id: 77,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "controls-1", turnId: "turn-live", command: "bun test" },
    });
    await transport.request("thread-follower-steer-turn", {
      conversationId: "controls-1",
      clientUserMessageId: "android-steer-message",
      input: [{ type: "text", text: "Keep the current run focused on IPC." }],
      expectedTurnId: "turn-live",
    });
    await transport.request("thread-follower-interrupt-turn", {
      conversationId: "controls-1",
      turnId: "turn-live",
    });
    await transport.request("thread-follower-command-approval-decision", {
      conversationId: "controls-1",
      requestId: "77",
      decision: "accept",
    });
    const history = await transport.request("thread-follower-load-complete-history", {
      conversationId: "controls-1",
    });
    expect(requests).toContainEqual({
      method: "turn/steer",
      params: {
        threadId: "controls-1",
        clientUserMessageId: "android-steer-message",
        input: [{ type: "text", text: "Keep the current run focused on IPC." }],
        expectedTurnId: "turn-live",
      },
    });
    expect(requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "controls-1", turnId: "turn-live" },
    });
    expect(responses).toEqual([{ id: 77, result: { decision: "accept" } }]);
    expect(history).toMatchObject({ revision: expect.any(Number) });
    const latestSnapshot = [...transport.broadcasts].reverse().find(row =>
      (row.params.change as { type?: string } | undefined)?.type === "snapshot")!;
    const state = (latestSnapshot.params.change as { conversationState: Record<string, unknown> }).conversationState;
    const oldTurn = (state.turns as Array<Record<string, unknown>>).find(turn => turn.id === "turn-old")!;
    expect((oldTurn.params as Record<string, unknown>).input).toEqual([{ type: "text", text: "Old prompt" }]);
    expect(oldTurn.items).toEqual([{ id: "answer-old", type: "agentMessage", text: "Old answer" }]);
    sync.stop();
  });

  test("constructs safe argument-array open commands for Windows, macOS, and Linux", async () => {
    const windows = codexDesktopOpenCommands("codex://threads/abc", "win32", { SystemRoot: "C:\\Windows" });
    expect(windows).toEqual([{
      command: "C:\\Windows\\System32\\rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "codex://threads/abc"],
    }]);
    const mac = codexDesktopOpenCommands("codex://threads/abc", "darwin", {});
    expect(mac[0]).toEqual({
      command: "/usr/bin/open",
      args: ["-b", "com.openai.codex", "codex://threads/abc"],
    });
    const linux = codexDesktopOpenCommands("codex://threads/abc", "linux", {});
    expect(linux).toEqual([
      { command: "xdg-open", args: ["codex://threads/abc"] },
      { command: "gio", args: ["open", "codex://threads/abc"] },
    ]);
    expect(codexDesktopOpenCommands("codex://threads/abc", "freebsd", {})).toEqual([]);
    const calls: Array<{ command: string; args: string[] }> = [];
    await openCodexDesktopThread({
      threadId: "abc-123",
      platform: "darwin",
      activationToken: "test token",
      run: async (command, args) => { calls.push({ command, args }); },
    });
    expect(calls[0]!.args.at(-1)).toBe("codex://threads/abc-123?opencodex-follow=test%20token");
  });
});
