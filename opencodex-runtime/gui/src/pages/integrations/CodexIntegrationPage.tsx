import { useCallback, useState } from "react";
import { useDataSurface } from "../../data-surface";
import { navigateHash } from "../../hash-routing";
import { useT } from "../../i18n/shared";
import { Notice } from "../../ui";
import ConsequenceDialog, { type ConsequenceCopy } from "./ConsequenceDialog";
import { loadCodexRoutingStatus } from "./integration-api";
import {
  loadNativeIntegrations,
  toggleNativeIntegration,
  type NativeStatus,
} from "./native-api";
import { describeRefusal } from "./refusal-copy";

type CodexMode = "native" | "routed";

const NATIVE_MODE_COPY: ConsequenceCopy = {
  titleKey: "integrations.codex.dialog.native.title",
  changesKey: "integrations.codex.dialog.native.changes",
  breakageKey: "integrations.codex.dialog.native.breakage",
  undoKey: "integrations.codex.dialog.native.undo",
  confirmKey: "integrations.codex.dialog.native.confirm",
};

const ROUTED_MODE_COPY: ConsequenceCopy = {
  titleKey: "integrations.codex.dialog.routed.title",
  changesKey: "integrations.codex.dialog.routed.changes",
  breakageKey: "integrations.codex.dialog.routed.breakage",
  undoKey: "integrations.codex.dialog.routed.undo",
  confirmKey: "integrations.codex.dialog.routed.confirm",
};

function isCold(kind: string): boolean {
  return kind === "cold" || kind === "retrying-cold";
}

