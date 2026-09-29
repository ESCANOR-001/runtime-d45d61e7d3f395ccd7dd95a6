import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_CODEX_APP_SERVER_PORT } from "./ports";
import { codexExecInvocation } from "../codex/exec-invocation";
import { CODEX_PROFILE_PATH } from "../codex/paths";
import { readDesktopDirectModelProvider } from "./desktop-model-route";
import { verifyAndroidRuntimePeer, type AndroidRuntimeSelection } from "./runtime-compatibility";
import { resolveAndroidRuntimeInBackground } from "./runtime-probe-client";
import { spawnWindowsProcessWithoutInheritedHandlesAsync } from "../lib/windows-no-inherit-process";

const START_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 30_000;
const OWNED_PROCESS_TERM_GRACE_MS = 1_000;
const OWNED_PROCESS_KILL_GRACE_MS = 1_000;

const APP_SERVER_PROFILE_KEYS = new Set([
  "model_provider",
  "openai_base_url",
  "model_catalog_json",
  "service_tier",
  "features.fast_mode",
  "model_providers.opencodex.name",
  "model_providers.opencodex.base_url",
  "model_providers.opencodex.wire_api",
  "model_providers.opencodex.requires_openai_auth",
  "model_providers.opencodex.supports_websockets",
  "model_providers.opencodex.env_http_headers.x-opencodex-api-key",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function flattenProfile(
  value: Record<string, unknown>,
  prefix: string[],
  output: Array<{ key: string; value: unknown }>,
): void {
  for (const [segment, child] of Object.entries(value)) {
    const path = [...prefix, segment];
    const childRecord = record(child);
    if (childRecord) {
      flattenProfile(childRecord, path, output);
      continue;
    }
    output.push({ key: path.join("."), value: child });
  }
}

function configTomlLiteral(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error("Remodex Codex profile contains an unsupported config value");
}

/**
 * Current Codex builds do not accept `--profile` on `app-server`. Project the
 * generated profile's small, non-secret allowlist through app-server's supported
 * `--config key=value` surface instead. This has the same overlay effect without
 * changing the user's base config.toml or putting a credential value in argv.
 */
export function codexAppServerProfileOverrideArgs(profileContent: string): string[] {
  let parsed: Record<string, unknown>;
  try {
    const document = record(Bun.TOML.parse(profileContent.replace(/^\uFEFF/, "")));
    if (!document) throw new Error("profile root is not a TOML table");
    parsed = document;
  } catch {
    throw new Error("Could not parse the generated Remodex Codex profile");
  }

  const leaves: Array<{ key: string; value: unknown }> = [];
  flattenProfile(parsed, [], leaves);
  const values = new Map(leaves.map(entry => [entry.key, entry.value]));
  const provider = values.get("model_provider");
  const hasLoopbackRoute = provider === "openai"
    && typeof values.get("openai_base_url") === "string";
  const hasNamedRoute = provider === "opencodex"
    && typeof values.get("model_providers.opencodex.base_url") === "string"
    && values.get("model_providers.opencodex.wire_api") === "responses";
  if (!hasLoopbackRoute && !hasNamedRoute) {
    throw new Error("Generated Remodex Codex profile does not contain a complete proxy route");
  }

  const args: string[] = [];
  for (const { key, value } of leaves) {
    if (!APP_SERVER_PROFILE_KEYS.has(key)) {
      throw new Error(`Generated Remodex Codex profile contains unsupported key ${JSON.stringify(key)}`);
    }
    if (
      key === "model_providers.opencodex.env_http_headers.x-opencodex-api-key"
      && (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    ) {
      throw new Error("Generated Remodex Codex profile contains an invalid API-auth environment reference");
    }
    args.push("--config", `${key}=${configTomlLiteral(value)}`);
  }
  return args;
}

function installedProfileContent(): string | null {
  if (process.env.REMODEX_CONNECT_ONLY === "1") return null;
  if (!existsSync(CODEX_PROFILE_PATH)) return null;
  return readFileSync(CODEX_PROFILE_PATH, "utf8");
}

/** A native connection accepts its provider's model ID, without Remodex's prefix. */
export function codexAppServerModelParams(params: unknown, directProvider: string | null): unknown {
  const source = record(params);
  if (!source || !directProvider) return params;
  const prefix = `${directProvider}/`;
  const model = (value: unknown): unknown => typeof value === "string" && value.startsWith(prefix)
    ? value.slice(prefix.length) : value;
  const collaboration = record(source.collaborationMode);
  const settings = record(collaboration?.settings);
  return {
    ...source,
    ...(typeof source.model === "string" ? { model: model(source.model) } : {}),
    ...(settings && typeof settings.model === "string" ? {
      collaborationMode: { ...collaboration, settings: { ...settings, model: model(settings.model) } },
    } : {}),
  };
}

/**
 * Arguments for the private Codex app-server used by Remodex's external clients.
 * The generated v2 profile keeps the user's base config/provider untouched. Its
 * values are forwarded as one-off config overrides because app-server itself
 * does not currently accept Codex's `--profile` selector.
 */
export function remodexCodexAppServerArgs(
  port: number,
  profileContent: string | null = installedProfileContent(),
): string[] {
  return [
    ...(process.env.REMODEX_CONNECT_ONLY === "1" ? ["--config", 'model_provider="openai"'] : profileContent === null ? [] : codexAppServerProfileOverrideArgs(profileContent)),
    "--enable",
    "goals",
    "app-server",
    "--listen",
    `ws://127.0.0.1:${port}`,
  ];
}

export type CodexJsonRpcMessage = Record<string, unknown> & {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export interface AndroidCodexClient {
  /** Provider captured for this connection; null means Remodex proxy routing. */
  readonly directModelProvider?: string | null;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  respond(id: string | number, result: unknown): void;
  reject(id: string | number, code: number, message: string): void;
  subscribe(listener: (message: CodexJsonRpcMessage) => void): () => void;
  close(): void;
  /**
   * `false` means the transport can no longer accept a request. Older test
   * doubles may omit the field, so callers must treat `undefined` as unknown.
   */
  readonly connected?: boolean;
  readonly closed: Promise<void>;
}

export class AndroidCodexConnectionError extends Error {
  constructor(
    message: string,
    readonly requestMayHaveBeenSent: boolean,
  ) {
    super(message);
    this.name = "AndroidCodexConnectionError";
  }
}

export class AndroidCodexResponseTooLargeError extends AndroidCodexConnectionError {
  constructor() {
    super("Codex response exceeded the safe history size limit", true);
    this.name = "AndroidCodexResponseTooLargeError";
  }
}

const SAFE_DISCONNECT_RETRY_METHODS = new Set([
  "fs/readDirectory",
  "fuzzyFileSearch",
  "model/list",
  "plugin/installed",
  "plugin/list",
  "skills/list",
  "thread/list",
  "thread/read",
  "thread/turns/list",
]);

function connectionFailure(error: unknown): boolean {
  if (error instanceof AndroidCodexConnectionError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /codex task server.*(?:closed|disconnect|connection|connected|failed)|websocket.*(?:closed|disconnect|connection|failed)/iu
    .test(message);
}

function frameText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  return null;
}

class CodexAppServerSocket implements AndroidCodexClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly listeners = new Set<(message: CodexJsonRpcMessage) => void>();
  private readonly closedResolve: () => void;
  private didClose = false;
  readonly closed: Promise<void>;

  private constructor(private readonly socket: WebSocket, readonly directModelProvider: string | null) {
    let resolveClosed = () => {};
    this.closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    this.closedResolve = resolveClosed;
    socket.addEventListener("message", event => this.onMessage(event.data));
    socket.addEventListener("close", () => this.onClosed("Codex task server disconnected"));
    socket.addEventListener("error", () => this.onClosed("Codex task server connection failed"));
  }

  static async connect(url: string, expectedVersion: string | null = null): Promise<CodexAppServerSocket> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        finish(() => {
          try { socket.close(); } catch { /* connection already failed */ }
          reject(new Error("Codex task server connection timed out"));
        });
      }, 5_000);
      socket.addEventListener("open", () => finish(resolve), { once: true });
      socket.addEventListener("error", () => finish(() => {
        reject(new Error("Could not connect to the Codex task server"));
      }), { once: true });
    });
    const client = new CodexAppServerSocket(socket,
      process.env.REMODEX_CONNECT_ONLY === "1" ? "openai" : existsSync(CODEX_PROFILE_PATH) ? null : readDesktopDirectModelProvider());
    try {
      const initialized = await client.request<Record<string, unknown>>("initialize", {
        clientInfo: { name: "Remodex Android Remote", version: "1" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      });
      verifyAndroidRuntimePeer(initialized?.userAgent, expectedVersion);
      client.send({ method: "initialized" });
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  get connected(): boolean {
    return !this.didClose && this.socket.readyState === WebSocket.OPEN;
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (["thread/start", "thread/resume", "thread/settings/update", "turn/start"].includes(method)) {
      params = codexAppServerModelParams(params, this.directModelProvider);
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof AndroidCodexConnectionError
          ? error
          : new AndroidCodexConnectionError(
              error instanceof Error ? error.message : String(error),
              false,
            ));
      }
    });
  }

  respond(id: string | number, result: unknown): void {
    this.send({ id, result });
  }

  reject(id: string | number, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  subscribe(listener: (message: CodexJsonRpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    try { this.socket.close(1000, "Remodex stopping"); } catch { /* already closed */ }
    this.onClosed("Codex task server connection closed");
  }

  private send(message: CodexJsonRpcMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new AndroidCodexConnectionError("Codex task server is not connected", false);
    }
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  private onMessage(data: unknown): void {
    const text = frameText(data);
    if (!text) return;
    if (text.length > 16 * 1024 * 1024) {
      const error = new AndroidCodexResponseTooLargeError();
      this.onClosed(error.message, error);
      this.socket.close(1009, "Codex response exceeded the safe size limit");
      return;
    }
    let message: CodexJsonRpcMessage;
    try {
      message = JSON.parse(text) as CodexJsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || "Codex task request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  private onClosed(message: string, failure?: AndroidCodexConnectionError): void {
    if (this.didClose) return;
    this.didClose = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure ?? new AndroidCodexConnectionError(message, true));
    }
    this.pending.clear();
    this.closedResolve();
  }
}

