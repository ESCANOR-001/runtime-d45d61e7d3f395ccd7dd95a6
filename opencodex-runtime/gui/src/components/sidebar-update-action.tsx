/** Opens the dashboard's npm package updater. */
import { IconDownload } from "../icons";
import { useT } from "../i18n/shared";
import { useEffect, useRef, useState, type RefObject } from "react";

export function SidebarUpdateAction({
  onOpenUpdate,
  apiBase = "",
  triggerRef,
}: {
  onOpenUpdate: () => void;
  apiBase?: string;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const t = useT();
  const [state, setState] = useState<"current" | "available" | "error" | "attention" | "urgent">("current");
  const open = useRef(onOpenUpdate);
  useEffect(() => { open.current = onOpenUpdate; }, [onOpenUpdate]);
  useEffect(() => {
    let stopped = false;
    let running = false;
    let lastChecked = 0;
    let shownUrgent: string | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const check = async (force = false) => {
      if (stopped || running || document.hidden || (!force && Date.now() - lastChecked < 5 * 60_000)) return;
      running = true;
      let delay = 2 * 60_000;
      try {
        const response = await fetch(`${apiBase}/api/update/check`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]) });
        if (!response.ok) throw new Error("update check failed");
        const result = await response.json();
        if (stopped) return;
        if (!result.latestVersion) throw new Error("version unavailable");
        lastChecked = Date.now();
        delay = 30 * 60_000;
        const urgent = result.updateAvailable && result.releaseInfo?.urgency === "urgent";
        setState(urgent ? "urgent" : result.updateAvailable ? "available"
          : result.automaticUpdates?.enabled && !result.automaticUpdates?.configured ? "attention" : "current");
        if (urgent && shownUrgent !== result.latestVersion) { shownUrgent = result.latestVersion; open.current(); }
      } catch { if (!stopped) setState("error"); }
      finally { running = false; if (!stopped) { clearTimeout(timer); timer = setTimeout(() => { void check(true); }, delay); } }
    };
    const wake = () => { void check(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    void check();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", wake); window.removeEventListener("online", wake); };
  }, [apiBase]);

  return (
    <button
      ref={triggerRef}
      type="button"
      className="sidebar-link sidebar-update-action"
      onClick={onOpenUpdate}
      aria-label={t("sidebar.checkUpdate")}
      title={t("sidebar.checkUpdate")}
    >
      <IconDownload aria-hidden="true" />
      <span>{t("sidebar.checkUpdate")}</span>
      {state !== "current" && <span role="status">{t(state === "urgent" ? "dash.updateUrgent" : state === "available" ? "dash.updateAvailable" : state === "attention" ? "dash.updateNeedsAttention" : "dash.updateUnavailable")}</span>}
    </button>
  );
}
