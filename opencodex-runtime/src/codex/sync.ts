import { currentExternalCodexModelProvider, injectCodexConfig } from "./inject";
import { printProjectCodexConfigWarnings, groupProjectCodexConfigWarningsByPath, type ProjectCodexConfigWarning } from "./project-config-warnings";
import { refreshCodexModelCatalog } from "./refresh";
import { applyProxyEnv, ensureConfigFile, loadConfig } from "../config";
import type { OcxConfig } from "../types";
import { collectOrcaCodexHomeDiagnostic } from "./home";
import { summarizeComboCatalogOmissions, type ComboCatalogOmission } from "./catalog/aggregation";
import { shouldSyncCodexOnStart } from "./desired-state";
import { admitCodexWrite, type CodexAdmission } from "./admission";
import {
  adoptCurrentCodexLbProvider,
  CODEX_LB_PROVIDER_ID,
} from "./provider-adoption";
import { hydrateProviderEnvironment } from "../lib/provider-environment";
import { canManageCodexConfig, CODEX_CONFIG_PERMISSION_MESSAGE } from "./config-permission";

export interface CodexSyncResult {
  /** `skipped` is policy truth, never evidence that Codex was written. */
  status: "applied" | "skipped" | "refused";
  ok: boolean;
  skippedReason?: "desired_disabled" | "permission_required";
  /** Present when unattended convergence refused another service's native home. */
  authority?: "service-home";
  added: number;
  catalogPath: string | null;
  catalogExists: boolean;
  catalogWritten: boolean;
  cacheSynced: boolean;
  /** Whether plain Codex routing in config.toml is owned by Remodex. */
  routingApplied?: boolean;
  message: string;
  warning?: string;
  comboOmissions?: ComboCatalogOmission[];
  nativeSubagentDefaultsWarning?: string;
  projectConfigWarnings?: ProjectCodexConfigWarning[];
  projectConfigGrouped?: { path: string; issues: string[]; bypass: string }[];
}

export interface CodexSyncOptions {
  /** Explicitly replace active Codex routing for a confirmed dashboard sync. */
  takeoverExistingRouting?: boolean;
}

type CodexSyncAdmission = Extract<CodexAdmission, { kind: "refused" }> | { readonly kind: "admitted" };

interface CodexSyncDeps {
  refreshCodexModelCatalog: typeof refreshCodexModelCatalog;
  injectCodexConfig: typeof injectCodexConfig;
  /** The sync entry only needs this admission's service-home verdict. */
  admitCodexWrite?: () => CodexSyncAdmission;
  currentExternalCodexModelProvider?: typeof currentExternalCodexModelProvider;
  collectCodexHomeDiagnostic?: typeof collectOrcaCodexHomeDiagnostic;
  adoptCurrentCodexLbProvider?: typeof adoptCurrentCodexLbProvider;
  hydrateProviderEnvironment?: typeof hydrateProviderEnvironment;
}

const defaultDeps: CodexSyncDeps = {
  refreshCodexModelCatalog,
  injectCodexConfig,
};

function reportCodexHomeTarget(
  log: Pick<Console, "log" | "error"> | null,
  collectDiagnostic: typeof collectOrcaCodexHomeDiagnostic,
): void {
  if (!log) return;
  const target = collectDiagnostic();
  log.log(`   Target Codex home: ${target.effectiveCodexHome}`);
  if (target.warning) {
    log.error(`WARNING: ${target.warning}`);
    log.error(`Action: ${target.action}`);
  }
}

