import type { AndroidRemoteSettings } from "./store";
import { ANDROID_TUNNEL_ORIGIN, DEFAULT_ANDROID_GATEWAY_PORT } from "./ports";
import {
  OsAndroidRemoteCloudflareSecretStore,
  type AndroidRemoteCloudflareSecretStore,
} from "./cloudflare-secret";
import { resolveCloudflared, type CloudflaredExecutable } from "./cloudflared";
import { lookup } from "node:dns/promises";

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu;
const TUNNEL_CONNECTION_REGISTERED = /\bRegistered tunnel connection\b/iu;
const QUICK_URL_TIMEOUT_MS = 30_000;
const CONNECTOR_REGISTRATION_TIMEOUT_MS = 45_000;
const VERIFY_TIMEOUT_MS = 3_000;
const VERIFIED_HEALTH_INTERVAL_MS = 15_000;
const VERIFIED_FAILURES_BEFORE_RESTART = 2;
const PROCESS_RETRY_DELAYS_MS = [1_000, 2_500, 5_000, 10_000, 30_000] as const;
type TunnelProtocol = "http2" | "quic";
// A URL can appear before Cloudflare's edge is ready. Keep a short propagation
// grace period, then surface an actionable failure instead of making onboarding
// wait for several minutes. The same child remains alive and can still recover.
const VERIFY_PROPAGATION_DELAYS_MS = [
  500,
  1_000,
  2_000,
  3_000,
  5_000,
  8_000,
  10_000,
] as const;

function alternateTunnelProtocol(protocol: TunnelProtocol): TunnelProtocol {
  return protocol === "http2" ? "quic" : "http2";
}

export type AndroidRemoteCloudflareFailure =
  | "cloudflared_unavailable"
  | "named_tunnel_incomplete"
  | "tunnel_failed"
  | "verification_failed";

export type AndroidRemoteCloudflareState = {
  mode: "quick" | "named";
  status: "stopped" | "starting" | "checking" | "ready" | "error";
  publicUrl: string | null;
  error: AndroidRemoteCloudflareFailure | null;
  /** Why a known URL is not ready yet. Kept separate from status for wire compatibility. */
  phase?: "activating" | "connecting" | "reconnecting";
};

export type AndroidRemoteCloudflareConfiguration = {
  mode: "quick" | "named";
  namedHostname?: string;
  hasNamedTunnelToken: boolean;
};

export interface AndroidRemoteCloudflareTunnel {
  state(): AndroidRemoteCloudflareState;
  configuration(settings: AndroidRemoteSettings): Promise<AndroidRemoteCloudflareConfiguration>;
  configureToken(token: string): Promise<void>;
  removeToken(): Promise<void>;
  apply(input: {
    enabled: boolean;
    port: number;
    settings: AndroidRemoteSettings;
    expectedEnvironmentId: string;
  }): Promise<void>;
  retry(input: {
    enabled: boolean;
    port: number;
    settings: AndroidRemoteSettings;
    expectedEnvironmentId: string;
  }): Promise<void>;
  /** Check the existing public URL without restarting cloudflared. */
  check(input: {
    enabled: boolean;
    port: number;
    settings: AndroidRemoteSettings;
    expectedEnvironmentId: string;
  }): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (state: AndroidRemoteCloudflareState) => void): () => void;
}

type TunnelProcess = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
};

export type AndroidRemoteCloudflareTunnelDeps = {
  resolveCloudflared: () => Promise<CloudflaredExecutable>;
  spawn: (command: readonly string[], env?: Record<string, string | undefined>) => TunnelProcess;
  fetch: typeof fetch;
  /** Diagnose ambiguous fetch errors using the same OS lookup as local clients. */
  lookupHostname?: (hostname: string) => Promise<unknown>;
  sleep: (milliseconds: number) => Promise<void>;
  platform?: NodeJS.Platform;
  /** Clear Windows' negative DNS cache before checking a newly assigned host. */
  flushDnsCache?: () => Promise<void>;
  /** Public DNS lookup used to confirm a local-only resolver failure. */
  publicLookupHostname?: (hostname: string) => Promise<unknown>;
  /** Repair only a confirmed Windows local-DNS mismatch, with UAC approval. */
  repairWindowsDns?: (hostname: string) => Promise<void>;
};

