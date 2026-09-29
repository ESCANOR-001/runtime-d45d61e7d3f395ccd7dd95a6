import { isAndroidRemoteLocalUrl } from "../android-remote/local-network";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createAndroidRemoteStore } from "../android-remote/store";
import { ensureConfigFile } from "../config";
import {
  currentExternalCodexModelProvider,
  getCodexConfigPath,
} from "../codex/inject";
import type { CodexDesiredStateResult } from "../codex/desired-state";
import type { CodexSyncResult } from "../codex/sync";
import { openUrl } from "../lib/open-url";
import { redactSecretString } from "../lib/redact";
import type { ServiceDiagnostic } from "../service";
import { startUserRuntime } from "./user-runtime";
import {
  findLiveProxy,
  probeHostname,
  type LiveProxy,
} from "../server/proxy-liveness";
import type { WindowsTrayStatus } from "../tray/windows";
import { runtimeRequest } from "./runtime-api";
import type { setupOnboardUpdater } from "../update/auto-scheduler";

export const ONBOARD_USAGE = "rmx onboard [--verbose] [--json] [--no-open]";
const ONBOARD_STEPS = 3;
const DEFAULT_COMMAND_WAIT_MS = 120_000;
const REQUEST_WAIT_MS = 30_000;
const DEFAULT_PROXY_WAIT_MS = 45_000;
// Bound link creation and the short public reachability check. A Quick Tunnel
// hostname can print before its edge route answers; wait briefly so onboarding
// can open pairing when it is already live without making users sit through the
// old multi-minute propagation wait.
const DEFAULT_QUICK_TUNNEL_WAIT_MS = 60_000;
const DEFAULT_NAMED_TUNNEL_WAIT_MS = 120_000;
const DEFAULT_PUBLIC_VERIFY_WAIT_MS = 60_000;
const PUBLIC_VERIFY_POLL_MS = 500;
const CAPTURE_LIMIT = 96 * 1024;
const GATEWAY_RETRY_LIMIT = 2;
const GATEWAY_RETRY_DELAY_MS = 750;

export type OnboardOptions = {
  verbose: boolean;
  json: boolean;
  noOpen: boolean;
};

export type OnboardParseResult =
  | { ok: true; options: OnboardOptions }
  | { ok: false; message: string };

export type CapturedCommand = {
  code: number;
  stdout: string;
  stderr: string;
};

export type OnboardRemoteStatus = {
  controlEnabled: boolean;
  pairingAvailable: boolean;
  reachableAddresses?: string[];
  gateway: {
    status: "stopped" | "starting" | "ready" | "error";
    error?: string;
  };
  tunnel: {
    configuration: {
      mode: "quick" | "named";
      namedHostname?: string;
      hasNamedTunnelToken: boolean;
    };
    runtime: {
      mode: "quick" | "named";
      status: "stopped" | "starting" | "checking" | "ready" | "error";
      publicUrl: string | null;
      error: "cloudflared_unavailable" | "named_tunnel_incomplete" | "tunnel_failed" | "verification_failed" | null;
    };
  };
};

type OnboardOutput = Pick<Console, "log" | "error">;

