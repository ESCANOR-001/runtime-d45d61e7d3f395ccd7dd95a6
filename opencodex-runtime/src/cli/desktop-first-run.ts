import {
  ensureConfigFile,
  type ConfigBootstrapResult,
} from "../config";

export type DesktopConfigBootstrapOutcome =
  | { ran: false }
  | { ran: true; result: ConfigBootstrapResult };

/**
 * Persist Remodex's own safe defaults for a genuinely fresh desktop home.
 *
 * Generic CLI reads remain side-effect free. The desktop shell, however, is an
 * installed application and must have one persisted authority snapshot before
 * unattended first-launch Codex convergence can be admitted. `ensureConfigFile`
 * is no-replace: existing, malformed, or concurrently-created files survive
 * byte-for-byte, including an explicit `clientIntegrations.codex = false`.
 */
export function bootstrapDesktopConfigIfNeeded(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  bootstrap: () => ConfigBootstrapResult = ensureConfigFile,
): DesktopConfigBootstrapOutcome {
  if (env.OCX_DESKTOP !== "1") return { ran: false };
  return { ran: true, result: bootstrap() };
}