const defaultDeps: AndroidRemoteCloudflareTunnelDeps = {
  resolveCloudflared: () => resolveCloudflared(),
  spawn: (command, env) => Bun.spawn([...command], {
    // The supervisor restarts this background helper when it exits. Keep every
    // launch hidden so closing a console cannot trigger another visible window.
    windowsHide: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env } : {}),
  }) as unknown as TunnelProcess,
  fetch,
  lookupHostname: hostname => lookup(hostname),
  sleep: milliseconds => Bun.sleep(milliseconds),
  platform: process.platform,
  // Background connection setup must never launch elevation prompts or change
  // system DNS. Let the normal resolver cache expire while local access works.
};

function stopped(mode: "quick" | "named"): AndroidRemoteCloudflareState {
  return { mode, status: "stopped", publicUrl: null, error: null };
}

function sameState(
  left: AndroidRemoteCloudflareState,
  right: AndroidRemoteCloudflareState,
): boolean {
  return left.mode === right.mode
    && left.status === right.status
    && left.publicUrl === right.publicUrl
    && left.error === right.error
    && left.phase === right.phase;
}

function safeHostname(value: string): string | null {
  let input = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    if (url.protocol !== "https:"
      || url.username
      || url.password
      || url.port
      || (url.pathname !== "" && url.pathname !== "/")
      || url.search
      || url.hash) {
      return null;
    }
    input = url.hostname;
  }
  input = input.toLowerCase().replace(/\.$/u, "");
  if (!input || input.length > 253 || input.includes("/") || input.includes(":")) return null;
  let hostname: string;
  try {
    const parsed = new URL(`https://${input}`);
    hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return null;
  }
  if (hostname !== input || !hostname.includes(".")) return null;
  if (hostname === "localhost" || /^\d+(?:\.\d+){3}$/u.test(hostname)) return null;
  const labels = hostname.split(".");
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) return null;
  return hostname;
}

export function normalizeNamedTunnelHostname(value: string): string {
  const hostname = safeHostname(value);
  if (!hostname) {
    throw new TypeError("Enter a valid public hostname such as codex.example.com.");
  }
  return hostname;
}

export function validateCloudflareTunnelToken(value: string): string {
  const token = value.trim();
  if (token.length < 32 || token.length > 8_192 || /\s/u.test(token)) {
    throw new TypeError("Enter the connector token copied from the Cloudflare tunnel setup page.");
  }
  return token;
}

export function extractQuickTunnelUrl(output: string): string | null {
  return QUICK_TUNNEL_URL.exec(output)?.[0] ?? null;
}

async function drainOutput(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onText(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) onText(tail);
  } catch {
    // Process exit owns recovery. Output is diagnostic only.
  } finally {
    reader.releaseLock();
  }
}

type PublicGatewayVerification = "ready" | "activating" | "connecting";

function looksLikeDnsFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let message = "";
  while (current && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    if (typeof current === "string") message += ` ${current}`;
    else if (typeof current === "object") {
      const row = current as Record<string, unknown>;
      for (const key of ["name", "code", "errno", "syscall", "message", "cause"]) {
        const value = row[key];
        if (typeof value === "string") message += ` ${value}`;
      }
      current = row.cause;
      continue;
    }
    break;
  }
  return /\b(?:NXDOMAIN|ENOTFOUND|EAI_AGAIN|NAME_NOT_RESOLVED|DNS_PROBE|no such host|could not resolve|failed to resolve|getaddrinfo)\b/iu.test(message);
}

