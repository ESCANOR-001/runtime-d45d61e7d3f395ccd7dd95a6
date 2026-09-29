import { useRef, useState } from "react";
import { useDataSurface } from "../data-surface";
import { useT } from "../i18n/shared";
import { Notice } from "../ui";

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
  const running = useRef(false);
  const resource = useDataSurface<ServiceStatus>(`connect-service:${apiBase}`, [apiBase], async signal => {
    const response = await fetch(`${apiBase}/api/connect/service`, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: "no-store" });
    if (!response.ok) throw new Error("Service status unavailable");
    const data = await response.json() as ServiceStatus;
    if (!data || [data.supported, data.installed, data.healthy, data.canManage].some(value => typeof value !== "boolean")
      || !["idle", "running", "indeterminate", "blocked", "failed"].includes(data.operation)) throw new Error("Invalid service status");
    return data;
  }, { pollMs: 5_000, isEmpty: () => false });
  const status = resource.state.data;
  const busy = pending || (!!status && !["idle", "failed"].includes(status.operation));
  const act = async () => {
    if (running.current || busy || !status?.canManage || resource.state.showError || resource.state.refreshing) return;
    if (!window.confirm(t("advanced.confirm"))) return;
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
  return <div className="native-activity">
    <h2>{t("advanced.title")}</h2>
    <p className="page-sub">{t("advanced.description")}</p>
    <section className="panel" aria-labelledby="advanced-service-title" aria-busy={busy}>
      <h3 id="advanced-service-title">{t("advanced.service")}</h3>
      <p>{t("advanced.serviceDescription")}</p>
      <Notice tone="warn">{t("advanced.optional")}</Notice>
      <p>{t("advanced.permissions")}</p>
      <div role="status" aria-live="polite">
        {pending ? t("advanced.working") : resource.state.refreshing ? t("advanced.checking")
          : resource.state.showError ? t("advanced.error") : !status ? t("advanced.checking")
          : status.operation === "failed" ? t("advanced.uncertain") : status.operation !== "idle" ? t("advanced.pending") : status.healthy ? t("advanced.enabled")
          : status.installed ? t("advanced.needsRepair") : t("advanced.notInstalled")}
      </div>
      {status && !status.canManage && !status.healthy && <Notice tone="warn">{t("advanced.unavailable")}</Notice>}
      {uncertain && <Notice tone="warn">{t("advanced.uncertain")}</Notice>}
      <div className="native-activity-toolbar">
        <button type="button" className="btn btn-primary" disabled={busy || status?.healthy || !status?.canManage || resource.state.refreshing || resource.state.showError} onClick={() => { void act(); }}>
          {t(status?.healthy ? "advanced.enabled" : status?.installed ? "advanced.repair" : "advanced.install")}
        </button>
        <button type="button" className="btn btn-ghost" disabled={resource.state.refreshing || pending} onClick={() => resource.refresh()}>{t("native.refresh")}</button>
      </div>
      <p>{t("advanced.diagnostics")} <code>rmx service status</code></p>
    </section>
  </div>;
}
