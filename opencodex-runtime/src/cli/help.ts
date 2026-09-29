import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

type HelpEntry = {
  usage: string;
  summary: string;
  details?: string[];
};

const CANONICAL_CLI = "rmx";
const COMPATIBILITY_ALIASES = ["remodex", "opencodex", "ocx"] as const;

function canonicalCommand(value: string): string {
  // Help text contains paths such as `ocx.pid`; replace only command-shaped
  // tokens so compatibility filenames and environment names remain accurate.
  return value.replace(/\bocx(?=\s|$|[`|])/g, CANONICAL_CLI);
}

const helpEntries: Record<string, HelpEntry> = {
  onboard: {
    usage: "rmx onboard [--verbose] [--json] [--no-open]",
    summary: "Prepare this computer, start its background service, and open phone pairing in three stages.",
    details: [
      "Safe to rerun: existing providers and custom-domain tunnels are preserved.",
      "Phone pairing does not authorize changes to Codex config.toml or its model catalog.",
      "Pair on the same trusted Wi-Fi while remote access prepares in the background.",
      "Each stage shows progress; the dashboard confirms when a new phone comes online.",
      "Optional integrations, updater repair, and Windows tray setup are in Advanced Settings.",
      "--verbose shows inner command diagnostics; --json implies --no-open.",
    ],
  },
  init: { usage: "rmx init", summary: "Interactive setup for providers and Codex config injection." },
  setup: { usage: "rmx setup", summary: "Interactive setup for providers and Codex config injection (alias of init)." },
  start: { usage: "rmx start [--port <port>]", summary: "Start the proxy; Codex sync requires configuration permission." },
  stop: { usage: "rmx stop", summary: "Stop the proxy and restore native Codex config." },
  restore: {
    usage: "rmx restore [back]",
    summary: "Restore native Codex config without stopping the proxy; `restore back` re-points codex at the running proxy.",
  },
  eject: {
    usage: "rmx eject [back]",
    summary: "Restore native Codex config without stopping the proxy; `eject back` re-points codex at the running proxy.",
  },
  "recover-history": {
    usage: "rmx recover-history --legacy-openai",
    summary: "Explicitly recover pre-backup syncResumeHistory rows.",
  },
  uninstall: {
    usage: "rmx uninstall",
    summary: "Remove service/shim/config and restore native Codex.",
    details: [
      "Alias: rmx remove",
      "Config cleanup requires ownership metadata created by a fresh install; legacy or shared directories are left in place.",
    ],
  },
  remove: {
    usage: "rmx remove",
    summary: "Remove service/shim/config and restore native Codex.",
    details: [
      "Alias of: rmx uninstall",
      "Config cleanup requires ownership metadata created by a fresh install; legacy or shared directories are left in place.",
    ],
  },
  service: {
    usage: "rmx service [install|repair|start|stop|status|uninstall|remove] [--native|--scheduler]",
    summary: "Run as a background service.",
    details: [
      "With no subcommand, installs/updates and starts the background service.",
      "Use `rmx service status` to see diagnostics and log paths.",
    ],
  },
  "codex-shim": {
    usage: "rmx codex-shim <install|status|uninstall|remove>",
    summary: "Auto-start the proxy when `codex` launches.",
    details: ["Use `remove` as an alias for `uninstall`."],
  },
  tray: {
    usage: "rmx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]",
    summary: "Install and control the Windows status tray icon.",
    details: [
      "The tray starts at Windows login and provides one-click proxy controls.",
      "Tray start/stop controls the icon only; use its menu to start or stop the proxy.",
      "--no-start (install only) installs the tray without launching it immediately.",
    ],
  },
  ensure: { usage: "rmx ensure", summary: "Ensure the proxy is running and Codex config/cache are current." },
  sync: {
    usage: "rmx sync [--allow-config-change | --revoke-config-access] [--restart-codex]",
    summary: "Sync Codex settings only after explicit permission.",
    details: [
      "By default, config.toml, the native model catalog, and chat history are left untouched.",
      "--allow-config-change grants ongoing management permission for this Codex config path.",
      "--revoke-config-access removes permission without editing existing Codex files.",
      "After writing the catalog, warns if long-lived Codex app-server processes are still running.",
      "--restart-codex sends SIGTERM only to matching app-server / code-mode-host processes (may interrupt active turns).",
    ],
  },
  "sync-cache": {
    usage: "rmx sync-cache [--restart-codex]",
    summary: "Refresh Codex's model cache from the active catalog.",
    details: [
      "Warns when Codex app-server processes still hold an in-memory model list.",
      "--restart-codex sends SIGTERM only to matching app-server / code-mode-host processes (may interrupt active turns).",
    ],
  },
  status: { usage: "rmx status", summary: "Check proxy server status." },
  doctor: { usage: "rmx doctor", summary: "Diagnose environment/network issues (paths, WSL /mnt, proxy env, ChatGPT reachability)." },
  debug: {
    usage: "rmx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>",
    summary: "Show or toggle runtime provider, usage, injection, and Claude debug capture.",
    details: [
      "Provider: rmx debug provider on | off | status | reset | logs [-f]",
      "Usage JSONL: rmx debug usage on | off | status | reset | logs [-f]",
      "Env default: OCX_DEBUG=1 (legacy OCX_DEBUG_FRAMES still works)",
    ],
  },
  login: { usage: "rmx login <provider>", summary: "OAuth or API-key login for a provider." },
  logout: { usage: "rmx logout <provider>", summary: "Remove a stored provider login." },
  gui: {
    usage: "rmx gui [--update]",
    summary: "Open the Remodex dashboard; --update opens the npm package updater.",
  },
  update: {
    usage: "rmx update [--tag latest|preview]",
    summary: "Update Remodex. Preview installs stay on the preview tag unless overridden.",
    details: [
      "Automatic updates are enabled by default for global installs.",
      "Use `rmx system update auto off` to disable them, or `rmx system update auto status` to inspect the scheduler.",
    ],
  },
  provider: {
    usage: "rmx provider <list|add|edit|test|remove|show|set-default|selected|quota|presets|account-mode>",
    summary: "Non-interactive provider management.",
    details: [
      "Subcommands: list, add/edit/test/remove/show, set-default, selected, quota, presets, account-mode",
      "Registry providers are auto-configured by name. Custom providers need --adapter and --base-url.",
      "Run `rmx provider --help` for full usage and examples.",
    ],
  },
  account: {
    usage: "rmx account <list|current|use|refresh|auto-switch|priority|login|reauth|code|cancel|remove|add-key|reset-credits|main> ...",
    summary: "List and switch provider accounts and API-key pools (GUI parity).",
    details: [
      "list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).",
      "current <provider>  Show the active account or key.",
      "use <provider> <id> Switch the active credential; 'main' selects the Codex App login.",
      "refresh <provider>  Force-refresh Codex or provider quota reports.",
      "auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.",
      "priority <provider> <id|main> [first|earlier|normal|later|last|-100..100|reset]  Selection order; omit the value to read it.",
      "remove <provider> <id> --yes  Remove a stored account or key after an existence check.",
      "add-key <provider> [--label <label>]  Add a key read only from piped stdin.",
      "login/reauth/code/cancel  Run browser or manual-code auth from a headless shell.",
      "reset-credits <id|main> [--consume --yes]  Inspect or consume Codex reset credits.",
      "main <subcommand>     Manage the physical native Codex login separately from Pool routing.",
      "Switching the active account takes effect immediately; running threads move on their next request, and in-flight requests keep the account they captured.",
      "A selection-order change applies from the next unbound request and never moves a bound thread.",
    ],
  },
  models: {
    usage: "rmx models <list|live|add|edit|remove|enable|disable|provider|selected|context|shadow> ...",
    summary: "List models and manage custom (manually registered) models.",
    details: [
      "List available models from static config with no subcommand (liveModels may add more at runtime).",
      "add: register a model the provider catalog does not advertise yet.",
      "  --display-name <name>     Human label (no slashes).",
      "  --context-window <tokens> e.g. 200000.",
      "  --modalities text,image   Comma-separated (text|image|audio).",
      "remove: delete a custom model by UUID or <provider>/<modelId>.",
      "list-custom: show all custom models.",
      "Changes apply immediately to a running proxy (catalog sync).",
    ],
  },
  model: {
    usage: "rmx model <subcommand>",
    summary: "Alias of rmx models.",
  },
  combo: {
    usage: "rmx combo <list|show|set|remove> ...",
    summary: "Manage combo failover and round-robin virtual models.",
    details: ["Alias hierarchy: rmx route combo ...", "Use --targets provider/model[:weight],provider/model[:weight]."],
  },
  route: {
    usage: "rmx route combo <list|show|set|remove> ...",
    summary: "Manage routing features; combo is currently the supported routing resource.",
  },
  agent: {
    usage: "rmx agent <status|injection|effort|subagents|fallback|sidecar> ...",
    summary: "Manage headless multi-agent, roster, effort, injection, and sidecar settings.",
  },
  observe: {
    usage: "rmx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...",
    summary: "Inspect proxy requests, usage, storage, memory, and debug data.",
  },
  logs: { usage: "rmx logs [filters] [--follow] [--json|--jsonl]", summary: "Alias of rmx observe logs." },
  usage: { usage: "rmx usage [--range <7d|30d|all>] [--surface <all|codex|claude|grok>] [--json]", summary: "Alias of rmx observe usage." },
  storage: { usage: "rmx storage [--json]", summary: "Alias of rmx observe storage." },
  memory: { usage: "rmx memory [--json]", summary: "Alias of rmx observe memory." },
  access: {
    usage: "rmx access <key|endpoints|models|test> ...",
    summary: "Manage Remodex admission API keys and inspect external endpoints.",
  },
  "api-key": { usage: "rmx api-key <list|create|remove> ...", summary: "Alias of rmx access key." },
  export: {
    usage: "rmx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae> [--json] [--out <path>] [--force]",
    summary: "Print a client config (opencode, Pi, OMP, Hermes, OpenClaw, Kimi Code, Gajae Code) wired to the running proxy.",
    details: [
      "--json prints the generated document as JSON on stdout; use --out for the client's native format.",
      "--out <path> writes the native config there and refuses to replace an existing file without --force.",
      "The config never contains a real key; it carries a documented env reference or a non-secret loopback placeholder.",
      "The destination path is printed for merging by hand — rmx never writes your real client config.",
    ],
  },
  grok: { usage: "rmx grok <status|exclude|include|set|clear|apply> ...", summary: "Manage and apply the Grok Build model fence." },
  integration: { usage: "rmx integration <claude|grok|client> ...", summary: "Manage supported client integrations." },
  system: {
    usage: "rmx system <status|settings|startup|diagnostics|sync|update> ...",
    summary: "Manage headless runtime settings, startup, sync, diagnostics, and updates.",
    details: [
      "update check [--channel latest|preview]  Check the @remodex/rmx package on npm.",
      "update run [--channel latest|preview] --yes  Install the npm package update.",
      "update auto on [--channel latest|preview]  Enable the daily unattended package updater (enabled by default for global installs).",
      "update auto off                         Disable unattended package updates.",
      "update auto status                      Show scheduler, last result, and rollback information.",
      "Changelogs come from the matching GitHub Release (v<version>).",
    ],
  },
  config: {
    usage: "rmx config <show|get|set|unset|validate|export|import> ...",
    summary: "Inspect and safely modify validated Remodex configuration.",
    details: ["Secrets are masked by show/get. Import requires --yes and validates before writing."],
  },
  claude: {
    usage: "rmx claude [claude args...]",
    summary: "Launch Claude Code wired to the proxy (env injection + gateway model discovery).",
    details: [
      "Ensures the proxy is running, then execs `claude` with ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN,",
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 and model slots from config.claudeCode.",
      "Routed models appear in the native /model picker with stable claude-opus-4-8-2026MMDD slot aliases (Claude Code >= 2.1.129).",
      "Older versions: pick models via ANTHROPIC_MODEL or /model <id> directly (any string passes through).",
      "User-exported ANTHROPIC_* variables always take precedence.",
      "",
      "Claude Desktop profile:",
      "  rmx claude desktop [apply]                         Save and apply the four-family profile",
      "  rmx claude desktop show [--json]                   Show routes, families, and defaults",
      "  rmx claude desktop move <route> <family> [--default]",
      "  rmx claude desktop default <family> <route|none>",
      "  rmx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)",
      "  rmx claude desktop import <path> [--apply]         Validate and import JSON",
      "Families: opus, fable, sonnet, haiku. New routes start in opus.",
      "`none` is valid only when that family is empty.",
      "Legacy apply flags remain supported: --static, --hybrid, --discovery-only.",
      "",
      "Claude Code settings: rmx claude config <status|set> ...",
    ],
  },
  opencode: {
    usage: "rmx opencode [opencode args...]",
    summary: "Launch opencode wired to the proxy (runtime provider config).",
    details: [
      "Ensures the proxy is running, then execs `opencode` with the generated `provider.opencodex`",
      "block injected through OpenCode's inline runtime layer (`OPENCODE_CONFIG_CONTENT`). Any",
      "existing inline config in the environment is preserved and only `provider.opencodex` is",
      "overwritten for this launch.",
      "Global/project opencode.json may be read to warn about an existing provider.opencodex",
      "override; on-disk files are never modified.",
      "Routed models appear in the model picker under Remodex using the compatibility id opencodex/<provider>/<model>.",
      "Stop using `rmx opencode` and plain `opencode` behaves exactly as before.",
    ],
  },
  restart: {
    usage: "rmx restart",
    summary: "Stop the proxy and restart it (background). Equivalent to stop + ensure.",
  },
  v2: {
    usage: "rmx v2 <status|on|off|mode <v1|default|v2>|threads <n>>",
    summary: "Toggle the Codex multi_agent_v2 feature (multi-agent surface).",
    details: [
      "status                Show flag, multi-agent mode, and thread limit.",
      "on | off              Enable/disable multi_agent_v2 (catalog resyncs).",
      "mode <v1|default|v2>  Force all models to one surface, or respect upstream pins.",
      "threads <n>           Set max_concurrent_threads_per_session (integer >= 1).",
      "Flips preserve the active thread limit while moving between v1/v2 modes.",
    ],
  },
  health: {
    usage: "rmx health [--json]",
    summary: "Check proxy health. Exits 0 if healthy, 1 otherwise.",
    details: ["Use --json for structured output: {ok, pid, port}."],
  },
  ready: {
    usage: "rmx ready [--json] [--wait [--timeout <seconds>]]",
    summary: "Check post-sync readiness. Exits 0 only when ready.",
    details: [
      "Exact unauthenticated GET /readyz returns HTTP 200 when ready, or 503 with Retry-After: 1 for pending or failed.",
      "Its sanitized HTTP identity is {service, version, uptime, pid, port, status}; /healthz is separate liveness, not readiness.",
      "Default is a single identity-checked /readyz probe; old proxies without /readyz fail closed as unreachable.",
      "--wait polls until ready or timeout, but exits immediately on terminal failed (default 45s, max 300s).",
      "--timeout requires --wait and accepts a positive integer (1..300).",
      "--json emits {ready, status, pid, port}; status is one of ready|pending|failed|unreachable.",
      "Invalid or unknown arguments exit 64. Not-ready, pending, failed, timeout, and unreachable exit 1.",
    ],
  },
};

function packageVersion(): string {
  const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "unknown";
}

export function printVersion(): void {
  console.log(`Remodex ${packageVersion()}`);
}

export function printUsage(): void {
  const canonical = `Remodex (rmx) — Universal provider proxy for Codex

Usage:
  rmx                         Install/update and start the background service
  rmx onboard                 Complete first-time setup and open the phone pairing QR
  rmx setup                   Interactive setup (alias: init)
  rmx start [--port <port>]   Start the proxy (Codex sync requires permission)
  rmx stop                    Stop the proxy AND restore native Codex (plain codex works again)
  rmx restore                 Restore native Codex without stopping (alias: eject)
  rmx restore back            Re-point codex at the running proxy (undo restore)
  rmx recover-history --legacy-openai
                               Explicitly recover pre-backup syncResumeHistory rows
  rmx uninstall               Remove service/shim/config and restore native Codex (alias: remove)
  rmx service [sub]           Run as a background service (default: install/update/start)
  rmx codex-shim <sub>        Auto-start proxy when \`codex\` launches (install|status|uninstall|remove)
  rmx tray <sub>              Windows status tray (install|start|stop|status|uninstall)
  rmx ensure                  Ensure the proxy is running and Codex config/cache are current
  rmx sync [--restart-codex]  Sync Codex only with saved configuration permission
  rmx sync --allow-config-change   Explicitly allow ongoing Codex configuration changes
  rmx sync --revoke-config-access  Revoke access; leave existing Codex files unchanged
  rmx sync-cache [--restart-codex]
                              Refresh Codex's model cache from the active catalog
  rmx status                  Check proxy server status
  rmx doctor                  Diagnose environment/network issues (WSL, proxy, ChatGPT reachability)
  rmx debug <scope>           provider/usage/injection/claude on|off|status|reset
  rmx login <provider>        OAuth or API-key provider login
  rmx logout <provider>       Remove a stored OAuth login
  rmx gui                     Open the Remodex dashboard
  rmx update [--tag <tag>]    Update Remodex (keeps preview installs on @preview)
  rmx restart                  Stop and restart the proxy
  rmx v2 <sub>                multi_agent_v2 surface (status|on|off|mode|threads)
  rmx health [--json]          Check proxy health (exit 0=healthy, 1=not)
  rmx ready [--json] [--wait [--timeout <s>]]  Check post-sync readiness (exit 0 only when ready)
  rmx provider <sub>          Providers, connectivity, quota, and selected models
  rmx account <sub>           Accounts, login/reauth, key pools, and quota controls
  rmx models <sub>            Live/custom models, visibility, context, and shadow calls
  rmx combo <sub>             Combo failover/round-robin routing
  rmx agent <sub>             Subagents, injection, effort caps, and sidecars
  rmx observe <sub>           Logs, usage, storage, memory, and debug data
  rmx access <sub>            External API keys and endpoint information
  rmx export --client <id>    Print a client config wired to the running proxy (7 clients)
  rmx integration client <sub> Enable, disable, inspect or roll back a client integration
  rmx grok <sub>              Grok Build model selection and apply
  rmx system <sub>            Runtime settings, startup, sync, diagnostics, and updates
  rmx config <sub>            Validated configuration show/get/set/import/export
  rmx claude [args...]        Launch Claude Code wired to the proxy (model discovery on)
  rmx claude desktop [sub]    Manage and apply Claude Desktop's four-family profile
  rmx opencode [args...]      Launch opencode wired to the proxy (runtime provider config)
  rmx help [command]          Show help
  rmx --version | -v          Print version

Examples:
  rmx                        Install/update and start the background service
  rmx onboard                Start the service and pair your Android phone
  rmx init                    Set up provider and inject into Codex
  rmx start                   Start on default port (10100)
  rmx start --port 8080       Start on custom port
  rmx help service            Show service command help
  rmx sync                    Sync available models to Codex`;
  console.log(`${canonical}

Compatibility aliases: ${COMPATIBILITY_ALIASES.join(", ")}
These aliases accept the same commands as rmx.`);
}

export function hasHelpFlag(values: string[]): boolean {
  return values.some(value => value === "--help" || value === "-h" || value === "help");
}

export function printSubcommandUsage(name: string | undefined): void {
  const entry = name ? helpEntries[name] : undefined;
  if (!entry) {
    console.error(`Unknown command: ${name ?? ""}`.trim());
    printUsage();
    process.exit(1);
  }
  const canonicalUsage = canonicalCommand(entry.usage);
  console.log(`Usage: ${canonicalUsage}\n\n${canonicalCommand(entry.summary)}`);
  if (entry.details?.length) {
    console.log(`\n${entry.details.map(canonicalCommand).join("\n")}`);
  }
}