async function verifyPublicGateway(
  baseUrl: string,
  expectedEnvironmentId: string,
  fetchImpl: typeof fetch,
  lookupHostname?: (hostname: string) => Promise<unknown>,
): Promise<PublicGatewayVerification> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const check = async (): Promise<PublicGatewayVerification> => {
      let responses: Response[];
      try {
        responses = await Promise.all([
          fetchImpl(new URL("/healthz", baseUrl), { signal: controller.signal, cache: "no-store" }),
          fetchImpl(new URL("/.well-known/t3/environment", baseUrl), { signal: controller.signal, cache: "no-store" }),
        ]);
      } catch (error) {
        if (looksLikeDnsFailure(error)) return "activating";
        // Bun on Windows can report ConnectionRefused for a missing hostname.
        // Only a real OS lookup failure warrants the DNS state; never guess from
        // ConnectionRefused alone or change the user's DNS servers.
        if (lookupHostname && !controller.signal.aborted) {
          try { await lookupHostname(new URL(baseUrl).hostname); }
          catch (lookupError) { if (looksLikeDnsFailure(lookupError)) return "activating"; }
        }
        return "connecting";
      }
      const [healthResponse, descriptorResponse] = responses;
      if (healthResponse?.status !== 200 || descriptorResponse?.status !== 200) return "connecting";
      const [health, descriptor] = await Promise.all([
        healthResponse.json(), descriptorResponse.json(),
      ]) as [Record<string, unknown>, Record<string, unknown>];
      return health?.status === "ready"
        && health.service === "opencodex-android-remote"
        && descriptor?.environmentId === expectedEnvironmentId
        ? "ready" : "connecting";
    };
    // Bound the entire check, including response bodies and diagnostic DNS.
    return await Promise.race([
      check(),
      new Promise<PublicGatewayVerification>(resolve => {
        timeout = setTimeout(() => { controller.abort(); resolve("connecting"); }, VERIFY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return "connecting";
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

export class ManagedAndroidRemoteCloudflareTunnel implements AndroidRemoteCloudflareTunnel {
  private current = stopped("quick");
  private readonly listeners = new Set<(state: AndroidRemoteCloudflareState) => void>();
  private desiredKey = "";
  private generation = 0;
  private process: TunnelProcess | null = null;
  private registeredProcess: TunnelProcess | null = null;
  private verificationFlight: { process: TunnelProcess; result: Promise<PublicGatewayVerification> } | null = null;
  private hasNamedTunnelToken: boolean | null = null;
  // TCP avoids the long automatic QUIC fallback on common desktop networks. If
  // it cannot register, runOnce rotates this preference to QUIC. A protocol that
  // reaches the edge remains preferred across later process restarts.
  private preferredProtocol: TunnelProtocol = "http2";
  private windowsDnsRepairAttempted = false;

  constructor(
    private readonly secrets: AndroidRemoteCloudflareSecretStore =
      new OsAndroidRemoteCloudflareSecretStore(),
    private readonly deps: AndroidRemoteCloudflareTunnelDeps = defaultDeps,
  ) {}

  state(): AndroidRemoteCloudflareState {
    return { ...this.current };
  }

  async configuration(settings: AndroidRemoteSettings): Promise<AndroidRemoteCloudflareConfiguration> {
    if (this.hasNamedTunnelToken === null) {
      try {
        this.hasNamedTunnelToken = Boolean(await this.secrets.getToken());
      } catch {
        this.hasNamedTunnelToken = false;
        // The runtime state reports the actionable failure once Named Tunnel is selected.
      }
    }
    return {
      mode: settings.tunnelMode,
      ...(settings.tunnelMode === "named" && settings.namedTunnelHostname
        ? { namedHostname: settings.namedTunnelHostname }
        : {}),
      hasNamedTunnelToken: this.hasNamedTunnelToken,
    };
  }

  async configureToken(token: string): Promise<void> {
    await this.secrets.setToken(validateCloudflareTunnelToken(token));
    this.hasNamedTunnelToken = true;
  }

  async removeToken(): Promise<void> {
    await this.secrets.removeToken();
    this.hasNamedTunnelToken = false;
  }

  subscribe(listener: (state: AndroidRemoteCloudflareState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(next: AndroidRemoteCloudflareState): void {
    if (sameState(this.current, next)) return;
    this.current = next;
    for (const listener of this.listeners) listener(this.state());
  }

  private verify(child: TunnelProcess, url: string, environmentId: string): Promise<PublicGatewayVerification> {
    if (this.verificationFlight?.process === child) return this.verificationFlight.result;
    const result = verifyPublicGateway(url, environmentId, this.deps.fetch, this.deps.lookupHostname);
    const flight = { process: child, result };
    this.verificationFlight = flight;
    void result.finally(() => { if (this.verificationFlight === flight) this.verificationFlight = null; });
    return result;
  }

  /**
   * Windows-only recovery for the specific case we have proved: this PC's
   * resolver cannot find the tunnel name, while an independent public DNS
   * resolver can. It never runs for ordinary HTTP failures or on Linux/macOS.
   */
  private async maybeRepairWindowsDns(publicUrl: string): Promise<void> {
    if (!this.deps.repairWindowsDns || this.deps.platform !== "win32" || this.windowsDnsRepairAttempted) return;
    let hostname: string;
    try { hostname = new URL(publicUrl).hostname; } catch { return; }
    try {
      await this.deps.lookupHostname?.(hostname);
      return;
    } catch {
      // Expected: the local resolver is the failing side of the diagnosis.
    }
    try {
      if (!this.deps.publicLookupHostname) return;
      await this.deps.publicLookupHostname(hostname);
    } catch {
      // Public DNS does not know it yet; changing a user's network settings
      // would be unsafe, so leave the tunnel in its normal retry state.
      return;
    }
    // From this point the diagnosis is complete. Do not show a second UAC
    // prompt if the user cancels or Windows rejects the change.
    this.windowsDnsRepairAttempted = true;
    try {
      await this.deps.repairWindowsDns?.(hostname);
      // The elevated command clears the cache too; this extra flush is cheap
      // and makes the behavior deterministic for custom test helpers.
      await this.deps.flushDnsCache?.().catch(() => undefined);
    } catch {
      // UAC cancellation or a policy-blocked change must not crash onboarding.
    }
  }

  async apply(input: {
    enabled: boolean;
    port: number;
    settings: AndroidRemoteSettings;
    expectedEnvironmentId: string;
  }): Promise<void> {
    const hostname = input.settings.namedTunnelHostname ?? "";
    const nextKey = input.enabled
      ? `${input.settings.tunnelMode}:${hostname}:${input.port}:${input.expectedEnvironmentId}`
      : "disabled";
    if (nextKey === this.desiredKey) return;
    this.desiredKey = nextKey;
    this.windowsDnsRepairAttempted = false;
    const generation = ++this.generation;
    await this.stopProcess();
    if (!input.enabled) {
      this.publish(stopped(input.settings.tunnelMode));
      return;
    }
    if (input.port !== DEFAULT_ANDROID_GATEWAY_PORT) {
      this.publish({ mode: input.settings.tunnelMode, status: "error", publicUrl: null, error: "tunnel_failed" });
      return;
    }
    void this.run(generation, input);
  }

  async retry(input: {
    enabled: boolean;
    port: number;
    settings: AndroidRemoteSettings;
    expectedEnvironmentId: string;
  }): Promise<void> {
    this.desiredKey = "";
    await this.apply(input);
  }

  async check(input: {
    enabled: boolean;
    port: number;
    settings: AndroidRemoteSettings;
    expectedEnvironmentId: string;
  }): Promise<void> {
    const generation = this.generation;
    const publicUrl = this.current.publicUrl;
    const child = this.process;
    if (!input.enabled || !publicUrl || !child || this.registeredProcess !== child
      || this.desiredKey === "disabled") return;

    const wasReady = this.current.status === "ready" || this.current.phase === "reconnecting";
    this.publish({
      mode: this.current.mode,
      status: "checking",
      publicUrl,
      error: null,
      phase: wasReady ? "reconnecting" : this.current.phase ?? "connecting",
    });
    const result = await this.verify(child, publicUrl, input.expectedEnvironmentId);
    if (!this.currentGeneration(generation) || this.process !== child || this.current.publicUrl !== publicUrl) return;
    if (result === "ready") {
      this.publish({ mode: this.current.mode, status: "ready", publicUrl, error: null });
      return;
    }
    this.publish(wasReady && result !== "activating"
      ? {
          mode: this.current.mode,
          status: "error",
          publicUrl,
          error: "verification_failed",
          phase: "reconnecting",
        }
      : {
          mode: this.current.mode,
          status: "checking",
          publicUrl,
          error: null,
          phase: result,
        });
  }

  async stop(): Promise<void> {
    this.desiredKey = "disabled";
    ++this.generation;
    await this.stopProcess();
    this.publish(stopped(this.current.mode));
  }

  private currentGeneration(generation: number): boolean {
    return generation === this.generation && this.desiredKey !== "disabled";
  }

  private async stopProcess(): Promise<void> {
    const process = this.process;
    this.process = null;
    this.registeredProcess = null;
    if (!process) return;
    try {
      process.kill("SIGTERM");
    } catch {
      return;
    }
    await Promise.race([process.exited.catch(() => 0), this.deps.sleep(1_000)]);
    try {
      process.kill("SIGKILL");
    } catch {
      // The process already exited.
    }
  }

  private async run(
    generation: number,
    input: {
      enabled: boolean;
      port: number;
      settings: AndroidRemoteSettings;
      expectedEnvironmentId: string;
    },
  ): Promise<void> {
    let attempt = 0;
    while (this.currentGeneration(generation)) {
      const result = await this.runOnce(generation, input);
      if (!this.currentGeneration(generation)) return;
      this.publish({
        mode: input.settings.tunnelMode,
        status: "error",
        publicUrl: this.current.mode === input.settings.tunnelMode
          ? this.current.publicUrl
          : null,
        error: result,
        ...(this.current.publicUrl ? { phase: "reconnecting" as const } : {}),
      });
      // Retry an exited/unregistered connector, or sustained non-DNS health
      // failures after readiness. DNS failures never leave runOnce or replace
      // a connected child with another new hostname.
      const delay = PROCESS_RETRY_DELAYS_MS[Math.min(attempt, PROCESS_RETRY_DELAYS_MS.length - 1)];
      attempt += 1;
      await this.deps.sleep(delay!);
    }
  }

  private async runOnce(
    generation: number,
    input: {
      enabled: boolean;
      port: number;
      settings: AndroidRemoteSettings;
      expectedEnvironmentId: string;
    },
  ): Promise<AndroidRemoteCloudflareFailure> {
    const mode = input.settings.tunnelMode;
    const protocol = this.preferredProtocol;
    this.publish({ mode, status: "starting", publicUrl: null, error: null });

    let executable: CloudflaredExecutable;
    try {
      executable = await this.deps.resolveCloudflared();
    } catch {
      return "cloudflared_unavailable";
    }
    if (!this.currentGeneration(generation)) return "tunnel_failed";

    let publicUrl: string;
    let token: string | null = null;
    if (mode === "named") {
      const hostname = safeHostname(input.settings.namedTunnelHostname ?? "");
      try {
        token = await this.secrets.getToken();
      } catch {
        this.hasNamedTunnelToken = false;
        return "named_tunnel_incomplete";
      }
      this.hasNamedTunnelToken = Boolean(token);
      if (!hostname || !token) return "named_tunnel_incomplete";
      publicUrl = `https://${hostname}`;
    } else {
      publicUrl = "";
    }

    let child: TunnelProcess;
    try {
      // Remodex verifies the real public health and environment endpoints itself.
      // cloudflared prechecks can report a false hard failure, delay startup, and still
      // register successfully afterwards, so skip that advisory gate. Use
      // the environment switch instead of a CLI flag so an explicit older override
      // can ignore it rather than rejecting an unknown argument.
      const tunnelEnvironment = {
        ...globalThis.process.env,
        TUNNEL_NO_PRECHECKS: "true",
        ...(token ? { TUNNEL_TOKEN: token } : {}),
      };
      // Avoid cloudflared's slow automatic QUIC-to-HTTP/2 handoff. Start with
      // the last working protocol (HTTP/2 initially), then rotate only if no
      // connector reaches the edge within the bounded registration window.
      const protocolArgs = ["--protocol", protocol];
      child = this.deps.spawn(
        mode === "quick"
          ? [
              executable.path,
              "tunnel",
              "--url",
              ANDROID_TUNNEL_ORIGIN,
              "--no-autoupdate",
              ...protocolArgs,
            ]
          : [executable.path, "tunnel", "--no-autoupdate", ...protocolArgs, "run"],
        tunnelEnvironment,
      );
    } catch {
      return "tunnel_failed";
    } finally {
      token = null;
    }
    this.process = child;

    if (!this.currentGeneration(generation)) {
      if (this.process === child) this.process = null;
      try { child.kill("SIGTERM"); } catch { /* already stopped */ }
      return "tunnel_failed";
    }

    let outputBuffer = "";
    let resolveQuickUrl: ((url: string) => void) | null = null;
    const quickUrl = new Promise<string>(resolve => {
      resolveQuickUrl = resolve;
    });
    let resolveRegisteredConnection: (() => void) | null = null;
    const registeredConnection = new Promise<void>(resolve => {
      resolveRegisteredConnection = resolve;
    });
    let registeredConnectionSeen = false;
    const inspect = (text: string) => {
      outputBuffer = `${outputBuffer}${text}`.slice(-4_000);
      const url = extractQuickTunnelUrl(outputBuffer);
      if (url && resolveQuickUrl) {
        const resolve = resolveQuickUrl;
        resolveQuickUrl = null;
        resolve(url);
      }
      if (TUNNEL_CONNECTION_REGISTERED.test(outputBuffer) && resolveRegisteredConnection) {
        registeredConnectionSeen = true;
        if (this.currentGeneration(generation) && this.process === child) this.registeredProcess = child;
        this.preferredProtocol = protocol;
        const resolve = resolveRegisteredConnection;
        resolveRegisteredConnection = null;
        resolve();
      }
    };
    void drainOutput(child.stdout, inspect);
    void drainOutput(child.stderr, inspect);

    if (mode === "quick") {
      const discovered = await Promise.race([
        quickUrl.then(url => ({ kind: "url" as const, url })),
        child.exited.then(() => ({ kind: "exit" as const })),
        this.deps.sleep(QUICK_URL_TIMEOUT_MS).then(() => ({ kind: "timeout" as const })),
      ]);
      if (discovered.kind !== "url") {
        if (this.process === child) this.process = null;
        if (!registeredConnectionSeen) this.preferredProtocol = alternateTunnelProtocol(protocol);
        try { child.kill("SIGTERM"); } catch { /* already stopped */ }
        return "tunnel_failed";
      }
      publicUrl = discovered.url;
    }

    if (!this.currentGeneration(generation)) {
      if (this.process === child) this.process = null;
      try { child.kill("SIGTERM"); } catch { /* already stopped */ }
      return "tunnel_failed";
    }
    this.publish({
      mode,
      status: "starting",
      publicUrl,
      error: null,
      phase: "connecting",
    });

    // Printing a URL is not a connection signal. Avoid asking local DNS about a
    // brand-new hostname before cloudflared has even registered its connector.
    // The dashboard's Check action uses the same registeredProcess gate.
    const registration = registeredConnectionSeen ? "registered" : await Promise.race([
      registeredConnection.then(() => "registered" as const),
      child.exited.then(() => "exit" as const),
      this.deps.sleep(CONNECTOR_REGISTRATION_TIMEOUT_MS).then(() => "timeout" as const),
    ]);
    if (!this.currentGeneration(generation) || this.process !== child) return "tunnel_failed";
    if (registration !== "registered") {
      this.process = null;
      this.preferredProtocol = alternateTunnelProtocol(protocol);
      try { child.kill("SIGTERM"); } catch { /* already stopped */ }
      return "tunnel_failed";
    }
    this.publish({ mode, status: "checking", publicUrl, error: null, phase: "connecting" });

    // Windows caches NXDOMAIN answers. A newly provisioned Remodex hostname
    // can therefore remain invisible to the same machine even though public
    // DNS already serves it. Flush only the local cache, never the router or
    // external DNS, and continue if the command is unavailable.
    if (this.deps.platform === "win32") {
      await this.deps.flushDnsCache?.().catch(() => undefined);
    }

    let verificationFailures = 0;
    let verifiedAtLeastOnce = false;
    while (this.currentGeneration(generation)) {
      const readinessChecks: Array<Promise<
        | { kind: "verify"; result: PublicGatewayVerification }
        | { kind: "exit"; code: number }
      >> = [
        this.verify(child, publicUrl, input.expectedEnvironmentId)
          .then(result => ({ kind: "verify" as const, result })),
        child.exited.then(code => ({ kind: "exit" as const, code })),
      ];
      const result = await Promise.race(readinessChecks);
      if (!this.currentGeneration(generation) || this.process !== child) return "tunnel_failed";
      if (result.kind === "exit") {
        if (this.process === child) this.process = null;
        if (!registeredConnectionSeen && !verifiedAtLeastOnce) {
          this.preferredProtocol = alternateTunnelProtocol(protocol);
        }
        return "tunnel_failed";
      }
      if (result.result === "ready") {
        registeredConnectionSeen = true;
        this.preferredProtocol = protocol;
        verifiedAtLeastOnce = true;
        verificationFailures = 0;
        this.publish({ mode, status: "ready", publicUrl, error: null });
      } else if (result.result === "activating") {
        // A browser-side DNS miss is not evidence the connector died, even if
        // this URL worked previously. Keep its identity and retry normally.
        verificationFailures = 0;
        this.publish({ mode, status: "checking", publicUrl, error: null, phase: "activating" });
        await this.maybeRepairWindowsDns(publicUrl);
      } else {
        verificationFailures += 1;
        const graceExpired = result.result === "connecting"
          && verificationFailures > VERIFY_PROPAGATION_DELAYS_MS.length;
        if (verifiedAtLeastOnce || graceExpired) {
          this.publish({
            mode,
            status: "error",
            publicUrl,
            error: "verification_failed",
            phase: "reconnecting",
          });
          // A Quick Tunnel address belongs to its running connector. A failed
          // reachability check (including losing Wi-Fi) cannot prove it died.
          // Keep that process and address so cloudflared can reconnect. Named
          // tunnels may restart here because their configured address is stable.
          const restartConfirmed = mode === "named" && verifiedAtLeastOnce
            && verificationFailures >= VERIFIED_FAILURES_BEFORE_RESTART;
          if (restartConfirmed) {
            if (this.process === child) this.process = null;
            try { child.kill("SIGTERM"); } catch { /* already stopped */ }
            await Promise.race([child.exited.catch(() => 0), this.deps.sleep(1_000)]);
            return "verification_failed";
          }
        } else {
          this.publish({
            mode,
            status: "checking",
            publicUrl,
            error: null,
            phase: result.result,
          });
        }
      }
      const delay = verifiedAtLeastOnce
        ? VERIFIED_HEALTH_INTERVAL_MS
        : result.result === "activating" ? VERIFY_PROPAGATION_DELAYS_MS.at(-1)!
        : VERIFY_PROPAGATION_DELAYS_MS[
            Math.min(Math.max(verificationFailures - 1, 0), VERIFY_PROPAGATION_DELAYS_MS.length - 1)
          ]!;
      const waits: Array<Promise<"retry" | "exit">> = [
        this.deps.sleep(delay).then(() => "retry" as const),
        child.exited.then(() => "exit" as const),
      ];
      const wait = await Promise.race(waits);
      if (wait === "exit") {
        if (this.process === child) this.process = null;
        if (!registeredConnectionSeen && !verifiedAtLeastOnce) {
          this.preferredProtocol = alternateTunnelProtocol(protocol);
        }
        return "tunnel_failed";
      }
      // A dependency seam may resolve sleep immediately (as focused tests do).
      // Always yield a real event-loop turn so stop()/generation changes and
      // other callers cannot be starved by a health-check loop.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    return "tunnel_failed";
  }
}

export class DisabledAndroidRemoteCloudflareTunnel implements AndroidRemoteCloudflareTunnel {
  state(): AndroidRemoteCloudflareState {
    return stopped("quick");
  }
  async configuration(settings: AndroidRemoteSettings): Promise<AndroidRemoteCloudflareConfiguration> {
    return {
      mode: settings.tunnelMode,
      ...(settings.tunnelMode === "named" && settings.namedTunnelHostname
        ? { namedHostname: settings.namedTunnelHostname }
        : {}),
      hasNamedTunnelToken: false,
    };
  }
  async configureToken(): Promise<void> {}
  async removeToken(): Promise<void> {}
  async apply(): Promise<void> {}
  async retry(): Promise<void> {}
  async check(): Promise<void> {}
  async stop(): Promise<void> {}
  subscribe(): () => void {
    return () => undefined;
  }
}
