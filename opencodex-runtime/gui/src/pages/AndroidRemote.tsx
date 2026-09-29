import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { QrCodeSvg } from "../components/qr-code-svg";
import { ANDROID_REMOTE_PAIR_HASH } from "../app-routing";
import { DataSurfaceSkeleton, DataSurfaceStatus } from "../components/data-surface";
import { setClientResourceData } from "../client-resource";
import { useDataSurface } from "../data-surface";
import { IconCheck, IconGlobe, IconKey, IconPlus, IconQrCode, IconRefresh, IconSmartphone, IconX } from "../icons";
import { useI18n } from "../i18n/shared";
import { normalizeHashPath, replaceHash } from "../hash-routing";
import { Notice, Switch } from "../ui";
import {
  androidRemoteResourceKey,
  checkAndroidRemoteTunnel,
  createAndroidRemotePairing,
  disconnectAndroidRemoteDomain,
  discoverAndroidRemoteCloudflare,
  loadAndroidRemoteStatus,
  provisionAndroidRemoteCloudflare,
  removeAndroidRemoteTunnelToken,
  retryAndroidRemoteTunnel,
  revokeAndroidRemoteClient,
  updateAndroidRemoteSettings,
  updateAndroidRemoteTunnel,
  type AndroidRemoteClient,
  type AndroidRemoteCloudflareDiscovery,
  type AndroidRemotePairing,
  type AndroidRemoteStatus,
} from "./android-remote-api";
import { createRandomRemoteSubdomain } from "./android-remote-subdomain";

function localPairingReady(status: AndroidRemoteStatus): boolean {
  return status.localNetworkEnabled === true && status.reachableAddresses.length > 0;
}

function pairingConnectionKey(status: AndroidRemoteStatus): string {
  // This is an internal cache key; it is never displayed to the user.
  // eslint-disable-next-line local-i18n/no-hardcoded-ui-strings
  return localPairingReady(status) ? `wifi:${status.reachableAddresses.join(",")}` : `${status.tunnel.runtime.status}:${status.tunnel.runtime.error}:${status.tunnel.runtime.publicUrl}:${status.tunnel.configuration.mode}`;
}