async function taskServerReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(750),
    });
    return response.ok;
  } catch {
    return false;
  }
}

type KillableSubprocess = Pick<Bun.Subprocess, "kill" | "exited">;

async function waitUntilReady(port: number, child: KillableSubprocess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await taskServerReady(port)) return;
    const exit = await Promise.race([
      child.exited.then(code => ({ code })),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 150)),
    ]);
    if (exit) throw new Error(`Codex task server exited during startup (code ${exit.code})`);
  }
  throw new Error("Codex task server did not become ready");
}

function waitForSubprocessExit(child: KillableSubprocess, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(exited);
    };
    timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    // A failed exit promise still means the child is no longer running. The
    // rejection is consumed here so shutdown never creates an unhandled error.
    void child.exited.then(() => finish(true), () => finish(true));
  });
}

/**
 * Stop a process that the current Remodex runtime explicitly spawned.
 *
 * Codex normally honors SIGTERM, but an app-server can be wedged while its
 * listener is being torn down. Keep the wait bounded and escalate only for
 * this caller-owned handle; callers must never pass a process they did not
 * create and positively mark as owned.
 */
export async function terminateOwnedCodexProcess(
  child: KillableSubprocess,
  termGraceMs = OWNED_PROCESS_TERM_GRACE_MS,
  killGraceMs = OWNED_PROCESS_KILL_GRACE_MS,
): Promise<void> {
  try { child.kill("SIGTERM"); } catch { /* already exited */ }
  if (await waitForSubprocessExit(child, termGraceMs)) return;

  try { child.kill("SIGKILL"); } catch { /* already exited */ }
  if (!await waitForSubprocessExit(child, killGraceMs)) {
    throw new Error("Owned Codex task server did not exit after forced termination");
  }
}