export interface OnboardDeps {
  setupUpdater?: typeof setupOnboardUpdater;
  platform?: NodeJS.Platform;
  output?: OnboardOutput;
  codexConfigExists?: () => boolean;
  assertServiceOwnership?: () => void;
  externalProvider?: () => string | null;
  ensureConfig?: typeof ensureConfigFile;
  enableCodex?: () => CodexDesiredStateResult;
  configureAndroidRemote?: () => { mode: "quick" | "named"; hostname?: string };
  diagnoseService?: () => ServiceDiagnostic;
  runSubcommand?: (args: string[]) => Promise<CapturedCommand>;
  trayStatus?: () => Promise<WindowsTrayStatus>;
  findLive?: () => Promise<LiveProxy | null>;
  startRuntime?: () => Promise<void>;
  applyAndroidRemote?: (baseUrl: string) => Promise<OnboardRemoteStatus>;
  readAndroidRemote?: (baseUrl: string) => Promise<OnboardRemoteStatus>;
  syncCodex?: (
    port: number,
    log: Pick<Console, "log" | "error"> | null,
  ) => Promise<CodexSyncResult>;
  open?: (url: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  proxyWaitMs?: number;
  tunnelWaitMs?: number;
  publicVerifyWaitMs?: number;
  progressIntervalMs?: number;
}

export type OnboardResult = {
  automaticUpdates?: ReturnType<typeof setupOnboardUpdater>;
  ok: boolean;
  code: 0 | 1;
  completedSteps: number;
  platform: NodeJS.Platform;
  provider: string | null;
  codex: string | null;
  service: "ready" | null;
  tray: "ready" | "not-applicable" | null;
  tunnel: {
    mode: "quick" | "named";
    status: "created";
    publicUrl: string;
  } | null;
  dashboardUrl: string | null;
  connection?: { localReady: boolean; remoteReady: boolean };
  error?: string;
};

class OnboardStepError extends Error {
  constructor(
    message: string,
    readonly diagnostic?: string,
  ) {
    super(message);
    this.name = "OnboardStepError";
  }
}

function appendCaptured(current: string, value: unknown): string {
  return `${current}${String(value)}`.slice(-CAPTURE_LIMIT);
}

/** Run an existing CLI command without leaking its routine output into onboarding. */
export function runCapturedCli(args: string[], timeoutMs = DEFAULT_COMMAND_WAIT_MS): Promise<CapturedCommand> {
  return new Promise(resolve => {
    const cli = process.argv[1];
    if (!cli) {
      resolve({ code: 1, stdout: "", stderr: "Could not resolve the Remodex CLI entry point." });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({ code: 1, stdout, stderr: appendCaptured(stderr,
        "\nService setup timed out. Check 'rmx service status' before retrying; an administrator prompt may still need attention.") });
    }, timeoutMs);
    child.stdout?.on("data", chunk => { stdout = appendCaptured(stdout, chunk); });
    child.stderr?.on("data", chunk => { stderr = appendCaptured(stderr, chunk); });
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: appendCaptured(stderr, error.message) });
    });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function parseOnboardArgs(argv: string[]): OnboardParseResult {
  const options: OnboardOptions = { verbose: false, json: false, noOpen: false };
  for (const arg of argv) {
    if (arg === "--verbose") options.verbose = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-open") options.noOpen = true;
    else return { ok: false, message: `Unknown onboard option: ${arg}` };
  }
  // A machine-readable run must not launch a browser as an undocumented side effect.
  if (options.json) options.noOpen = true;
  return { ok: true, options };
}

function platformLabel(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform;
}

function safeTerminalValue(value: string): string {
  return redactSecretString(value)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 96);
}

function gatewayErrorDetail(value: string | undefined): string {
  let detail = value?.trim() ?? "";
  const prefix = "Could not start the Android Remote gateway";
  while (new RegExp(`^${prefix}(?::|\\s|$)`, "iu").test(detail)) {
    detail = detail.slice(prefix.length).replace(/^:\s*/u, "").trim();
  }
  return detail;
}

function defaultConfigureAndroidRemote(): { mode: "quick" | "named"; hostname?: string } {
  const store = createAndroidRemoteStore();
  const current = store.read();
  const state = current.settings.controlEnabled && current.settings.localNetworkEnabled === true
    ? current
    : store.updateSettings({ controlEnabled: true, localNetworkEnabled: true });
  return {
    mode: state.settings.tunnelMode,
    ...(state.settings.tunnelMode === "named" && state.settings.namedTunnelHostname
      ? { hostname: state.settings.namedTunnelHostname }
      : {}),
  };
}