export async function syncModelsToCodex(
  port?: number,
  config: OcxConfig = loadConfig(),
  log: Pick<Console, "log" | "error"> | null = console,
  deps: CodexSyncDeps = defaultDeps,
  options: CodexSyncOptions = {},
): Promise<CodexSyncResult> {
  // `config` can be the server's startup object. The decision, however, is a
  // durable user switch and must be read again at this production boundary: a
  // PUT OFF while provider discovery is in flight cannot be allowed to commit
  // through an older captured object.
  const persistedBeforeBootstrap = loadConfig();
  if (!canManageCodexConfig(persistedBeforeBootstrap)) {
    return {
      status: "skipped", skippedReason: "permission_required", ok: true, added: 0,
      catalogPath: null, catalogExists: false, catalogWritten: false, cacheSynced: false,
      routingApplied: false, message: CODEX_CONFIG_PERMISSION_MESSAGE,
    };
  }
  if (!shouldSyncCodexOnStart(persistedBeforeBootstrap)) {
    return {
      status: "skipped",
      skippedReason: "desired_disabled",
      ok: true,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      message: "Codex integration is OFF; no Codex config, catalog, cache, or history was changed.",
    };
  }

  // A fresh install has no Remodex config for admission/provider adoption to
  // read. Bootstrap only for the one safe import path that needs it: an active
  // Codex Desktop `codex-lb` provider. Other syncs (including diagnostics and
  // ambiguous native-default checks) must retain the old read-only refusal for
  // a missing config. Existing and malformed files are always preserved.
  const externalProvider = (() => {
    try {
      return (deps.currentExternalCodexModelProvider ?? currentExternalCodexModelProvider)();
    } catch {
      // Let the normal admission/inject path surface the actionable parse/read
      // error. A probe must never turn a diagnostic into a bootstrap write.
      return null;
    }
  })();
  if (externalProvider === CODEX_LB_PROVIDER_ID) {
    try {
      const bootstrap = ensureConfigFile();
      if (bootstrap.status === "created") {
        // The caller may have captured `loadConfig()` before the file was
        // published. Use the exact persisted defaults for this convergence pass
        // so provider adoption/catalog collection cannot run on a stale snapshot.
        config = loadConfig();
      }
    } catch (error) {
      const message = `Could not initialize the Remodex provider config: ${error instanceof Error ? error.message : String(error)}`;
      log?.error(message);
      return {
        status: "refused",
        ok: false,
        added: 0,
        catalogPath: null,
        catalogExists: false,
        catalogWritten: false,
        cacheSynced: false,
        message,
      };
    }
  }

  // Catalog gathering precedes injection and can itself write the native
  // catalog/cache. It therefore needs the same unattended service-home veto as
  // the injector, before it gets a chance to create any artifact.
  const admission = (deps.admitCodexWrite ?? admitCodexWrite)();
  if (admission.kind === "refused" && admission.authority === "service-home") {
    return {
      status: "refused",
      authority: "service-home",
      ok: false,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      message: admission.message,
    };
  }
  const p = port ?? config.port ?? 10100;
  // Desktop shells and background services may not inherit the user's interactive
  // environment. Resolve only the `${NAME}` references present in this config before
  // model discovery; the resolver mutates process.env in memory and never rewrites config.
  const hydrateEnvironment = deps.hydrateProviderEnvironment ?? hydrateProviderEnvironment;
  hydrateEnvironment(config);
  if (externalProvider === CODEX_LB_PROVIDER_ID) {
    const adoption = (deps.adoptCurrentCodexLbProvider ?? adoptCurrentCodexLbProvider)(config);
    if (adoption.kind === "adopted" || adoption.kind === "already-managed") {
      // Adoption can add a new env_key reference to a fresh Remodex config. Run the
      // same allowlisted lookup again so the first sync can use that key immediately.
      hydrateEnvironment(config);
      log?.log(adoption.kind === "adopted"
        ? "   + Imported Codex Desktop codex-lb metadata into Remodex (credential remains an environment reference)."
        : "   Codex Desktop codex-lb metadata is already managed by Remodex.");
    }
  }

  applyProxyEnv(config); // `rmx ensure`/`rmx sync` fetch provider models outside the server process
  let added = 0;
  let catalogPath: string | null = null;
  let catalogPathForInjection: string | null | undefined;
  let catalogExists = false;
  let catalogWritten = false;
  let cacheSynced = false;
  let warning: string | undefined;
  let comboOmissions: ComboCatalogOmission[] = [];

  try {
    const cat = await deps.refreshCodexModelCatalog(config);
    added = cat.added;
    catalogExists = cat.catalogExists;
    catalogWritten = cat.catalogWritten;
    cacheSynced = cat.cacheSynced;
    catalogPathForInjection = cat.catalogExists ? cat.path : null;
    catalogPath = catalogPathForInjection;
    comboOmissions = cat.comboOmissions ?? [];
    if (cat.added > 0) {
      log?.log(`   + ${cat.added} models appended to Codex catalog (${cat.path})`);
    } else if (!cat.catalogExists) {
      warning = "catalog sync skipped: no Codex catalog source found; keeping Codex's native catalog.";
      log?.error(warning);
    }
    if (comboOmissions.length > 0) {
      // Individual omission lines already went through console.warn during gather;
      // keep a single summary on the sync logger to avoid duplicate stderr noise.
      const summary = summarizeComboCatalogOmissions(comboOmissions);
      log?.error(summary);
      warning = warning ? `${warning} ${summary}` : summary;
    }
  } catch (e) {
    warning = `catalog sync skipped: ${e instanceof Error ? e.message : String(e)}`;
    log?.error(warning);
  }

  const result = await deps.injectCodexConfig(p, config, {
    catalogPath: catalogPathForInjection,
    takeoverExistingRouting: options.takeoverExistingRouting,
  });
  if (result.status === "skipped") {
    return {
      status: "skipped",
      skippedReason: result.skippedReason === "permission_required" ? "permission_required" : "desired_disabled",
      ok: true,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      message: result.message,
    };
  }
  log?.log(result.message);
  reportCodexHomeTarget(log, deps.collectCodexHomeDiagnostic ?? collectOrcaCodexHomeDiagnostic);
  const projectConfigWarnings = printProjectCodexConfigWarnings(log, { cwd: process.cwd() });
  return {
    status: "applied",
    ok: result.success,
    added,
    catalogPath,
    catalogExists,
    catalogWritten,
    cacheSynced,
    ...(result.routingApplied !== undefined ? { routingApplied: result.routingApplied } : {}),
    message: result.message,
    ...(warning ? { warning } : {}),
    ...(comboOmissions.length > 0 ? { comboOmissions } : {}),
    ...(result.nativeSubagentDefaultsWarning ? { nativeSubagentDefaultsWarning: result.nativeSubagentDefaultsWarning } : {}),
    ...(projectConfigWarnings.length > 0 ? {
      projectConfigWarnings,
      projectConfigGrouped: groupProjectCodexConfigWarningsByPath(projectConfigWarnings),
    } : {}),
  };
}
