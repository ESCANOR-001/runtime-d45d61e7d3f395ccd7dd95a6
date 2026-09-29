import { useEffect, useState } from "react";
import { useDataSurface } from "../data-surface";
import { useI18n, useT } from "../i18n/shared";
import { Notice } from "../ui";
import { formatTokens } from "../format-tokens";
import DesktopLogs from "./DesktopLogs";
import { logsTabKeyDown, readTabFromHash, selectLogsTab, type LogsTab } from "./logs-tab-keydown";
import "../styles-native-activity.css";

interface NativeRow {
  id: string;
  thread: string;
  at: number;
  model: string;
  state: "running" | "completed" | "interrupted" | "unknown";
  input: number;
  output: number;
  cached: number;
  measured: boolean;
}

interface NativeReport {
  source: "native-codex";
  generatedAt: number;
  rows: NativeRow[];
  usage: Array<{ day: string; model: string; turns: number; input: number; output: number; cached: number }>;
  diagnostics: { files: number; pendingFiles: number; skippedRecords: number; unreadableFiles: number; limited: boolean; missingHome: boolean; configReadOnly: boolean };
}

function NativeReportView({ apiBase, view }: { apiBase: string; view: "logs" | "debug" | "usage" }) {
  const { t, locale } = useI18n();
  const [range, setRange] = useState("30");
  const resource = useDataSurface<NativeReport>(`native-activity:${apiBase}`, [apiBase], async signal => {
    const response = await fetch(`${apiBase}/api/connect/activity`, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json() as NativeReport;
    if (data.source !== "native-codex" || !Array.isArray(data.rows) || !Array.isArray(data.usage) || !data.diagnostics) throw new Error("Invalid native activity response");
    return data;
  }, { pollMs: 5_000, isEmpty: () => false });
  const report = resource.state.data;
  const cutoff = range === "all" || !report ? "" : new Date(report.generatedAt - (Number(range) - 1) * 86_400_000).toISOString().slice(0, 10);
  const usage = report?.usage.filter(row => row.day >= cutoff) ?? [];
  const totals = usage.reduce((total, row) => ({ turns: total.turns + row.turns, input: total.input + row.input, output: total.output + row.output, cached: total.cached + row.cached }), { turns: 0, input: 0, output: 0, cached: 0 });

  return <div className="native-activity">
    <p className="page-sub">{t("native.subtitle")}</p>
    <div className="native-activity-toolbar">
      <span role="status" aria-live="polite">{resource.state.refreshing ? t("native.loading") : report ? t("native.updated", { value: new Date(report.generatedAt).toLocaleString() }) : resource.state.showError ? t("native.error") : t("native.loading")}</span>
      <button type="button" className="btn btn-ghost btn-sm" disabled={resource.state.refreshing} onClick={() => resource.refresh()}>{t("native.refresh")}</button>
    </div>
    {resource.state.showError && <Notice tone="err">{t("native.error")}</Notice>}
    {report?.diagnostics.missingHome && <Notice tone="warn">{t("native.missing")}</Notice>}
    {report && (report.diagnostics.limited || report.diagnostics.pendingFiles > 0 || report.diagnostics.skippedRecords > 0 || report.diagnostics.unreadableFiles > 0) && <Notice tone="warn">{t("native.partial")}</Notice>}
    {report && view === "debug" && <>
      <p>{t("native.debugHint")}</p>
      <dl className="native-metrics">
        <div><dt>{t("native.files")}</dt><dd>{report.diagnostics.files}</dd></div>
        <div><dt>{t("native.pending")}</dt><dd>{report.diagnostics.pendingFiles}</dd></div>
        <div><dt>{t("native.skipped")}</dt><dd>{report.diagnostics.skippedRecords}</dd></div>
        <div><dt>{t("native.unreadable")}</dt><dd>{report.diagnostics.unreadableFiles}</dd></div>
      </dl>
      <Notice tone="ok">{t("native.readOnly")}</Notice>
    </>}
    {report && view === "logs" && <>
      <h3>{t("native.activity")}</h3>
      <p className="muted">{t("native.activityHint")}</p>
      {!report.rows.length ? <p>{t("native.empty")}</p> : <div className="native-table-wrap"><table className="native-table">
        <thead><tr><th>{t("logs.col.time")}</th><th>{t("logs.col.model")}</th><th>{t("logs.col.status")}</th><th>{t("logs.tokens.input")}</th><th>{t("logs.tokens.output")}</th><th>{t("logs.tokens.cacheRead")}</th></tr></thead>
        <tbody>{report.rows.map(row => <tr key={row.id}>
          <td><time dateTime={new Date(row.at).toISOString()}>{new Date(row.at).toLocaleString()}</time></td>
          <td>{row.model}</td>
          <td>{t(row.state === "running" && report.generatedAt - row.at > 120_000 ? "native.state.unknown" : `native.state.${row.state}`)}</td>
          <td>{row.measured ? formatTokens(row.input, locale) : "—"}</td><td>{row.measured ? formatTokens(row.output, locale) : "—"}</td><td>{row.measured ? formatTokens(row.cached, locale) : "—"}</td>
        </tr>)}</tbody>
      </table></div>}
    </>}
    {report && view === "usage" && <>
      <label className="native-range">{t("native.range")} <select value={range} onChange={event => setRange(event.target.value)}>
        <option value="7">{t("usage.range.7d")}</option><option value="30">{t("usage.range.30d")}</option><option value="all">{t("usage.range.available")}</option>
      </select></label>
      <p className="muted">{t("native.usageHint")}</p>
      <dl className="native-metrics">
        <div><dt>{t("native.turns")}</dt><dd>{totals.turns}</dd></div>
        <div><dt>{t("logs.tokens.input")}</dt><dd>{formatTokens(totals.input, locale)}</dd></div>
        <div><dt>{t("logs.tokens.output")}</dt><dd>{formatTokens(totals.output, locale)}</dd></div>
        <div><dt>{t("logs.tokens.cacheRead")}</dt><dd>{formatTokens(totals.cached, locale)}</dd></div>
      </dl>
      {!usage.length ? <p>{t("native.empty")}</p> : <div className="native-table-wrap"><table className="native-table">
        <thead><tr><th>{t("logs.col.time")}</th><th>{t("logs.col.model")}</th><th>{t("native.turns")}</th><th>{t("logs.tokens.input")}</th><th>{t("logs.tokens.output")}</th></tr></thead>
        <tbody>{usage.map(row => <tr key={`${row.day}:${row.model}`}><td>{row.day}</td><td>{row.model}</td><td>{row.turns}</td><td>{formatTokens(row.input, locale)}</td><td>{formatTokens(row.output, locale)}</td></tr>)}</tbody>
      </table></div>}
    </>}
  </div>;
}

export function NativeLogs({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [tab, setTab] = useState<LogsTab>(readTabFromHash);
  useEffect(() => {
    const changed = () => setTab(readTabFromHash());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const tabs = [{ key: "logs", label: t("logs.tabLogs") }, { key: "debug", label: t("logs.tabDebug") }, { key: "desktop", label: t("nav.desktopLogs") }] as const;
  return <>
    <div className="page-head"><h2>{t("nav.logs")}</h2></div>
    <div className="native-tabs" role="tablist" aria-label={t("nav.logs")}>{tabs.map(item => <button key={item.key} id={`logs-tab-${item.key}`} className="btn btn-ghost" role="tab" aria-selected={tab === item.key} aria-controls={`logs-panel-${item.key}`} tabIndex={tab === item.key ? 0 : -1} onKeyDown={logsTabKeyDown} onClick={() => selectLogsTab(item.key)}>{item.label}</button>)}</div>
    <section id={`logs-panel-${tab}`} role="tabpanel" aria-labelledby={`logs-tab-${tab}`}>
      {tab === "desktop" ? <DesktopLogs /> : <NativeReportView apiBase={apiBase} view={tab} />}
    </section>
  </>;
}

export function NativeUsage({ apiBase }: { apiBase: string }) {
  const t = useT();
  return <><div className="page-head"><h2>{t("nav.usage")}</h2></div><NativeReportView apiBase={apiBase} view="usage" /></>;
}

export function NativeGuide() {
  const t = useT();
  return <><div className="page-head"><h2>{t("nav.guide")}</h2></div><div className="native-activity">
    <h3>Codex</h3><p>{t("native.guide")}</p><code>rmx onboard</code>
    <p>{t("native.readOnly")}</p><p>{t("native.usageHint")}</p>
    <a className="btn btn-primary" href="#android-remote">{t("nav.androidRemote")}</a>
  </div></>;
}