async function defaultApplyAndroidRemote(baseUrl: string): Promise<OnboardRemoteStatus> {
  return runtimeRequest<OnboardRemoteStatus>("/api/android-remote/settings", {
    method: "PUT",
    body: JSON.stringify({ controlEnabled: true, localNetworkEnabled: true }),
    signal: AbortSignal.timeout(REQUEST_WAIT_MS),
  }, { baseUrl });
}

async function defaultReadAndroidRemote(baseUrl: string): Promise<OnboardRemoteStatus> {
  return runtimeRequest<OnboardRemoteStatus>("/api/android-remote", {
    signal: AbortSignal.timeout(REQUEST_WAIT_MS),
  }, { baseUrl });
}

async function waitForLiveProxy(
  find: () => Promise<LiveProxy | null>,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => number,
  timeoutMs: number,
): Promise<LiveProxy> {
  const deadline = now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      const live = await find();
      if (live) return live;
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(500, remaining));
  } while (now() < deadline);
  throw new OnboardStepError(
    "The local Remodex server did not become ready. Check Logs & Debug or run 'rmx doctor', then retry. No background service was installed.",
    lastError instanceof Error ? lastError.message : undefined,
  );
}

function tunnelWaitMessage(status: OnboardRemoteStatus): string {
  const runtime = status.tunnel.runtime;
  if (status.gateway.status === "error") {
    const detail = gatewayErrorDetail(status.gateway.error);
    return detail
      ? `The Android gateway could not start: ${safeTerminalValue(detail)}`
      : "The Android gateway could not start.";
  }
  if (runtime.error === "named_tunnel_incomplete") {
    return "The saved custom domain needs both a hostname and connector token. Complete it in Android Remote, then retry.";
  }
  if (runtime.error === "cloudflared_unavailable") {
    return "Cloudflared could not be installed or started. Check the network connection, then retry.";
  }
  if (runtime.error === "tunnel_failed") {
    return "The Cloudflare Tunnel stopped. Retry to start it again.";
  }
  if (!status.controlEnabled || status.gateway.status !== "ready") {
    return "The local Android gateway did not become ready in time.";
  }
  return "Cloudflare did not provide a tunnel link in time. Check 'rmx doctor' for startup details, then retry.";
}

async function waitForTunnelLink(
  baseUrl: string,
  expectedMode: "quick" | "named",
  read: (baseUrl: string) => Promise<OnboardRemoteStatus>,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => number,
  timeoutMs: number,
  onTransition: (status: OnboardRemoteStatus["tunnel"]["runtime"]["status"]) => void,
  retryGateway?: () => Promise<void>,
): Promise<OnboardRemoteStatus> {
  const deadline = now() + timeoutMs;
  let lastStatus: OnboardRemoteStatus | null = null;
  let lastReadError: unknown;
  let observed: OnboardRemoteStatus["tunnel"]["runtime"]["status"] | null = null;
  let gatewayRetries = 0;
  do {
    try {
      const status = await read(baseUrl);
      lastStatus = status;
      lastReadError = null;
      if (localPairingReady(status)) return status;
      const runtime = status.tunnel.runtime;
      if (runtime.status !== observed) {
        observed = runtime.status;
        onTransition(runtime.status);
      }
      if (status.gateway.status === "error") {
        // The service can expose the main proxy before its Android listener has
        // finished starting. A failed first attempt is also recoverable when a
        // stale private app-server/socket is released a moment later. Re-run the
        // idempotent enable operation a couple of times before surfacing a hard
        // failure to the user.
        if (retryGateway && gatewayRetries < GATEWAY_RETRY_LIMIT) {
          gatewayRetries += 1;
          try {
            await retryGateway();
          } catch (error) {
            lastReadError = error;
          }
          const remainingAfterRetry = deadline - now();
          if (remainingAfterRetry <= 0) break;
          await sleep(Math.min(GATEWAY_RETRY_DELAY_MS, remainingAfterRetry));
          continue;
        }
        throw new OnboardStepError(tunnelWaitMessage(status));
      }
      if (runtime.error === "named_tunnel_incomplete"
        || runtime.error === "cloudflared_unavailable"
        || runtime.error === "tunnel_failed") {
        throw new OnboardStepError(tunnelWaitMessage(status));
      }
      // Like the manual cloudflared command, report the link when it is created.
      // A failed public check does not mean the running tunnel failed to start.
      // Do not accept a leftover URL from a stopped or restarting tunnel.
      if (runtime.mode === expectedMode
        && (runtime.status === "checking" || runtime.status === "ready"
          || (runtime.status === "error" && runtime.error === "verification_failed"))
        && typeof runtime.publicUrl === "string"
        && runtime.publicUrl.startsWith("https://")
        && status.controlEnabled
        && status.gateway.status === "ready") {
        return status;
      }
    } catch (error) {
      if (error instanceof OnboardStepError) throw error;
      lastReadError = error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(1_000, remaining));
  } while (now() < deadline);

  throw new OnboardStepError(
    lastStatus ? tunnelWaitMessage(lastStatus) : "Android Remote status could not be read from the local server.",
    lastReadError instanceof Error ? lastReadError.message : undefined,
  );
}

