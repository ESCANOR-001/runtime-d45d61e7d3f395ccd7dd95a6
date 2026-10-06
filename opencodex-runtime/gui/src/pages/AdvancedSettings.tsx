import { useEffect, useRef, useState } from "react";
import { useDataSurface } from "../data-surface";
import { useT } from "../i18n/shared";
import { Notice } from "../ui";
import { IconRefresh } from "../icons";
import "./advanced-settings.css";

type ServiceStatus = {
  platform: string;
  supported: boolean;
  installed: boolean;
  healthy: boolean;
  canManage: boolean;
  operation: "idle" | "running" | "indeterminate" | "blocked" | "failed";
};

export default function AdvancedSettings({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const confirmationWasOpen = useRef(false);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (confirmationWasOpen.current) actionRef.current?.focus();
    confirmationWasOpen.current = confirming;
  }, [confirming]);
  const running = useRef(false);
  const resource = useDataSurface<ServiceStatus>(`connect-service:${apiBase}`, [apiBase], async signal => {
    const response = await fetch(`${apiBase}/api/connect/service`, { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]), cache: "no-store" });
    if (!response.ok) throw new Error("Service status unavailable");
    const data = await response.json() as ServiceStatus;
    if (!data || [data.supported, data.installed, data.healthy, data.canManage].some(value => typeof value !== "boolean")
      || !["idle", "running", "indeterminate", "blocked", "failed"].includes(data.operation)) throw new Error("Invalid service status");
    return data;
  }, { pollMs: 15_000, isEmpty: () => false });
  const status = resource.state.data;
  const failed = resource.error !== undefined && resource.error !== null;
  const busy = pending || (!!status && !["idle", "failed"].includes(status.operation));
  const act = async () => {
    if (!confirming || running.current || busy || !status?.canManage || failed) return;
    setConfirming(false);
    running.current = true;
    setPending(true);
    setUncertain(false);
    try {
      const response = await fetch(`${apiBase}/api/connect/service`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: status.installed ? "repair" : "install", confirm: true }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok || (await response.json()).ok !== true) throw new Error("Service action not confirmed");
    } catch { setUncertain(true); }
    finally { running.current = false; setPending(false); resource.refresh(); }
  };
  return <div className="advanced-settings">
    <header className="advanced-settings-heading">
      <h2>{t("advanced.title")}</h2>
      <p className="page-sub">{t("advanced.description")}</p>
    </header>
    <section className="panel advanced-service-card" aria-labelledby="advanced-service-title" aria-busy={busy}>
      <div className="advanced-service-heading">
        <h3 id="advanced-service-title">{t("advanced.service")}</h3>
        <p>{t("advanced.serviceDescription")}</p>
      </div>
      <div className="advanced-service-status" data-tone={failed || status?.operation === "failed" ? "error" : status?.healthy ? "success" : "neutral"} role="status" aria-live="polite">
        <span className="advanced-service-indicator" aria-hidden="true" />
        <p>{pending ? t("advanced.working")
          : failed ? t("advanced.error") : !status ? t("advanced.checking")
          : status.operation === "failed" ? t("advanced.uncertain") : status.operation !== "idle" ? t("advanced.pending") : status.healthy ? t("advanced.enabled")
          : status.installed ? t("advanced.needsRepair") : t("advanced.notInstalled")}</p>
      </div>
      {status && !status.canManage && !status.healthy && <Notice tone="warn">{t("advanced.unavailable")}</Notice>}
      {uncertain && !status?.healthy && <Notice tone="warn">{t("advanced.uncertain")}</Notice>}
      {confirming && <div className="advanced-service-confirm" role="group" aria-label={t("advanced.confirm")} onKeyDown={event => { if (event.key === "Escape") setConfirming(false); }}>
        <p>{t("advanced.confirm")}</p>
        <div className="advanced-service-actions">
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !status?.canManage || failed} onClick={() => { void act(); }}>{t(status?.installed ? "advanced.repair" : "advanced.install")}</button>
        </div>
      </div>}
      <div className="advanced-service-actions">
        {!confirming && <button ref={actionRef} type="button" className="btn btn-primary" disabled={busy || status?.healthy || !status?.canManage || failed} onClick={() => setConfirming(true)}>
          {t(status?.healthy ? "advanced.enabled" : status?.installed ? "advanced.repair" : "advanced.install")}
        </button>}
        <button type="button" className="btn btn-ghost" disabled={resource.state.refreshing || pending} onClick={() => resource.refresh()}><IconRefresh />{t("native.refresh")}</button>
      </div>
      <div className="advanced-service-help">
        <p>{t("advanced.optional")}</p>
        <p>{t("advanced.permissions")}</p>
      </div>
      <footer className="advanced-service-diagnostics"><span>{t("advanced.diagnostics")}</span><code>rmx service status</code></footer>
    </section>
  </div>;
}
