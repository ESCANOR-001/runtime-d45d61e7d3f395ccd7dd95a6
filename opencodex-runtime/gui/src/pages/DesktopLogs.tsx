import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  desktopRuntimeBridgeAvailable,
  openDesktopSupportEmail,
  readDesktopDiagnostics,
  type DesktopDiagnosticsSnapshot,
} from "../desktop-runtime";
import { buildDesktopDiagnosticsReport, desktopDiagnosticsFilename } from "../desktop-support-report";
import { IconRefresh, IconTerminal } from "../icons";
import { useI18n } from "../i18n/shared";
import { Notice } from "../ui";

type Feedback = { tone: "ok" | "warn" | "err"; message: string };

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** exponent);
  return `${amount >= 10 || exponent === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[exponent]}`;
}

export default function DesktopLogs() {
  const { locale, t } = useI18n();
  const [snapshot, setSnapshot] = useState<DesktopDiagnosticsSnapshot | null>(null);
  // The npm/localhost dashboard reads diagnostics through the management API;
  // a Tauri bridge is only required for the desktop support-email action.
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [openingEmail, setOpeningEmail] = useState(false);
  const loadGeneration = useRef(0);
  const loadPending = useRef(false);

  const refresh = useCallback(async () => {
    if (loadPending.current) return;
    loadPending.current = true;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await readDesktopDiagnostics();
      if (generation !== loadGeneration.current) return;
      if (!next) throw new Error(t("desktopLogs.desktopOnly"));
      setSnapshot(next);
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === loadGeneration.current) {
        loadPending.current = false;
        setLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    loadPending.current = true;
    void readDesktopDiagnostics()
      .then(next => {
        if (generation !== loadGeneration.current) return;
        if (!next) throw new Error(t("desktopLogs.desktopOnly"));
        setSnapshot(next);
      })
      .catch((error: unknown) => {
        if (generation === loadGeneration.current) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (generation !== loadGeneration.current) return;
        loadPending.current = false;
        setLoading(false);
      });
    const poll = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 5_000);
    return () => {
      loadGeneration.current += 1;
      loadPending.current = false;
      window.clearInterval(poll);
    };
  }, [refresh, t]);

  const report = useMemo(
    () => snapshot ? buildDesktopDiagnosticsReport(snapshot) : "",
    [snapshot],
  );

  const downloadReport = () => {
    if (!snapshot || !report) return;
    setFeedback(null);
    try {
      const url = URL.createObjectURL(new Blob([report], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = desktopDiagnosticsFilename(snapshot);
      document.body.appendChild(link);
      try { link.click(); } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      setFeedback({ tone: "ok", message: t("desktopLogs.downloadStarted") });
    } catch {
      setFeedback({ tone: "err", message: t("desktopLogs.exportFailed") });
    }
  };

  const copyReport = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      setFeedback({ tone: "ok", message: t("desktopLogs.copied") });
    } catch {
      setFeedback({ tone: "err", message: t("desktopLogs.copyFailed") });
    }
  };

  const contactSupportFromBrowser = async () => {
    if (!report || openingEmail) return;
    setOpeningEmail(true);
    setFeedback(null);
    try {
      // Open synchronously while this handler still has a user gesture. Waiting
      // for the clipboard promise first causes Chrome to block the new tab.
      const composeUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent("support@remodex.net")}&su=${encodeURIComponent(t("desktopLogs.emailSubject"))}&body=${encodeURIComponent(t("desktopLogs.emailBody"))}`;
      const mailWindow = window.open(composeUrl, "_blank", "noopener,noreferrer");
      if (!mailWindow) {
        window.location.assign(composeUrl);
      }
      // Put the exact report on the clipboard before handing off to the mail
      // client. The user can attach the downloaded report.
      await navigator.clipboard.writeText(report).catch(() => undefined);
      setFeedback({ tone: "ok", message: t("desktopLogs.contactStarted") });
    } catch {
      setFeedback({ tone: "err", message: t("desktopLogs.contactFailed") });
    } finally {
      setOpeningEmail(false);
    }
  };

  const openSupportEmail = async () => {
    if (!report || openingEmail) return;
    setOpeningEmail(true);
    setFeedback(null);
    try {
      await openDesktopSupportEmail(report);
      setFeedback({ tone: "ok", message: t("desktopLogs.opened") });
    } catch (error) {
      setFeedback({
        tone: "err",
        message: t("desktopLogs.openFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      setOpeningEmail(false);
    }
  };

  return (
    <section className="desktop-logs-page">
      <div className="page-head">
        <h2>{t("desktopLogs.title")}</h2>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <IconRefresh /> {t(loading ? "desktopLogs.refreshing" : "desktopLogs.refresh")}
        </button>
      </div>
      <p className="page-sub">{t("desktopLogs.subtitle")}</p>

      <section className="desktop-logs-privacy card">
        <IconTerminal aria-hidden />
        <div>
          <strong>{t("desktopLogs.privacyTitle")}</strong>
          <p>{t("desktopLogs.privacyBody")}</p>
        </div>
      </section>

      {loadError && (
        <div className="notice notice-err" role="alert">
          <span>{t("desktopLogs.loadFailed", { message: loadError })}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()}>
            {t("common.retry")}
          </button>
        </div>
      )}

      {loading && !snapshot && (
        <div className="desktop-logs-loading card" role="status">
          <span className="spin" aria-hidden />
          {t("desktopLogs.loading")}
        </div>
      )}

      {snapshot && (
        <>
          <section className="desktop-logs-summary card" aria-label={t("desktopLogs.summary")}>
            <div className="desktop-logs-card-head">
              <div>
                <h3>{t("desktopLogs.summary")}</h3>
                <p>{snapshot.truncated ? t("desktopLogs.truncated") : t("desktopLogs.complete")}</p>
              </div>
              <span className={`badge ${snapshot.truncated ? "badge-amber" : "badge-green"}`}>
                {snapshot.runtime.state}
              </span>
            </div>
            <dl className="desktop-logs-meta">
              <div>
                <dt>{t("desktopLogs.appVersion")}</dt>
                <dd className="mono">{snapshot.appVersion}</dd>
              </div>
              <div>
                <dt>{t("desktopLogs.platform")}</dt>
                <dd className="mono">{snapshot.platform}/{snapshot.architecture}</dd>
              </div>
              <div>
                <dt>{t("desktopLogs.runtime")}</dt>
                <dd>{snapshot.runtime.state}</dd>
              </div>
              <div>
                <dt>{t("desktopLogs.generated")}</dt>
                <dd>{new Date(snapshot.generatedAtMs).toLocaleString(locale)}</dd>
              </div>
              <div>
                <dt>{t("desktopLogs.source")}</dt>
                <dd className="mono">{snapshot.logPath}</dd>
              </div>
              <div>
                <dt>{t("desktopLogs.capture")}</dt>
                <dd>{formatBytes(snapshot.includedBytes)} / {formatBytes(snapshot.sourceBytes)}</dd>
              </div>
            </dl>
          </section>

          <section className="desktop-logs-actions card">
            <div className="desktop-logs-card-head">
              <div>
                <h3>{t("desktopLogs.actionsTitle")}</h3>
                <p>{t(desktopRuntimeBridgeAvailable() ? "desktopLogs.actionsHint" : "desktopLogs.browserHint")}</p>
              </div>
              <div className="desktop-logs-buttons">
                <button type="button" className="btn btn-primary" onClick={downloadReport}>
                  {t("desktopLogs.download")}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => void copyReport()}>
                  {t("desktopLogs.copy")}
                </button>
                {desktopRuntimeBridgeAvailable() ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void openSupportEmail()}
                  disabled={openingEmail}
                >
                  {t(openingEmail ? "desktopLogs.opening" : "desktopLogs.send")}
                </button>
                ) : (
                  <button type="button" className="btn btn-ghost" onClick={() => void contactSupportFromBrowser()} disabled={openingEmail}>
                    {t("desktopLogs.contact")}
                  </button>
                )}
              </div>
            </div>
          </section>

          {feedback && <Notice tone={feedback.tone}>{feedback.message}</Notice>}

          <section className="desktop-logs-report card">
            <div className="desktop-logs-card-head">
              <div>
                <h3>{t("desktopLogs.reportTitle")}</h3>
                <p>{t("desktopLogs.exportHint")}</p>
              </div>
              <span className="badge badge-green">{t("desktopLogs.redacted")}</span>
            </div>
            <pre tabIndex={0} aria-label={t("desktopLogs.reportTitle")}>{report}</pre>
          </section>
        </>
      )}
    </section>
  );
}
