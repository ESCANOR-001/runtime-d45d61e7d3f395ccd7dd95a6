import { useCallback, useEffect, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { useI18n } from "../i18n/shared";
import { Switch } from "../ui";

type Status = { connection?: { connectedSessions: number; verificationRequiredSessions: number; verificationIssue: 'device-verification' | 'sign-in' | null; desktopVerification: 'unconfirmed' }; autoConnect?: { preference: boolean | null; blockedByUserSettings: boolean; desktopPreference?: 'on' | 'off' | 'default' | 'unknown'; error: string | null }; enabled: boolean; ready: boolean; installed: boolean; error: string | null; activeSessions: number; desktopSync?: boolean; connectedSessions?: number; account: { subscriptionType?: string }; binary: string };

export function ManagedClaudeCodeCard({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [binary, setBinary] = useState("");
  const desktopSetupNeeded = status?.autoConnect?.desktopPreference === "off";
  const automaticConnectionSummary = () => {
    const settings = status?.autoConnect;
    if (!status) return null;
    if (settings?.error) return settings.error;
    if (settings?.blockedByUserSettings) return t("managedClaude.autoConnectBlocked");
    if (desktopSetupNeeded) return null;
    if (settings?.desktopPreference === "on") return t("managedClaude.desktopOn");
    if (settings?.desktopPreference !== "default") return t("managedClaude.desktopUnknown");
    if (settings.preference === true) return t("managedClaude.autoConnectOn");
    if (settings.preference === false) return t("managedClaude.autoConnectOff");
    return t("managedClaude.autoConnectDefault");
  };
  const request = useCallback(async (body?: object) => {
    setBusy(true); setError("");
    try {
      const result = await readJsonOrThrow<Status>(await fetch(`${apiBase}/api/android-remote/claude-code${body ? "" : "?refresh=1"}`, {
        method: body ? "PUT" : "GET", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      }));
      if (result && typeof result.enabled === "boolean") { setStatus(result); setBinary(result.binary); }
    } catch (e) { setError(e instanceof Error ? e.message : t("managedClaude.error")); }
    finally { setBusy(false); }
  }, [apiBase, t]);
  useEffect(() => { const timer = window.setTimeout(() => { void request(); }, 0); return () => window.clearTimeout(timer); }, [request]);
  return <section className="android-remote-section" aria-labelledby="managed-claude-heading">
    <div className="android-remote-section-heading"><h3 id="managed-claude-heading">{t("agents.settings")}</h3></div>
    <div className="android-remote-settings-card" aria-busy={busy}>
      <div className="android-remote-setting-row">
        <div><strong>{t("managedClaude.enable")}</strong><p>{t("managedClaude.description")}</p></div>
        <Switch on={status?.enabled ?? false} disabled={busy || !status} onClick={() => void request({ enabled: !status?.enabled })} label={t("managedClaude.enable")} />
      </div>
      <div className="android-remote-setting-row">
        <div><strong>{t("managedClaude.desktopSync")}</strong><p>{t("managedClaude.desktopSyncDescription")}</p>
          {status?.desktopSync && <p>{t("managedClaude.desktopSyncLimit")}</p>}
        </div>
        <Switch on={status?.desktopSync ?? false} disabled={busy || !status?.enabled} onClick={() => void request({ desktopSync: !status?.desktopSync })} label={t("managedClaude.desktopSync")} />
      </div>
      <div className="android-remote-setting-row">
        <div><strong>{t("managedClaude.autoConnect")}</strong><p>{t("managedClaude.autoConnectDescription")}</p>
          {desktopSetupNeeded && <div role="status" className="agent-setup-warning">
            <strong>{t("managedClaude.desktopSetupNeeded")}</strong>
            <p>{t("managedClaude.desktopOff")}</p>
            <p>{t("managedClaude.desktopSetupSteps")}</p>
            <p>{t("managedClaude.desktopSetupScope")}</p>
          </div>}
          <p>{automaticConnectionSummary()}</p>
          {!desktopSetupNeeded && <p>{t("managedClaude.autoConnectOverride")}</p>}
        </div>
        <Switch on={status?.autoConnect?.preference === true} disabled={busy || !status?.autoConnect || Boolean(status.autoConnect.error) || (status.autoConnect.blockedByUserSettings && status.autoConnect.preference !== true)} onClick={() => void request({ autoConnectNewSessions: status?.autoConnect?.preference !== true })} label={t("managedClaude.autoConnect")} />
      </div>
      <div className="agent-setting-copy agent-account"><div>
        <strong>{t("agents.account")}</strong>
        <p>{!status ? t(error ? "managedClaude.error" : "agents.checking") : status.ready ? t("managedClaude.pcSignedIn") : t("managedClaude.setup")}</p>
        {status && !status.ready && <code>claude auth login</code>}
        {status?.account?.subscriptionType && <p>{status.account.subscriptionType}</p>}
      </div><button type="button" className="btn" disabled={busy} onClick={() => void request()}>{t("managedClaude.checkAgain")}</button></div>
      {status?.enabled && status.desktopSync && <div className="agent-setting-copy" aria-live="polite">
        <strong>{t("managedClaude.connectionTitle")}</strong>
        <p>{status.connection ? t("managedClaude.connections", { count: status.connection.connectedSessions }) : t("managedClaude.connectionUnknown")}</p>
        {status.connection?.verificationIssue && <div role="alert" className="agent-setup-warning">
          <strong>{t(status.connection.verificationIssue === 'device-verification' ? "managedClaude.verificationRequired" : "managedClaude.signInRequired")}</strong>
          <p>{t(status.connection.verificationIssue === 'device-verification' ? "managedClaude.verifySteps" : "managedClaude.signInSteps")}</p>
          <p>{t("managedClaude.verifyRetry")}</p>
        </div>}
        <strong>{t("managedClaude.verificationUnknown")}</strong>
        <p>{t("managedClaude.verificationScope")}</p>
        <p>{t("managedClaude.verificationRepeated")}</p>
      </div>}
      <details className="agent-advanced">
        <summary>{t("agents.advanced")}</summary>
        <p>{t("agents.pathHint")}</p>
        <label className="android-remote-cloudflare-field"><span>{t("managedClaude.binary")}</span><input value={binary} onChange={e => setBinary(e.target.value)} disabled={busy} autoCapitalize="none" spellCheck={false} /></label>
        <button type="button" className="btn" disabled={busy || !status} onClick={() => void request({ binary })}>{t("managedClaude.save")}</button>
        <p>{t("managedClaude.ownership")}</p>
      </details>
      {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    </div>
  </section>;
}