function SetupDialog({
  apiBase,
  status,
  onClose,
  onAdvanced,
  onRetry,
  retrying,
  statusFailed,
  repairClient,
}: {
  apiBase: string;
  status: AndroidRemoteStatus;
  onClose: () => void;
  onAdvanced: () => void;
  onRetry: () => void;
  retrying: boolean;
  statusFailed: boolean;
  repairClient?: AndroidRemoteClient;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();
  const [pairing, setPairing] = useState<AndroidRemotePairing | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [existingClients, setExistingClients] = useState(() => new Set(status.clients.map(client => client.id)));
  const requestRef = useRef<AbortController | null>(null);
  const replaceClientId = repairClient?.id;
  const newClients = status.clients.filter(client => !existingClients.has(client.id));
  const connected = !statusFailed && newClients.some(client => client.online);
  const registered = newClients.length > 0;
  const canPair = status.pairingAvailable && status.controlEnabled
    && status.gateway.status === "ready"
    && (localPairingReady(status) || (status.tunnel.runtime.status === "ready"
      && status.tunnel.runtime.error === null
      && status.tunnel.runtime.mode === status.tunnel.configuration.mode
      && status.tunnel.runtime.publicUrl?.startsWith("https://")));

  const requestPairing = useCallback(async () => {
    if (!canPair || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setLoading(true);
    setFailed(false);
    // Pairing tokens are one-time-use. Remove the previous QR immediately so
    // a refresh cannot leave a stale code on screen while the replacement is
    // being created.
    setPairing(null);
    setNow(Date.now());
    try {
      const next = await createAndroidRemotePairing(apiBase, controller.signal, replaceClientId);
      if (controller.signal.aborted || requestRef.current !== controller) return;
      setPairing(next);
      setNow(Date.now());
    } catch {
      if (requestRef.current !== controller) return;
      setPairing(null);
      setFailed(true);
    } finally {
      window.clearTimeout(timeout);
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [apiBase, canPair, replaceClientId]);

  useEffect(() => {
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void requestPairing(), 0);
    return () => window.clearTimeout(timer);
  }, [requestPairing]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      setElapsed(value => value + 1);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingSeconds = pairing
    ? Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - now) / 1_000))
    : 0;
  const expired = Boolean(pairing) && remainingSeconds === 0;
  const remaining = `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`;
  const connectionFailed = !canPair && status.tunnel.runtime.status === "error";
  const progressKey = statusFailed ? "remote.dialog.statusUnavailable"
    : connected ? "remote.dialog.connected"
    : registered ? "remote.dialog.registered"
    : failed ? "remote.dialog.codeError"
    : expired ? "remote.dialog.codeExpired"
    : !status.controlEnabled ? "remote.dialog.enableControl"
    : status.gateway.status === "error" ? "remote.dialog.gatewayError"
    : connectionFailed ? "remote.tunnel.statusFailed"
    : pairing ? "remote.dialog.waiting"
    : "remote.dialog.preparing";
  const working = !statusFailed && !connected && !failed && !expired && !connectionFailed && status.controlEnabled && status.gateway.status !== "error";

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="android-remote-pairing-title"
      aria-describedby="android-remote-pairing-desc"
      onCancel={event => { event.preventDefault(); onClose(); }}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onClose} />
      <div className="modal-card android-remote-dialog" role="document">
        <div className="modal-head">
          <div className="android-remote-dialog-title">
            <span className="android-remote-dialog-icon" aria-hidden="true"><IconSmartphone /></span>
            <h3 id="android-remote-pairing-title">{repairClient ? t("remote.repairTitle", { name: repairClient.label }) : t("remote.dialog.title")}</h3>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t("common.close")}><IconX /></button>
        </div>
        <p id="android-remote-pairing-desc" className="modal-desc">{t("remote.dialog.description")}</p>

        <div className="android-remote-onboard-progress" role="status" aria-live="polite">
          {connected ? <IconCheck aria-hidden="true" /> : <IconRefresh className={working ? "spin-icon" : undefined} aria-hidden="true" />}
          <span>{t(progressKey)}</span>
        </div>
        {connected && <Notice tone="ok">{t("remote.dialog.connectedHint")}</Notice>}
        {repairClient && <Notice tone="warn">{t("remote.repairHint", { name: repairClient.label })}</Notice>}
        {registered && !connected && canPair && !repairClient && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={loading || statusFailed} onClick={() => {
            setExistingClients(new Set(status.clients.map(client => client.id)));
            void requestPairing();
          }}>
            <IconRefresh aria-hidden="true" /> {t("remote.dialog.newCode")}
          </button>
        )}
        {!registered && elapsed >= 30 && <Notice tone="warn">{t("remote.dialog.takingLong")}</Notice>}
        {!canPair && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry} disabled={retrying}>
            <IconRefresh className={retrying ? "spin-icon" : undefined} aria-hidden="true" />
            {t(retrying ? "remote.dialog.preparing" : "remote.dialog.retryConnection")}
          </button>
        )}

        {!canPair && status.controlEnabled && status.gateway.status === "ready" && (
          <Notice tone="warn">{t("remote.dialog.tunnelPendingHint")}</Notice>
        )}

        {!canPair && (!status.controlEnabled || status.gateway.status !== "ready") && (
          <div className="android-remote-readiness" role="status">
            <div className="android-remote-readiness-row ready">
              <IconCheck aria-hidden="true" />
              <div><strong>{t("remote.dialog.dashboardReady")}</strong><span>{t("remote.dialog.dashboardReadyHint")}</span></div>
            </div>
            <div className="android-remote-readiness-row pending">
              <IconKey aria-hidden="true" />
              <div>
                <strong>{t(status.gateway.status === "starting" ? "remote.gatewayStarting" : status.gateway.status === "error" ? "remote.dialog.gatewayError" : "remote.dialog.gatewayPending")}</strong>
                <span>{t(status.gateway.status === "starting" ? "remote.dialog.gatewayStartingHint" : status.gateway.status === "error" ? "remote.dialog.gatewayErrorHint" : "remote.dialog.gatewayPendingHint")}</span>
              </div>
            </div>
            {!status.controlEnabled && <div className="android-remote-readiness-row pending">
              <IconSmartphone aria-hidden="true" />
              <div><strong>{t("remote.dialog.enableControl")}</strong><span>{t("remote.dialog.enableControlHint")}</span></div>
            </div>}
          </div>
        )}

        {!registered && canPair && status.localNetworkEnabled && status.reachableAddresses.length > 0 && <Notice tone="ok">{t("remote.local.pairHint")}</Notice>}
        {!registered && canPair && loading && !pairing && (
          <div className="android-remote-pairing-state" role="status">
            <IconRefresh className="spin-icon" aria-hidden="true" />
            <span>{t("remote.dialog.creatingCode")}</span>
          </div>
        )}

        {!registered && canPair && failed && !loading && (
          <div className="android-remote-pairing-failure">
            <Notice tone="err">{t("remote.dialog.codeError")}</Notice>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void requestPairing()}>
              <IconRefresh /> {t("common.retry")}
            </button>
          </div>
        )}

        {!registered && canPair && pairing && !expired && (
          <div className="android-remote-pairing">
            <div className="android-remote-qr-frame">
              <QrCodeSvg value={pairing.qrPayload} title={t("remote.dialog.qrTitle")} />
            </div>
            <div className="android-remote-pairing-copy">
              <strong>{t("remote.dialog.scanTitle")}</strong>
              <span>{t("remote.dialog.scanHint")}</span>
              <div className="android-remote-pairing-meta">
                <span className="android-remote-pairing-expiry" role="timer">
                  {t("remote.dialog.expiresIn", { value: remaining })}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void requestPairing()}
                  disabled={loading}
                  aria-label={t("remote.dialog.refreshCode")}
                >
                  <IconRefresh aria-hidden="true" /> {t("remote.dialog.refreshCode")}
                </button>
              </div>
            </div>
          </div>
        )}

        {!registered && canPair && pairing && expired && (
          <div className="android-remote-pairing-failure">
            <Notice tone="warn">{t("remote.dialog.codeExpired")}</Notice>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void requestPairing()}>
              <IconRefresh /> {t("remote.dialog.newCode")}
            </button>
          </div>
        )}

        <div className="modal-actions android-remote-dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onAdvanced}>{t("remote.tunnel.heading")}</button>
          <button type="button" className="btn btn-primary" onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </dialog>
  );
}

function gatewayLabel(status: AndroidRemoteStatus["gateway"]["status"], t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "ready") return t("remote.gatewayReady");
  if (status === "starting") return t("remote.gatewayStarting");
  if (status === "error") return t("remote.gatewayError");
  return t("remote.gatewayStopped");
}