export type AndroidCodexRuntimeStatus = {
  connected: boolean;
  port: number;
  ownedProcess: boolean;
  error?: string;
};

export class AndroidCodexRuntime {
  private child: KillableSubprocess | null = null;
  private socket: AndroidCodexClient | null = null;
  private socketUnsubscribe: (() => void) | null = null;
  private facade: AndroidCodexClient | null = null;
  private facadeClosedResolve: (() => void) | null = null;
  private readonly listeners = new Set<(message: CodexJsonRpcMessage) => void>();
  private connectFlight: Promise<AndroidCodexClient> | null = null;
  private ownedProcess = false;
  private error: string | undefined;
  private lifecycleRevision = 0;
  private stopFlight: Promise<void> | null = null;

  constructor(
    private readonly port = DEFAULT_CODEX_APP_SERVER_PORT,
    private readonly selectRuntime: () => AndroidRuntimeSelection | Promise<AndroidRuntimeSelection> = resolveAndroidRuntimeInBackground,
  ) {}

  status(): AndroidCodexRuntimeStatus {
    return {
      connected: this.socket?.connected !== false && this.socket !== null,
      port: this.port,
      ownedProcess: this.ownedProcess,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async start(): Promise<AndroidCodexClient> {
    if (this.stopFlight) throw new Error("Codex task runtime is stopping");
    const facade = this.facade ?? this.createFacade();
    await this.ensureSocket();
    return facade;
  }

  private createFacade(): AndroidCodexClient {
    let resolveClosed = () => {};
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const thisRuntime = this;
    const facade: AndroidCodexClient = {
      request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => {
        if (this.facade !== facade || this.stopFlight) {
          return Promise.reject(new Error("Codex task client is closed"));
        }
        return this.request<T>(method, params, timeoutMs);
      },
      respond: (id, result) => {
        if (this.facade !== facade || this.stopFlight) throw new Error("Codex task client is closed");
        this.requireSocket().respond(id, result);
      },
      reject: (id, code, message) => {
        if (this.facade !== facade || this.stopFlight) throw new Error("Codex task client is closed");
        this.requireSocket().reject(id, code, message);
      },
      subscribe: listener => {
        if (this.facade !== facade || this.stopFlight) return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      close: () => {
        if (this.facade === facade) void this.stop();
      },
      get connected() {
        return facade === thisRuntime.facade && thisRuntime.status().connected;
      },
      closed,
    };
    this.facade = facade;
    this.facadeClosedResolve = resolveClosed;
    return facade;
  }

  private async request<T>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const socket = await this.ensureSocket();
    try {
      return await socket.request<T>(method, params, timeoutMs);
    } catch (error) {
      if (error instanceof AndroidCodexResponseTooLargeError) {
        this.dropSocket(socket, true);
        throw error;
      }
      if (!connectionFailure(error)) throw error;
      this.dropSocket(socket, true);
      const canRetry = error instanceof AndroidCodexConnectionError
        ? !error.requestMayHaveBeenSent || SAFE_DISCONNECT_RETRY_METHODS.has(method)
        : SAFE_DISCONNECT_RETRY_METHODS.has(method);
      if (!canRetry) throw error;
      return (await this.ensureSocket()).request<T>(method, params, timeoutMs);
    }
  }

  private requireSocket(): AndroidCodexClient {
    if (!this.socket || this.socket.connected === false) {
      throw new AndroidCodexConnectionError("Codex task server is not connected", false);
    }
    return this.socket;
  }

  private async ensureSocket(): Promise<AndroidCodexClient> {
    if (this.socket?.connected !== false && this.socket) return this.socket;
    if (this.socket) this.dropSocket(this.socket, false);
    if (this.connectFlight) return this.connectFlight;
    const revision = this.lifecycleRevision;
    const flight = this.connectSocket(revision);
    this.connectFlight = flight;
    try {
      return await flight;
    } finally {
      if (this.connectFlight === flight) this.connectFlight = null;
    }
  }

  private async connectSocket(revision: number): Promise<AndroidCodexClient> {
    this.error = undefined;
    try {
      const selection = await this.selectRuntime();
      if (revision !== this.lifecycleRevision) throw new Error("Codex task runtime stopped during startup");
      if (!(await taskServerReady(this.port))) {
        await this.stopOwnedProcess();
        const runtime = selection.runtime;
        const invocation = codexExecInvocation(
          runtime.command || "codex",
          remodexCodexAppServerArgs(this.port),
        );
        // Bun can copy the proxy's 10100 LISTEN handle into a Windows child.
        // Launch through Start-Process there so a stopped proxy never leaves a
        // dead-PID listener behind in the long-lived Codex app-server tree.
        const child: KillableSubprocess = process.platform === "win32"
          ? await spawnWindowsProcessWithoutInheritedHandlesAsync(invocation.file, invocation.args, {
              windowsVerbatimArguments: invocation.options.windowsVerbatimArguments,
            })
          : Bun.spawn([invocation.file, ...invocation.args], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              windowsHide: true,
            });
        this.child = child;
        this.ownedProcess = true;
        void child.exited.then(() => {
          if (this.child !== child) return;
          this.child = null;
          this.ownedProcess = false;
        });
        await waitUntilReady(this.port, child);
      }
      const socket = await CodexAppServerSocket.connect(
        `ws://127.0.0.1:${this.port}`, selection.desktopVersion ?? selection.runtime.version,
      );
      if (revision !== this.lifecycleRevision) {
        socket.close();
        throw new Error("Codex task runtime stopped during startup");
      }
      this.socket = socket;
      this.socketUnsubscribe = socket.subscribe(message => {
        for (const listener of this.listeners) listener(message);
      });
      void socket.closed.then(() => this.dropSocket(socket, false));
      this.error = undefined;
      return socket;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      await this.stopOwnedProcess();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopFlight) return this.stopFlight;
    const flight = this.stopRuntime();
    this.stopFlight = flight;
    try {
      await flight;
    } finally {
      if (this.stopFlight === flight) this.stopFlight = null;
    }
  }

  private async stopRuntime(): Promise<void> {
    this.lifecycleRevision += 1;
    const connecting = this.connectFlight;
    if (connecting) await connecting.catch(() => undefined);
    const socket = this.socket;
    if (socket) this.dropSocket(socket, true);
    await this.stopOwnedProcess();
    this.listeners.clear();
    this.facadeClosedResolve?.();
    this.facadeClosedResolve = null;
    this.facade = null;
    this.error = undefined;
  }

  private dropSocket(socket: AndroidCodexClient, close: boolean): void {
    if (this.socket !== socket) return;
    this.socketUnsubscribe?.();
    this.socketUnsubscribe = null;
    this.socket = null;
    if (close) {
      try { socket.close(); } catch { /* already disconnected */ }
    }
  }

  private async stopOwnedProcess(): Promise<void> {
    const child = this.child;
    this.child = null;
    const owned = child !== null && this.ownedProcess;
    this.ownedProcess = false;
    if (owned) await terminateOwnedCodexProcess(child);
  }
}