export default function CodexIntegrationPage({
  apiBase,
  active = true,
}: {
  apiBase: string;
  active?: boolean;
}) {
  const t = useT();
  const [pendingMode, setPendingMode] = useState<CodexMode | null>(null);
  const [confirmingMode, setConfirmingMode] = useState<CodexMode | null>(null);
  const [projection, setProjection] = useState<{
    mode: CodexMode;
    status: NativeStatus | null;
    routing: Awaited<ReturnType<typeof loadCodexRoutingStatus>>;
  } | null>(null);
  const [result, setResult] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

  const fetchStatus = useCallback(async (signal: AbortSignal): Promise<NativeStatus | null> => {
    const envelope = await loadNativeIntegrations(apiBase, signal);
    return envelope?.clients.find(client => client.clientId === "codex") ?? null;
  }, [apiBase]);
  const fetchRouting = useCallback(
    (signal: AbortSignal) => loadCodexRoutingStatus(apiBase, signal),
    [apiBase],
  );

  const statusResource = useDataSurface<NativeStatus | null>(
    `integration-codex-mode:${apiBase}`,
    [apiBase],
    fetchStatus,
    { isEmpty: value => value === null, enabled: active },
  );
  const routingResource = useDataSurface(
    `integration-codex-routing-detail:${apiBase}`,
    [apiBase],
    fetchRouting,
    { isEmpty: value => value === null, enabled: active },
  );

  const status = statusResource.state.data ?? null;
  const routing = routingResource.state.data ?? null;
  const persistedMode: CodexMode = status?.desiredEnabled === false ? "native" : "routed";
  /*
   * Project a successful mutation immediately while both follow-up reads are
   * still showing their pre-mutation objects. Once both resources publish a
   * fresh object, the observed server state takes over without an effect that
   * synchronously sets more React state.
   */
  const projectionActive = projection !== null
    && (status === projection.status || routing === projection.routing);
  const selectedMode = projectionActive ? projection.mode : persistedMode;
  const routingInjected = projectionActive
    ? projection.mode === "routed"
    : routing?.routingInjected === true;
  const stateSettled = !isCold(statusResource.state.kind) && !isCold(routingResource.state.kind);
  const unavailable = stateSettled && (!status || !routing);
  const modeInEffect =
    (selectedMode === "native" && !routingInjected)
    || (selectedMode === "routed" && routingInjected);

  const refresh = () => {
    statusResource.refresh();
    routingResource.refresh();
  };

  const applyMode = async (mode: CodexMode) => {
    if (pendingMode || mode === selectedMode) return;
    setPendingMode(mode);
    setResult(null);
    try {
      const response = await toggleNativeIntegration(apiBase, "codex", mode === "routed");
      const converged = mode === "routed"
        ? response.state === "current"
        : response.state === "absent";
      if (!converged) {
        setResult({ tone: "err", text: response.message });
        return;
      }
      setProjection({ mode, status, routing });
      setResult({
        tone: "ok",
        text: t(mode === "native"
          ? "integrations.codex.result.native"
          : "integrations.codex.result.routed"),
      });
      refresh();
    } catch (error) {
      setResult({
        tone: "err",
        text: describeRefusal(
          t,
          error,
          t("integrations.error.generic"),
          status?.configPath,
        ),
      });
    } finally {
      setPendingMode(null);
    }
  };

  const requestMode = (mode: CodexMode) => {
    if (pendingMode || mode === selectedMode) return;
    setConfirmingMode(mode);
  };

  if (isCold(statusResource.state.kind) || isCold(routingResource.state.kind)) {
    return (
      <section className="codex-integration-page">
        <p className="page-sub">{t("common.loading")}</p>
      </section>
    );
  }

  return (
    <section className="codex-integration-page" aria-labelledby="codex-integration-title">
      <div className="codex-integration-head">
        <div>
          <h3 id="codex-integration-title">{t("integrations.codex.title")}</h3>
          <p className="page-sub">{t("integrations.codex.body")}</p>
        </div>
        {!unavailable && (
          <span className={`badge ${modeInEffect ? "badge-green" : "badge-warn"}`}>
            {t(modeInEffect
              ? "integrations.codex.status.ready"
              : "integrations.codex.status.attention")}
          </span>
        )}
      </div>

      {unavailable && <Notice tone="err">{t("integrations.codex.status.unavailable")}</Notice>}
      {!unavailable && !modeInEffect && (
        <Notice tone="warn">{t("integrations.codex.status.mismatch")}</Notice>
      )}
      {result && <Notice tone={result.tone}>{result.text}</Notice>}

      <div className="codex-mode-grid" aria-label={t("integrations.codex.modeLabel")}>
        <article className={`codex-mode-card${selectedMode === "native" ? " codex-mode-card--selected" : ""}`}>
          <div className="codex-mode-card-head">
            <h4>{t("integrations.codex.native.title")}</h4>
            <span className="badge badge-accent">{t("integrations.codex.recommended")}</span>
          </div>
          <p>{t("integrations.codex.native.body")}</p>
          <ul>
            <li>{t("integrations.codex.native.account")}</li>
            <li>{t("integrations.codex.native.android")}</li>
            <li>{t("integrations.codex.native.config")}</li>
          </ul>
          <button
            type="button"
            className={selectedMode === "native" ? "btn btn-ghost" : "btn btn-primary"}
            aria-pressed={selectedMode === "native"}
            disabled={pendingMode !== null || unavailable || selectedMode === "native"}
            onClick={() => requestMode("native")}
          >
            {selectedMode === "native"
              ? t("integrations.codex.current")
              : pendingMode === "native"
                ? t("integrations.codex.switching")
                : t("integrations.codex.native.use")}
          </button>
        </article>

        <article className={`codex-mode-card${selectedMode === "routed" ? " codex-mode-card--selected" : ""}`}>
          <div className="codex-mode-card-head">
            <h4>{t("integrations.codex.routed.title")}</h4>
            {selectedMode === "routed" && (
              <span className="badge badge-green">{t("integrations.codex.current")}</span>
            )}
          </div>
          <p>{t("integrations.codex.routed.body")}</p>
          <ul>
            <li>{t("integrations.codex.routed.models")}</li>
            <li>{t("integrations.codex.routed.config")}</li>
            <li>{t("integrations.codex.routed.restore")}</li>
          </ul>
          <button
            type="button"
            className={selectedMode === "routed" ? "btn btn-ghost" : "btn btn-primary"}
            aria-pressed={selectedMode === "routed"}
            disabled={pendingMode !== null || unavailable || selectedMode === "routed"}
            onClick={() => requestMode("routed")}
          >
            {selectedMode === "routed"
              ? t("integrations.codex.current")
              : pendingMode === "routed"
                ? t("integrations.codex.switching")
                : t("integrations.codex.routed.use")}
          </button>
        </article>
      </div>

      <div className="codex-protection-panel">
        <h4>{t("integrations.codex.protection.title")}</h4>
        <p>{t("integrations.codex.protection.body")}</p>
        {status?.configPath && <code>{status.configPath}</code>}
        <ol>
          <li>{t("integrations.codex.protection.snapshot")}</li>
          <li>{t("integrations.codex.protection.comments")}</li>
          <li>{t("integrations.codex.protection.restore")}</li>
        </ol>
      </div>

      <div className="codex-native-help">
        <div>
          <h4>{t("integrations.codex.login.title")}</h4>
          <p>{t("integrations.codex.login.body")} <code>codex login</code></p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => navigateHash("android-remote")}>
          {t("integrations.codex.openAndroid")}
        </button>
      </div>

      {confirmingMode && (
        <ConsequenceDialog
          copy={{
            ...(confirmingMode === "native" ? NATIVE_MODE_COPY : ROUTED_MODE_COPY),
            vars: { path: status?.configPath ?? "" },
          }}
          onClose={() => setConfirmingMode(null)}
          onConfirm={async () => {
            await applyMode(confirmingMode);
            setConfirmingMode(null);
          }}
        />
      )}
    </section>
  );
}