function tunnelLabel(runtime: AndroidRemoteStatus["tunnel"]["runtime"], t: ReturnType<typeof useI18n>["t"]): string {
  if (runtime.status === "ready") return t("remote.tunnel.statusReady");
  if (runtime.status === "starting") return t("remote.tunnel.statusStarting");
  if (runtime.status === "checking" && runtime.phase === "activating") return t("remote.tunnel.statusActivating");
  if (runtime.status === "checking" && runtime.phase === "connecting") return t("remote.tunnel.statusConnecting");
  if (runtime.status === "checking") return t("remote.tunnel.statusChecking");
  if (runtime.status === "error" && runtime.phase === "reconnecting") return t("remote.tunnel.statusNotReachable");
  if (runtime.status === "error") return t("remote.tunnel.statusFailed");
  return t("remote.tunnel.statusStopped");
}

type CloudflareProgressState = "pending" | "active" | "complete" | "failed";

function CloudflareProgressRow({
  state,
  children,
}: {
  state: CloudflareProgressState;
  children: string;
}) {
  return (
    <div className={`android-remote-cloudflare-progress-row ${state}`} aria-current={state === "active" ? "step" : undefined}>
      {state === "complete" && <IconCheck aria-hidden="true" />}
      {state === "active" && <IconRefresh className="spin-icon" aria-hidden="true" />}
      {state === "failed" && <IconX aria-hidden="true" />}
      {state === "pending" && <span className="android-remote-progress-dot" aria-hidden="true" />}
      <span>{children}</span>
    </div>
  );
}