function localPairingReady(status: OnboardRemoteStatus): boolean {
  return status.controlEnabled && status.pairingAvailable && status.gateway.status === "ready"
    && (status.reachableAddresses ?? []).some(isAndroidRemoteLocalUrl);
}

function pairingReady(status: OnboardRemoteStatus, expectedMode: "quick" | "named"): boolean {
  return status.controlEnabled
    && status.pairingAvailable
    && status.gateway.status === "ready"
    && status.tunnel.configuration.mode === expectedMode
    && status.tunnel.runtime.mode === expectedMode
    && status.tunnel.runtime.status === "ready"
    && status.tunnel.runtime.error === null
    && typeof status.tunnel.runtime.publicUrl === "string"
    && status.tunnel.runtime.publicUrl.startsWith("https://");
}

async function waitForPublicVerification(
  baseUrl: string,
  expectedMode: "quick" | "named",
  initial: OnboardRemoteStatus,
  read: (baseUrl: string) => Promise<OnboardRemoteStatus>,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => number,
  timeoutMs: number,
): Promise<OnboardRemoteStatus> {
  if (localPairingReady(initial) || pairingReady(initial, expectedMode) || timeoutMs <= 0) return initial;
  const deadline = now() + timeoutMs;
  let current = initial;
  // The attempt bound also protects test/embedded clocks whose sleep function
  // resolves immediately; production still uses the time deadline.
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / PUBLIC_VERIFY_POLL_MS));
  for (let attempt = 0; attempt < maxAttempts && now() < deadline; attempt += 1) {
    const remaining = deadline - now();
    await sleep(Math.min(PUBLIC_VERIFY_POLL_MS, Math.max(0, remaining)));
    if (now() >= deadline && attempt + 1 >= maxAttempts) break;
    try {
      current = await read(baseUrl);
    } catch {
      continue;
    }
    if (localPairingReady(current) || pairingReady(current, expectedMode)) return current;
    if (current.gateway.status === "error") return current;
  }
  return current;
}

function failureResult(
  completedSteps: number,
  platform: NodeJS.Platform,
  provider: string | null,
  codex: string | null,
  service: "ready" | null,
  tray: "ready" | "not-applicable" | null,
  dashboardUrl: string | null,
  error: string,
): OnboardResult {
  return {
    ok: false,
    code: 1,
    completedSteps,
    platform,
    provider,
    codex,
    service,
    tray,
    tunnel: null,
    dashboardUrl,
    error,
  };
}

