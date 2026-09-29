import { useState, type RefObject } from "react";
import { useDataSurface } from "../data-surface";
import { useT } from "../i18n/shared";
import { IconRefresh, IconX } from "../icons";
import { EmptyState, Notice, Select } from "../ui";
import { useModalDialog, updateRegistryErrorLabel, type UpdateChannel, type UpdateCheckData } from "./dashboard-shared";

export default function Updates({ apiBase, open, onClose, triggerRef }: {
  apiBase: string;
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const t = useT();
  const [channel, setChannel] = useState<UpdateChannel>("latest");
  const dialogRef = useModalDialog(open, triggerRef);
  const resource = useDataSurface<UpdateCheckData & { checkedAt?: string }>(`connect-update:${apiBase}:${channel}`, [apiBase, channel], async signal => {
    const response = await fetch(`${apiBase}/api/update/check?tag=${channel}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]), cache: "no-store",
    });
    if (!response.ok) throw new Error("Update check failed");
    const data = await response.json() as UpdateCheckData;
    if (typeof data.currentVersion !== "string" || (data.latestVersion !== null && typeof data.latestVersion !== "string")) throw new Error("Invalid update response");
    return data;
  }, { enabled: open, isEmpty: () => false });
  const check = resource.state.data;
  const unavailable = resource.state.showError || (check && !check.latestVersion);
  return <dialog ref={dialogRef} className="modal-overlay" aria-labelledby="connect-update-title" aria-describedby="connect-update-description"
    style={{ display: open ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="modal-card">
      <div className="modal-head">
        <h3 id="connect-update-title">{t("sidebar.checkUpdate")}</h3>
        <button type="button" className="btn btn-ghost btn-icon" aria-label={t("common.close")} onClick={onClose}><IconX /></button>
      </div>
      <p id="connect-update-description" className="modal-desc">{t("connect.update.description")}</p>
      <div className="update-row">
        <span className="field-label">{t("dash.updateChannel")}</span>
        <Select value={channel} options={[{ value: "latest", label: "latest" }, { value: "preview", label: "preview" }]} onChange={value => setChannel(value as UpdateChannel)} label={t("dash.updateChannel")} portal={false} />
      </div>
      {resource.state.refreshing && <EmptyState className="update-empty" icon={<span className="spin" />} title={t("dash.updateChecking")} />}
      {unavailable && !resource.state.refreshing && <Notice tone="warn">{resource.state.showError ? t("dash.updateUnavailable") : updateRegistryErrorLabel(check?.registryError, t)}</Notice>}
      {check && !resource.state.refreshing && !resource.state.showError && <div className="update-box">
        <div className="spread">
          <div><div className="muted text-label">{t("dash.updateInstalled")}</div><div className="mono">{check.currentVersion}</div></div>
          <div><div className="muted text-label">{t("dash.updateLatest")}</div><div className="mono">{check.latestVersion ?? "—"}</div></div>
          {check.latestVersion && <span className={`badge ${check.updateAvailable ? "badge-green" : "badge-muted"}`}>{t(check.updateAvailable ? "dash.updateAvailable" : "connect.update.current")}</span>}
        </div>
        {check.checkedAt && <p className="muted">{t("dash.updateLastChecked")} {new Date(check.checkedAt).toLocaleString()}</p>}
        {check.updateAvailable && check.releaseInfo?.urgency === "urgent" && <Notice tone="warn">{t("dash.updateUrgent")} {check.releaseInfo.message}</Notice>}
        {check.releaseNotes && <section className="update-release-notes"><h4>{t("dash.updateWhatsNew", { version: check.releaseNotesVersion })}</h4><div className="update-release-notes-copy">{check.releaseNotes}</div></section>}
      </div>}
      <Notice tone="warn">{t("connect.update.checkOnly")}</Notice>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>{t("common.close")}</button>
        <button type="button" className="btn btn-primary" disabled={resource.state.refreshing} onClick={() => resource.refresh()}><IconRefresh />{t(unavailable ? "dash.updateRetry" : "dash.updateRecheck")}</button>
        <button type="button" className="btn btn-primary" disabled title={t("connect.update.checkOnly")}>{t("dash.runUpdate")}</button>
      </div>
    </div>
  </dialog>;
}