function TunnelSettings({
  apiBase,
  status,
  onPublish,
  onError,
  headingRef,
}: {
  apiBase: string;
  status: AndroidRemoteStatus;
  onPublish: (next: AndroidRemoteStatus) => void;
  onError: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const { t } = useI18n();
  const savedChoice = status.connectionChoice ?? (status.tunnel.configuration.mode === "named" ? "named" : "local");
  const [mode, setMode] = useState<"local" | "quick" | "named">(savedChoice);
  const [hostname, setHostname] = useState(status.tunnel.configuration.namedHostname ?? "");
  const [token, setToken] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [discovery, setDiscovery] = useState<AndroidRemoteCloudflareDiscovery | null>(null);
  const [accountId, setAccountId] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [subdomain, setSubdomain] = useState(createRandomRemoteSubdomain);
  const [tokenGuideOpen, setTokenGuideOpen] = useState(false);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [provisioned, setProvisioned] = useState(false);
  const [busy, setBusy] = useState<"selection" | "local" | "quick" | "discover" | "provision" | "manual" | "check" | "retry" | "remove" | "disconnect" | null>(null);
  const apiTokenInputRef = useRef<HTMLInputElement>(null);
  const configurationKey = `${status.tunnel.configuration.mode}:${status.tunnel.configuration.namedHostname ?? ""}`;
  const observedConfigurationKey = useRef(configurationKey);

  useEffect(() => {
    if (observedConfigurationKey.current === configurationKey) return;
    observedConfigurationKey.current = configurationKey;
    setHostname(status.tunnel.configuration.namedHostname ?? "");
  }, [configurationKey, status.tunnel.configuration.mode, status.tunnel.configuration.namedHostname]);

  const observedChoice = useRef(savedChoice);
  useEffect(() => {
    if (observedChoice.current === savedChoice) return;
    observedChoice.current = savedChoice;
    setMode(savedChoice);
  }, [savedChoice]);

  const reportWizardError = (error: unknown) => {
    setWizardError(error instanceof Error ? error.message : t("remote.tunnel.automaticError"));
  };

  const saveChoice = async (choice: "local" | "quick" | "named") => {
    setMode(choice);
    setBusy("selection");
    setWizardError(null);
    try {
      onPublish(await updateAndroidRemoteSettings(apiBase, { connectionChoice: choice }));
    } catch (error) {
      setMode(savedChoice);
      reportWizardError(error);
      onError();
    } finally {
      setBusy(null);
    }
  };

  const saveQuick = async () => {
    setMode("quick");
    setBusy("quick");
    setWizardError(null);
    try {
      onPublish(await updateAndroidRemoteTunnel(apiBase, { mode: "quick" }));
    } catch (error) {
      setMode(savedChoice);
      reportWizardError(error);
    } finally {
      setBusy(null);
    }
  };

  const saveManual = async () => {
    setBusy("manual");
    setWizardError(null);
    try {
      const next = await updateAndroidRemoteTunnel(apiBase, {
        mode: "named",
        hostname,
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      setToken("");
      onPublish(next);
    } catch (error) {
      reportWizardError(error);
    } finally {
      setBusy(null);
    }
  };

  const discover = async () => {
    setBusy("discover");
    setWizardError(null);
    setProvisioned(false);
    try {
      const next = await discoverAndroidRemoteCloudflare(apiBase, apiToken.trim());
      setDiscovery(next);
      const firstAccount = next.accounts[0]?.id ?? "";
      setAccountId(firstAccount);
      setZoneId(next.zones.find(zone => zone.accountId === firstAccount)?.id ?? "");
    } catch (error) {
      setDiscovery(null);
      setAccountId("");
      setZoneId("");
      reportWizardError(error);
    } finally {
      setBusy(null);
    }
  };

  const accountZones = discovery?.zones.filter(zone => zone.accountId === accountId) ?? [];
  const selectedZone = accountZones.find(zone => zone.id === zoneId) ?? null;

  const provision = async () => {
    if (!selectedZone) return;
    setBusy("provision");
    setWizardError(null);
    setProvisioned(false);
    try {
      const next = await provisionAndroidRemoteCloudflare(apiBase, {
        apiToken: apiToken.trim(),
        accountId,
        zoneId: selectedZone.id,
        hostname: `${subdomain.trim().toLowerCase()}.${selectedZone.name}`,
      });
      setApiToken("");
      setDiscovery(null);
      setProvisioned(true);
      onPublish(next);
    } catch (error) {
      reportWizardError(error);
    } finally {
      setBusy(null);
    }
  };

  const retry = async () => {
    setBusy("retry");
    try {
      onPublish(await retryAndroidRemoteTunnel(apiBase));
    } catch {
      onError();
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    try {
      onPublish(await checkAndroidRemoteTunnel(apiBase));
    } catch {
      onError();
    } finally {
      setBusy(null);
    }
  };

  const removeToken = async () => {
    setBusy("remove");
    try {
      setToken("");
      onPublish(await removeAndroidRemoteTunnelToken(apiBase));
    } catch {
      onError();
    } finally {
      setBusy(null);
    }
  };

  const beginDomainChange = () => {
    setApiToken("");
    setDiscovery(null);
    setAccountId("");
    setZoneId("");
    setProvisioned(false);
    setSubdomain(createRandomRemoteSubdomain());
    setWizardError(null);
    setTokenGuideOpen(false);
    window.setTimeout(() => apiTokenInputRef.current?.focus(), 0);
  };

  const disconnectDomain = async () => {
    setBusy("disconnect");
    setWizardError(null);
    try {
      const next = await disconnectAndroidRemoteDomain(apiBase);
      setApiToken("");
      setDiscovery(null);
      setAccountId("");
      setZoneId("");
      setProvisioned(false);
      setHostname("");
      setMode("quick");
      onPublish(next);
    } catch (error) {
      reportWizardError(error);
    } finally {
      setBusy(null);
    }
  };

  const runtime = status.tunnel.runtime;
  const connectorProgress: CloudflareProgressState = runtime.status === "checking"
    || runtime.status === "ready"
    || (runtime.status === "error" && runtime.error === "verification_failed")
    ? "complete"
    : runtime.status === "starting"
      ? "active"
      : runtime.status === "error"
        ? "failed"
        : "pending";
  const gatewayProgress: CloudflareProgressState = runtime.status === "ready"
    ? "complete"
    : runtime.status === "checking"
      ? "active"
      : runtime.status === "error" && runtime.error === "verification_failed"
        ? "failed"
        : "pending";
  const errorKey = runtime.error === "cloudflared_unavailable"
    ? "remote.tunnel.errorCloudflared"
    : runtime.error === "named_tunnel_incomplete"
      ? "remote.tunnel.errorIncomplete"
      : runtime.error === "verification_failed"
        ? "remote.tunnel.errorVerification"
        : "remote.tunnel.errorFailed";
  const addressLabel = runtime.status === "ready"
    ? t("remote.tunnel.verifiedUrl")
    : runtime.phase === "activating"
      ? t("remote.tunnel.activatingUrl")
      : runtime.phase === "reconnecting"
        ? t("remote.tunnel.unreachableUrl")
        : t("remote.tunnel.checkingUrl");
  const pendingHint = runtime.phase === "activating"
    ? t("remote.tunnel.activatingHint")
    : runtime.phase === "reconnecting"
      ? t("remote.tunnel.reconnectingHint")
      : t("remote.tunnel.connectingHint");

  return (
    <section className="android-remote-section" aria-labelledby="android-remote-tunnel-heading">
      <div className="android-remote-section-heading">
        <IconGlobe aria-hidden="true" />
        <h3 id="android-remote-tunnel-heading" ref={headingRef} tabIndex={-1}>{t("remote.tunnel.heading")}</h3>
      </div>
      <div className="android-remote-tunnel-card">
        <div className="android-remote-tunnel-intro">
          <div>
            <strong>{t("remote.tunnel.title")}</strong>
            <p>{t("remote.tunnel.hint")}</p>
          </div>
          <span className={`android-remote-gateway-badge ${runtime.status}`} role="status">
            {tunnelLabel(runtime, t)}
          </span>
        </div>

        <div className="android-remote-tunnel-options" role="radiogroup" aria-label={t("remote.tunnel.modeLabel")}>
          <label className={`android-remote-tunnel-option ${mode === "local" ? "selected" : ""}`}>
            <input type="radio" name="android-tunnel-mode" value="local" checked={mode === "local"}
              disabled={busy !== null} onChange={() => void saveChoice("local")} />
            <span>
              <span className="android-remote-tunnel-option-title"><strong>{t("remote.local.title")}</strong></span>
              <small>{t("remote.local.hint")}</small>
            </span>
          </label>
          <label className={`android-remote-tunnel-option ${mode === "quick" ? "selected" : ""}`}>
            <input
              type="radio"
              name="android-tunnel-mode"
              value="quick"
              checked={mode === "quick"}
              disabled={busy !== null}
              onChange={() => {
                if (status.tunnel.configuration.mode === "quick") void saveChoice("quick");
                else void saveQuick();
              }}
            />
            <span>
              <span className="android-remote-tunnel-option-title">
                <strong>{t("remote.tunnel.quickTitle")}</strong>
                <em>{t("remote.tunnel.quickBadge")}</em>
              </span>
              <small>{t("remote.tunnel.quickHint")}</small>
            </span>
          </label>
          <label className={`android-remote-tunnel-option ${mode === "named" ? "selected" : ""}`}>
            <input type="radio" name="android-tunnel-mode" value="named" checked={mode === "named"} disabled={busy !== null} onChange={() => void saveChoice("named")} />
            <span>
              <span className="android-remote-tunnel-option-title">
                <strong>{t("remote.tunnel.namedTitle")}</strong>
                <em>{t("remote.tunnel.namedBadge")}</em>
              </span>
              <small>{t("remote.tunnel.namedHint")}</small>
            </span>
          </label>
        </div>

        {mode === "local" && (
          <div className="android-remote-setting-row">
            <div>
              <strong>{t("remote.local.title")}</strong>
              <p>{t("remote.local.hint")}</p>
              <div className="android-remote-addresses">
                {status.reachableAddresses.map(address => <code key={address}>{address}</code>)}
              </div>
            </div>
            <Switch on={status.localNetworkEnabled === true} disabled={busy !== null || !status.controlEnabled}
              label={t("remote.local.title")} onClick={() => void (async () => {
                setBusy("local");
                try { onPublish(await updateAndroidRemoteSettings(apiBase, { localNetworkEnabled: !status.localNetworkEnabled })); }
                catch { onError(); }
                finally { setBusy(null); }
              })()} />
          </div>
        )}
        {mode !== "local" && <>
        <details className="android-remote-tunnel-compare">
          <summary>{t("remote.tunnel.compareTitle")}</summary>
          <div className="android-remote-tunnel-compare-grid">
            <article>
              <strong>{t("remote.tunnel.quickTitle")}</strong>
              <p>{t("remote.tunnel.compareQuickBest")}</p>
              <ul>
                <li>{t("remote.tunnel.compareQuickSetup")}</li>
                <li>{t("remote.tunnel.compareQuickAddress")}</li>
                <li>{t("remote.tunnel.compareQuickLimit")}</li>
              </ul>
            </article>
            <article>
              <strong>{t("remote.tunnel.namedTitle")}</strong>
              <p>{t("remote.tunnel.compareNamedBest")}</p>
              <ul>
                <li>{t("remote.tunnel.compareNamedAddress")}</li>
                <li>{t("remote.tunnel.compareNamedSetup")}</li>
                <li>{t("remote.tunnel.compareNamedTime")}</li>
              </ul>
            </article>
          </div>
          <p className="android-remote-tunnel-compare-shared">{t("remote.tunnel.compareShared")}</p>
        </details>

        {mode === "named" && (
          <div className="android-remote-cloudflare-wizard">
            <div className="android-remote-cloudflare-wizard-copy">
              <strong>{t("remote.tunnel.automaticTitle")}</strong>
              <p>{t("remote.tunnel.automaticHint")}</p>
            </div>
            <details
              className="android-remote-cloudflare-token-guide"
              open={tokenGuideOpen}
              onToggle={event => setTokenGuideOpen(event.currentTarget.open)}
            >
              <summary>
                <span>
                  <strong>{t("remote.tunnel.tokenGuideTitle")}</strong>
                  <small>{t("remote.tunnel.tokenGuideHint")}</small>
                </span>
              </summary>
              <div className="android-remote-cloudflare-token-guide-body">
                <a className="btn btn-ghost" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">
                  {t("remote.tunnel.createApiToken")}
                </a>
                <ol>
                  <li>
                    <div>
                      <strong>{t("remote.tunnel.tokenStepCustomTitle")}</strong>
                      <p>{t("remote.tunnel.tokenStepCustomBody")}</p>
                    </div>
                  </li>
                  <li>
                    <div>
                      <strong>{t("remote.tunnel.tokenStepPermissionsTitle")}</strong>
                      <div className="android-remote-cloudflare-permission-list" role="list">
                        <code role="listitem">{t("remote.tunnel.tokenPermissionTunnel")}</code>
                        <code role="listitem">{t("remote.tunnel.tokenPermissionDns")}</code>
                        <code role="listitem">{t("remote.tunnel.tokenPermissionZone")}</code>
                      </div>
                    </div>
                  </li>
                  <li>
                    <div>
                      <strong>{t("remote.tunnel.tokenStepResourcesTitle")}</strong>
                      <p>{t("remote.tunnel.tokenStepResourcesBody")}</p>
                    </div>
                  </li>
                  <li>
                    <div>
                      <strong>{t("remote.tunnel.tokenStepCopyTitle")}</strong>
                      <p>{t("remote.tunnel.tokenStepCopyBody")}</p>
                    </div>
                  </li>
                </ol>
                <p className="android-remote-cloudflare-token-guide-finish">{t("remote.tunnel.tokenGuideFinish")}</p>
              </div>
            </details>
            <label className="android-remote-cloudflare-field">
              <span>{t("remote.tunnel.apiTokenLabel")}</span>
              <input
                ref={apiTokenInputRef}
                type="password"
                value={apiToken}
                onChange={event => {
                  setApiToken(event.target.value);
                  setDiscovery(null);
                  setAccountId("");
                  setZoneId("");
                  setProvisioned(false);
                }}
                placeholder={t("remote.tunnel.apiTokenPlaceholder")}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button type="button" className="btn btn-ghost android-remote-cloudflare-authorize" disabled={busy !== null || !apiToken.trim()} onClick={() => void discover()}>
              {busy === "discover" ? <IconRefresh className="spin-icon" aria-hidden="true" /> : <IconGlobe aria-hidden="true" />}
              {busy === "discover"
                ? t("remote.tunnel.authorizing")
                : t(discovery ? "remote.tunnel.refreshDomains" : "remote.tunnel.authorize")}
            </button>

            {discovery && (
              <div className="android-remote-cloudflare-selection">
                <div className="android-remote-cloudflare-progress-row complete">
                  <IconCheck aria-hidden="true" />
                  <span>{t("remote.tunnel.authorized")}</span>
                </div>
                {discovery.accounts.length === 0 || discovery.zones.length === 0 ? (
                  <Notice tone="warn">{t("remote.tunnel.noDomains")}</Notice>
                ) : (
                  <>
                    <div className="android-remote-tunnel-form">
                      <label>
                        <span>{t("remote.tunnel.accountLabel")}</span>
                        <select
                          value={accountId}
                          onChange={event => {
                            const nextAccount = event.target.value;
                            setAccountId(nextAccount);
                            setZoneId(discovery.zones.find(zone => zone.accountId === nextAccount)?.id ?? "");
                          }}
                        >
                          {discovery.accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
                        </select>
                      </label>
                      <label>
                        <span>{t("remote.tunnel.domainLabel")}</span>
                        <select value={zoneId} onChange={event => setZoneId(event.target.value)}>
                          {accountZones.map(zone => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
                        </select>
                      </label>
                    </div>
                    {selectedZone && (
                      <>
                        <label className="android-remote-cloudflare-field">
                          <span>{t("remote.tunnel.subdomainLabel")}</span>
                          <div className="android-remote-subdomain-input">
                            <input value={subdomain} onChange={event => setSubdomain(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                            <span>.{selectedZone.name}</span>
                          </div>
                          <small>{t("remote.tunnel.subdomainSecurityHint")}</small>
                        </label>
                        {selectedZone.status !== "active" && (
                          <Notice tone="warn">
                            {t("remote.tunnel.domainPending")}
                            {selectedZone.nameServers.length > 0 && (
                              <span className="android-remote-name-servers">
                                {selectedZone.nameServers.map(nameServer => <code key={nameServer}>{nameServer}</code>)}
                              </span>
                            )}
                          </Notice>
                        )}
                        <button
                          type="button"
                          className="btn btn-primary android-remote-cloudflare-connect"
                          disabled={busy !== null || selectedZone.status !== "active" || !subdomain.trim()}
                          onClick={() => void provision()}
                        >
                          {busy === "provision" ? <IconRefresh className="spin-icon" aria-hidden="true" /> : <IconCheck aria-hidden="true" />}
                          {busy === "provision" ? t("remote.tunnel.connecting") : t("remote.tunnel.connect")}
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {provisioned && (
              <div className="android-remote-cloudflare-progress" aria-label={t("remote.tunnel.progressLabel")} aria-live="polite">
                <CloudflareProgressRow state="complete">{t("remote.tunnel.resourcesConfigured")}</CloudflareProgressRow>
                <CloudflareProgressRow state={connectorProgress}>{t("remote.tunnel.connectorAccepted")}</CloudflareProgressRow>
                <CloudflareProgressRow state={gatewayProgress}>{t("remote.tunnel.gatewayVerified")}</CloudflareProgressRow>
              </div>
            )}

            <details className="android-remote-tunnel-guide android-remote-manual-setup">
              <summary>{t("remote.tunnel.manualTitle")}</summary>
              <p>{t("remote.tunnel.manualHint")}</p>
              <div className="android-remote-tunnel-form">
                <label>
                  <span>{t("remote.tunnel.hostnameLabel")}</span>
                  <input value={hostname} onChange={event => setHostname(event.target.value)} placeholder="codex.example.com" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                </label>
                <label>
                  <span>{t("remote.tunnel.tokenLabel")}</span>
                  <input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder={status.tunnel.configuration.hasNamedTunnelToken ? t("remote.tunnel.tokenSavedPlaceholder") : t("remote.tunnel.tokenPlaceholder")} autoComplete="off" />
                </label>
              </div>
              <div className="android-remote-tunnel-actions">
                <button type="button" className="btn btn-ghost" disabled={busy !== null || !hostname.trim()} onClick={() => void saveManual()}>
                  {busy === "manual" ? t("remote.tunnel.saving") : t("remote.tunnel.manualSave")}
                </button>
                {status.tunnel.configuration.hasNamedTunnelToken && (
                  <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void removeToken()}>{t("remote.tunnel.removeToken")}</button>
                )}
              </div>
              <p className="android-remote-tunnel-guide-note">{t("remote.tunnel.manualOrigin", { origin: `http://127.0.0.1:${status.gateway.port}` })}</p>
            </details>
          </div>
        )}

        {runtime.mode === mode && runtime.publicUrl && (
          <div className="android-remote-tunnel-url">
            <div>
              <span>{addressLabel}</span>
              <code>{runtime.publicUrl}</code>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm android-remote-tunnel-check"
              disabled={busy !== null || !status.controlEnabled}
              onClick={() => void check()}
              aria-label={t("remote.tunnel.checkAddress")}
            >
              <IconRefresh className={busy === "check" ? "spin-icon" : undefined} aria-hidden="true" />
              {busy === "check" ? t("remote.tunnel.checkingAddress") : t("remote.tunnel.checkAddress")}
            </button>
          </div>
        )}
        {status.tunnel.configuration.mode === "named" && status.tunnel.configuration.namedHostname && (
          <div className="android-remote-domain-management">
            <div>
              <strong>{t("remote.tunnel.domainManagementTitle")}</strong>
              <code>{status.tunnel.configuration.namedHostname}</code>
              <p>{t("remote.tunnel.domainManagementHint")}</p>
            </div>
            <div className="android-remote-domain-management-actions">
              <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={beginDomainChange}>
                {t("remote.tunnel.changeDomain")}
              </button>
              <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void disconnectDomain()}>
                {busy === "disconnect" ? <IconRefresh className="spin-icon" aria-hidden="true" /> : <IconX aria-hidden="true" />}
                {busy === "disconnect" ? t("remote.tunnel.disconnectingDomain") : t("remote.tunnel.disconnectDomain")}
              </button>
            </div>
          </div>
        )}
        {wizardError && <Notice tone="err">{wizardError}</Notice>}
        {runtime.publicUrl && runtime.status === "checking" && <Notice tone="warn">{pendingHint}</Notice>}
        {runtime.status === "error" && runtime.error && <Notice tone="err">{t(errorKey)}</Notice>}

        <div className="android-remote-tunnel-actions">
          <button type="button" className="btn btn-ghost" disabled={busy !== null || !status.controlEnabled} onClick={() => void retry()}>
            <IconRefresh /> {busy === "retry" ? t("remote.tunnel.restarting") : t("remote.tunnel.restart")}
          </button>
        </div>
        </>}
      </div>
    </section>
  );
}

function ClientRow({
  client,
  busy,
  onRevoke,
  onPair,
}: {
  client: AndroidRemoteClient;
  busy: boolean;
  onRevoke: () => void;
  onPair: () => void;
}) {
  const { t, locale } = useI18n();
  const lastSeen = client.lastSeenAt
    ? new Date(client.lastSeenAt).toLocaleString(locale)
    : t("remote.neverSeen");
  return (
    <div className="android-remote-client-row">
      <div className="android-remote-client-main">
        <span className={`android-remote-status-dot ${client.online ? "online" : "offline"}`} aria-hidden="true" />
        <div className="android-remote-client-copy">
          <div className="android-remote-client-name">
            <strong>{client.label}</strong>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onPair} disabled={busy}
              aria-haspopup="dialog" aria-label={t("remote.repairTitle", { name: client.label })}
              title={t("remote.repairTitle", { name: client.label })}>
              <IconQrCode aria-hidden="true" />
            </button>
            <span className="android-remote-state-label">{t(client.online ? "remote.online" : "remote.offline")}</span>
          </div>
          <span>{t("remote.mobileMeta", { os: client.os, address: client.address ?? t("remote.unknownAddress"), count: client.scopes.length })}</span>
          <span>{t("remote.lastSeen", { value: lastSeen })}</span>
          {client.scopes.length > 0 && (
            <div className="android-remote-scopes" aria-label={t("remote.permissions")}>
              {client.scopes.map(scope => <code key={scope}>{scope}</code>)}
            </div>
          )}
        </div>
      </div>
      <button type="button" className="btn btn-danger btn-sm" onClick={onRevoke} disabled={busy}>
        {busy ? t("remote.revoking") : t("remote.revoke")}
      </button>
    </div>
  );
}

export default function AndroidRemote({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const resourceKey = androidRemoteResourceKey(apiBase);
  const resource = useDataSurface<AndroidRemoteStatus>(
    resourceKey,
    [apiBase],
    signal => loadAndroidRemoteStatus(apiBase, signal),
    { isEmpty: () => false, pollMs: 5_000 },
  );
  const { state } = resource;
  const status = state.data;
  const [saving, setSaving] = useState<"controlEnabled" | "keepAwake" | "localNetworkEnabled" | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState(false);
  const [setupOpen, setSetupOpen] = useState(() =>
    normalizeHashPath(window.location.hash) === ANDROID_REMOTE_PAIR_HASH);
  const [repairClient, setRepairClient] = useState<AndroidRemoteClient | undefined>();
  const addPhoneRef = useRef<HTMLButtonElement>(null);
  const connectionHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const openPairingFromHash = () => {
      if (normalizeHashPath(window.location.hash) === ANDROID_REMOTE_PAIR_HASH) {
        setRepairClient(undefined);
        setSetupOpen(true);
      }
    };
    window.addEventListener("hashchange", openPairingFromHash);
    return () => window.removeEventListener("hashchange", openPairingFromHash);
  }, []);

  const publish = (next: AndroidRemoteStatus) => {
    setClientResourceData(resourceKey, next);
    setActionError(false);
  };

  const updateSetting = async (
    field: "controlEnabled" | "keepAwake" | "localNetworkEnabled",
    value: boolean,
  ) => {
    setSaving(field);
    setActionError(false);
    try {
      publish(await updateAndroidRemoteSettings(apiBase, { [field]: value }));
    } catch {
      setActionError(true);
    } finally {
      setSaving(null);
    }
  };

  const revoke = async (client: AndroidRemoteClient) => {
    if (!window.confirm(t("remote.revokeConfirm", { name: client.label }))) return;
    setRevokingId(client.id);
    setActionError(false);
    try {
      publish(await revokeAndroidRemoteClient(apiBase, client.id));
    } catch {
      setActionError(true);
    } finally {
      setRevokingId(null);
    }
  };

  const closeSetup = () => {
    setSetupOpen(false);
    setRepairClient(undefined);
    if (normalizeHashPath(window.location.hash) === ANDROID_REMOTE_PAIR_HASH) {
      replaceHash("android-remote");
    }
    window.setTimeout(() => addPhoneRef.current?.focus(), 0);
  };

  return (
    <>
      <div className="page-head android-remote-page-head">
        <div>
          <h2>{t("remote.title")}</h2>
          <p className="page-sub">{t("remote.subtitle")}</p>
        </div>
        <button
          ref={addPhoneRef}
          type="button"
          className="btn btn-primary android-remote-add"
          onClick={() => { setRepairClient(undefined); setSetupOpen(true); }}
          aria-haspopup="dialog"
        >
          <IconPlus /> {t("remote.addPhone")}
        </button>
      </div>

      {state.showSkeleton && !status ? (
        <DataSurfaceSkeleton label={t("remote.loading")} rows={5} />
      ) : state.kind === "failed-cold" ? (
        <div className="android-remote-error">
          <Notice tone="err">{t("remote.loadError")}</Notice>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => resource.refresh()}>{t("common.retry")}</button>
        </div>
      ) : status ? (
        <div className="android-remote-page" aria-busy={saving !== null || revokingId !== null || undefined}>
          {state.refreshing && (
            <DataSurfaceStatus className="android-remote-refresh-status" live={!state.showError}>
              {t("remote.refreshing")}
            </DataSurfaceStatus>
          )}
          {state.showError && <Notice tone="err">{t("remote.staleError")}</Notice>}
          {actionError && <Notice tone="err">{t("remote.saveError")}</Notice>}

          <section className="android-remote-section" aria-labelledby="android-remote-settings-heading">
            <div className="android-remote-section-heading">
              <IconSmartphone aria-hidden="true" />
              <h3 id="android-remote-settings-heading">{t("remote.settingsHeading")}</h3>
            </div>
            <div className="android-remote-settings-card">
              <div className="android-remote-setting-row">
                <div>
                  <strong>{t("remote.controlTitle")}</strong>
                  <p>{t("remote.controlHint")}</p>
                  <div className="android-remote-addresses">
                    {status.reachableAddresses.map(address => <code key={address}>{address}</code>)}
                  </div>
                </div>
                <Switch
                  on={status.controlEnabled}
                  onClick={() => void updateSetting("controlEnabled", !status.controlEnabled)}
                  disabled={saving !== null}
                  label={t("remote.controlTitle")}
                />
              </div>
              <div className="android-remote-setting-row">
                <div>
                  <strong>{t("remote.keepAwakeTitle")}</strong>
                  <p>{t("remote.keepAwakeHint")}</p>
                </div>
                <Switch
                  on={status.keepAwake}
                  onClick={() => void updateSetting("keepAwake", !status.keepAwake)}
                  disabled={saving !== null || !status.controlEnabled}
                  label={t("remote.keepAwakeTitle")}
                />
              </div>
              <div className="android-remote-setting-row android-remote-gateway-row">
                <div>
                  <strong>{t("remote.backgroundTitle")}</strong>
                  <p>{t("remote.backgroundHint", { port: status.gateway.port })}</p>
                </div>
                <span className={`android-remote-gateway-badge ${status.gateway.status}`}>
                  {gatewayLabel(status.gateway.status, t)}
                </span>
              </div>
            </div>
          </section>

          <TunnelSettings
            apiBase={apiBase}
            status={status}
            onPublish={publish}
            onError={() => setActionError(true)}
            headingRef={connectionHeadingRef}
          />

          <section className="android-remote-section" aria-labelledby="android-remote-clients-heading">
            <div className="android-remote-section-heading">
              <IconKey aria-hidden="true" />
              <h3 id="android-remote-clients-heading">{t("remote.clientsHeading")}</h3>
            </div>
            <div className="android-remote-clients-card">
              <div className="android-remote-client-row desktop">
                <div className="android-remote-client-main">
                  <span className="android-remote-status-dot online" aria-hidden="true" />
                  <div className="android-remote-client-copy">
                    <div className="android-remote-client-name">
                      <strong>{status.desktop.label}</strong>
                      <button type="button" className="btn btn-ghost btn-sm" aria-haspopup="dialog"
                        aria-label={t("remote.addPhone")} title={t("remote.addPhone")}
                        onClick={() => { setRepairClient(undefined); setSetupOpen(true); }}>
                        <IconQrCode aria-hidden="true" />
                      </button>
                      <span className="android-remote-this-device">{t("remote.thisDevice")}</span>
                    </div>
                    <span>{t("remote.desktopMeta", { platform: status.desktop.platform, address: status.desktop.address })}</span>
                  </div>
                </div>
              </div>
              {status.clients.map(client => (
                <ClientRow
                  key={client.id}
                  client={client}
                  busy={revokingId === client.id}
                  onRevoke={() => void revoke(client)}
                  onPair={() => { setRepairClient(client); setSetupOpen(true); }}
                />
              ))}
              {status.clients.length === 0 && (
                <div className="android-remote-empty-clients">
                  <IconSmartphone aria-hidden="true" />
                  <div><strong>{t("remote.noPhones")}</strong><span>{t("remote.noPhonesHint")}</span></div>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {setupOpen && status && <SetupDialog
        key={`${repairClient?.id ?? "new"}:${status.pairingAvailable}:${status.controlEnabled}:${status.gateway.status}:${pairingConnectionKey(status)}`}
        apiBase={apiBase} status={status} onClose={closeSetup}
        repairClient={repairClient}
        statusFailed={state.showError || actionError}
        retrying={saving !== null}
        onRetry={() => void updateSetting("controlEnabled", true)}
        onAdvanced={() => {
          closeSetup();
          window.setTimeout(() => connectionHeadingRef.current?.focus(), 0);
        }}
      />}
    </>
  );
}