export async function runOnboard(
  options: OnboardOptions,
  deps: OnboardDeps = {},
): Promise<OnboardResult> {
  const platform = deps.platform ?? process.platform;
  const output = deps.output ?? console;
  const sleep = deps.sleep ?? (milliseconds => Bun.sleep(milliseconds));
  const now = deps.now ?? Date.now;
  const ensureConfig = deps.ensureConfig ?? ensureConfigFile;
  const configureAndroidRemote = deps.configureAndroidRemote ?? defaultConfigureAndroidRemote;
  const findLive = deps.findLive ?? (() => findLiveProxy());
  const applyAndroidRemote = deps.applyAndroidRemote ?? defaultApplyAndroidRemote;
  const readAndroidRemote = deps.readAndroidRemote ?? defaultReadAndroidRemote;
  const open = deps.open ?? openUrl;
  let completedSteps = 0;
  let provider: string | null = null;
  let codex: string | null = null;
  const service = null;
  const tray: "ready" | "not-applicable" | null = platform === "win32" ? null : "not-applicable";
  let dashboardUrl: string | null = null;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  const stopProgress = (): void => {
    clearInterval(progressTimer);
    progressTimer = undefined;
  };

  const begin = (step: number, title: string): void => {
    stopProgress();
    if (options.json) return;
    output.log(`[${step}/${ONBOARD_STEPS}] ${title} — please wait…`);
    const startedAt = now();
    progressTimer = setInterval(() => {
      output.log(`      ${title} · ${Math.max(1, Math.floor((now() - startedAt) / 1_000))}s elapsed. Still working; please keep this window open.`);
    }, deps.progressIntervalMs ?? 4_000);
  };
  const complete = (step: number, detail: string): void => {
    stopProgress();
    completedSteps = step;
    if (!options.json) output.log(`      ${detail}\n`);
  };

  if (!options.json) output.log("Setting up Remodex\n");

  try {
    begin(1, "Preparing this computer");
    const codexExists = (deps.codexConfigExists ?? (() => existsSync(getCodexConfigPath())))();
    if (!codexExists) {
      throw new OnboardStepError("Codex settings were not found. Open Codex once, finish sign-in, then retry.");
    }
    provider = (deps.externalProvider ?? currentExternalCodexModelProvider)();
    const bootstrap = ensureConfig();
    if (bootstrap.status === "invalid") {
      throw new OnboardStepError("Remodex config.json is malformed. It was preserved; repair it before retrying.");
    }
    codex = provider ? `${safeTerminalValue(provider)} preserved` : "Existing Codex settings preserved";
    const android = configureAndroidRemote();
    complete(1, `${platformLabel(platform)} · ${codex}${android.mode === "named" ? " · Custom domain preserved" : ""}`);

    begin(2, "Starting Remodex for your user account");
    let live = await findLive();
    if (!live) {
      await (deps.startRuntime ?? startUserRuntime)();
      live = await waitForLiveProxy(findLive, sleep, now, deps.proxyWaitMs ?? DEFAULT_PROXY_WAIT_MS);
    }
    const host = probeHostname(live.hostname);
    const displayHost = host === "127.0.0.1" ? "localhost" : host;
    const baseUrl = `http://${host}:${live.port}`;
    dashboardUrl = `http://${displayHost}:${live.port}/#android-remote/pair`;
    complete(2, "Remodex is ready. No background-service installation required.");
    begin(3, "Preparing your pairing code");
    if (!options.json) output.log(`      QR page: ${dashboardUrl}`);
    if (!options.noOpen && !options.json) {
      try {
        open(dashboardUrl);
      } catch {
        output.log("      Could not open your browser. Open the QR page above manually; setup will continue.");
      }
    }
    const initial = await applyAndroidRemote(baseUrl);
    const linked = localPairingReady(initial) || pairingReady(initial, android.mode) ? initial : await waitForTunnelLink(
      baseUrl,
      android.mode,
      readAndroidRemote,
      sleep,
      now,
      deps.tunnelWaitMs ?? (android.mode === "quick"
        ? DEFAULT_QUICK_TUNNEL_WAIT_MS
        : DEFAULT_NAMED_TUNNEL_WAIT_MS),
      state => {
        if (options.json || state === "ready" || state === "stopped") return;
        if (state === "starting") output.log("      Starting secure tunnel…");
        // The final paused summary carries the actionable error; avoid printing
        // a misleading recovery message immediately before it.
      },
      async () => {
        if (!options.json) output.log("      Android gateway did not start; retrying…");
        await applyAndroidRemote(baseUrl);
      },
    );
    if (!options.json && !localPairingReady(linked) && !pairingReady(linked, android.mode)) {
      output.log("      Verifying public connection…");
    }
    const verified = await waitForPublicVerification(
      baseUrl,
      android.mode,
      linked,
      readAndroidRemote,
      sleep,
      now,
      deps.publicVerifyWaitMs ?? DEFAULT_PUBLIC_VERIFY_WAIT_MS,
    );
    const localReady = localPairingReady(verified);
    const verifiedForPairing = pairingReady(verified, android.mode);
    if (!localReady && !verifiedForPairing) {
      throw new OnboardStepError("The phone connection is not ready yet. Keep the QR page open to see progress, or check 'rmx doctor' and retry. No usable pairing code is available yet.");
    }
    complete(3, localReady ? "Wi-Fi pairing ready" : "Public connection verified; phone pairing is available.");

    const result: OnboardResult = {
      ok: true,
      code: 0,
      completedSteps,
      platform,
      provider,
      codex,
      service,
      tray,
      tunnel: verifiedForPairing ? { mode: android.mode, status: "created", publicUrl: verified.tunnel.runtime.publicUrl! } : null,
      dashboardUrl,
      connection: { localReady, remoteReady: verifiedForPairing },
    };
    if (options.json) {
      output.log(JSON.stringify(result));
    } else {
      output.log("Ready to connect your phone.\n");
      if (localReady) output.log("1. Put your phone and computer on the same trusted Wi-Fi.");
      output.log("Open Remodex on your phone, tap Scan QR code, and scan the code on your computer.");
      output.log("Keep the QR page open until it confirms your phone is connected.\n");
      output.log(`Your QR code: ${dashboardUrl}`);
      if (verifiedForPairing) output.log(`Remote access ready: ${verified.tunnel.runtime.publicUrl}`);
      else output.log(verified.tunnel.runtime.status === "error"
        ? "You can connect over Wi-Fi now. Remote access needs attention in Advanced Settings."
        : "Remote access is getting ready in the background. You can connect over Wi-Fi now.");
      output.log("Optional: enable the background service in Advanced Settings for automatic startup and recovery.");
      output.log("Without a background service, run 'rmx onboard' again after restarting or signing out of this computer.");
      output.log("Status: rmx status");
      output.log("Help:   rmx doctor");
    }
    return result;
  } catch (error) {
    stopProgress();
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = error instanceof OnboardStepError ? error.diagnostic : undefined;
    const result = failureResult(
      completedSteps,
      platform,
      provider,
      codex,
      service,
      tray,
      dashboardUrl,
      message,
    );
    if (options.json) {
      output.log(JSON.stringify({ ...result, ...(options.verbose && diagnostic ? { diagnostic } : {}) }));
    } else {
      output.error("Setup paused\n");
      output.error(`Completed   ${completedSteps}/${ONBOARD_STEPS} steps`);
      output.error(`Issue       ${message}`);
      if (diagnostic) {
        output.error("Details");
        for (const line of diagnostic.split(/\r?\n/u)) output.error(`  ${line}`);
      }
      output.error("\nRetry: rmx onboard");
      if (!options.verbose) output.error("More:  rmx onboard --verbose");
    }
    return result;
  } finally {
    stopProgress();
  }
}

export async function runOnboardCommand(
  argv: string[],
  deps: OnboardDeps = {},
): Promise<number> {
  const parsed = parseOnboardArgs(argv);
  const output = deps.output ?? console;
  if (!parsed.ok) {
    output.error(parsed.message);
    output.error(`Usage: ${ONBOARD_USAGE}`);
    return 64;
  }
  return (await runOnboard(parsed.options, deps)).code;
}
