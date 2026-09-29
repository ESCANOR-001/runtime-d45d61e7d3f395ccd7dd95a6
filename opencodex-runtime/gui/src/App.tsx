import { useEffect, useRef, useState } from "react";
import { useKeyedClientResource } from "./client-resource";
import { NativeLogs as Logs, NativeUsage as Usage, NativeGuide as Guide } from "./pages/NativeActivity";
import Storage from "./pages/Storage";
import AndroidRemote from "./pages/AndroidRemote";
import ErrorBoundary from "./components/ErrorBoundary";
import { SidebarUpdateAction } from "./components/sidebar-update-action";
import Updates from "./pages/Updates";
import AdvancedSettings from "./pages/AdvancedSettings";
import { IconGrid, IconList, IconActivity, IconHardDrive, IconMenu, IconSun, IconMoon, IconMonitor, IconGlobe, IconPower, IconSmartphone, IconBookOpen, IconX } from "./icons";
import { useI18n, useT, LOCALES, type Locale, type TKey } from "./i18n/shared";
import { Select } from "./ui";
import { installApiAuthFetch } from "./api";
import { type Page } from "./app-routing";
import { useAppRouteState } from "./use-app-route-state";
import { requestProxyStop } from "./stop-proxy";
import { readDesktopRuntimeStatus, setDesktopProxyRunning, type DesktopRuntimeStatus } from "./desktop-runtime";

installApiAuthFetch();

type Theme = "light" | "dark" | "system";

const PAGE_TKEY: Record<Page, TKey> = {
  dashboard: "remote.advanced.updates",
  startup: "nav.startup",
  providers: "nav.providers",
  models: "nav.models",
  subagents: "nav.subagents",
  logs: "nav.logs",
  "desktop-logs": "nav.desktopLogs",
  usage: "nav.usage",
  storage: "nav.storage",
  "codex-auth": "nav.codexAuth",
  integrations: "nav.integrations",
  "android-remote": "nav.androidRemote",
  guide: "nav.guide",
  advanced: "advanced.title",
};

const API_BASE = import.meta.env.VITE_API_BASE || "";
const THEME_KEY = "ocx-theme";

type NavEntry = {
  id: Page;
  tkey: TKey;
  Icon: typeof IconGrid;
};

const NAV: NavEntry[] = [
  { id: "android-remote", tkey: "nav.androidRemote", Icon: IconSmartphone },
  { id: "logs", tkey: "nav.logs", Icon: IconList },
  { id: "usage", tkey: "nav.usage", Icon: IconActivity },
  { id: "storage", tkey: "nav.storage", Icon: IconHardDrive },
  { id: "guide", tkey: "nav.guide", Icon: IconBookOpen },
  { id: "advanced", tkey: "advanced.title", Icon: IconMonitor },
];

const THEME_ICON = { light: IconSun, dark: IconMoon, system: IconMonitor } as const;
const THEME_TKEY: Record<Theme, TKey> = { light: "theme.light", dark: "theme.dark", system: "theme.system" };

function readRuntimeVersion(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("version" in data)) return null;
  const version = (data as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

function readStoredTheme(): Theme {
  const t = localStorage.getItem(THEME_KEY);
  return t === "light" || t === "dark" ? t : "system";
}

export default function App() {
  const { page, navigateToPage } = useAppRouteState();
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const { locale, setLocale } = useI18n();
  const t = useT();

  // Narrow screens: the sidebar becomes an off-canvas drawer behind a hamburger toggle.
  const [navOpen, setNavOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const updateTriggerRef = useRef<HTMLButtonElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const navWasOpen = useRef(false);

  useEffect(() => {
    // External navigation (hash edit, back/forward) also dismisses the mobile drawer.
    const dismissNav = () => setNavOpen(false);
    window.addEventListener("hashchange", dismissNav);
    window.addEventListener("popstate", dismissNav);
    return () => {
      window.removeEventListener("hashchange", dismissNav);
      window.removeEventListener("popstate", dismissNav);
    };
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") { el.removeAttribute("data-theme"); localStorage.removeItem(THEME_KEY); }
    else { el.setAttribute("data-theme", theme); localStorage.setItem(THEME_KEY, theme); }
  }, [theme]);

  const healthPoll = useKeyedClientResource(
    `app-healthz:${API_BASE}`,
    [],
    async (signal) => {
      const res = await fetch(`${API_BASE}/healthz`, { signal });
      if (!res.ok) return null;
      return readRuntimeVersion(await res.json());
    },
    { pollMs: 30_000 },
  );

  const cycleTheme = () => setTheme(t => (t === "light" ? "dark" : t === "dark" ? "system" : "light"));
  const ThemeIcon = THEME_ICON[theme];
  const displayedVersion: string = healthPoll.data ?? __APP_VERSION__;

  const [proxyActionPending, setProxyActionPending] = useState(false);
  const [desktopRuntime, setDesktopRuntime] = useState<DesktopRuntimeStatus | null>(null);
  const sawDesktopOffline = useRef(false);
  const desktopReadyChecks = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const status = await readDesktopRuntimeStatus();
      if (!cancelled && status) setDesktopRuntime(status);
      if (!cancelled) timer = setTimeout(poll, 1_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!desktopRuntime) return;
    if (desktopRuntime.state === "offline") {
      sawDesktopOffline.current = true;
      desktopReadyChecks.current = 0;
      return;
    }
    if (desktopRuntime.state === "starting" || desktopRuntime.state === "stopping") {
      desktopReadyChecks.current = 0;
      return;
    }
    if (sawDesktopOffline.current && (desktopRuntime.state === "ready" || desktopRuntime.state === "degraded")) {
      // The desktop bridge can report ready while the newly-started HTTP listener is still
      // settling. Require a few consecutive samples before reloading the shell, otherwise the
      // reload itself can be the first request to hit a transient connection refusal.
      desktopReadyChecks.current += 1;
      if (desktopReadyChecks.current < 3) return;
      sawDesktopOffline.current = false;
      desktopReadyChecks.current = 0;
      window.location.reload();
      return;
    }
    desktopReadyChecks.current = 0;
  }, [desktopRuntime]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setNavOpen(false); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";         // no background scroll behind the drawer
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prevOverflow; };
  }, [navOpen]);

  // Move focus into the drawer on open; hand it back to the toggle on close.
  useEffect(() => {
    if (navOpen) {
      navWasOpen.current = true;
      // after the 180ms slide-in: while visibility is transitioning, focus() no-ops
      const timer = setTimeout(() => sidebarRef.current?.focus(), 200);
      return () => clearTimeout(timer);
    }
    if (navWasOpen.current) { navWasOpen.current = false; menuBtnRef.current?.focus(); }
  }, [navOpen]);

  // Growing the window past the breakpoint dismisses the drawer state.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 761px)");
    const onChange = () => { if (mq.matches) setNavOpen(false); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const handleProxyToggle = async () => {
    const starting = desktopRuntime?.state === "offline";
    if (!starting && !confirm(t("dash.stopConfirm"))) return;
    setProxyActionPending(true);

    if (desktopRuntime) {
      try {
        setDesktopRuntime(await setDesktopProxyRunning(starting));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        alert(t(starting ? "dash.startFailed" : "dash.lifecycleFailed", { message }));
      } finally {
        setProxyActionPending(false);
      }
      return;
    }

    const outcome = await requestProxyStop(API_BASE, {
      formatFailure: status => t("dash.stopFailed", { status: String(status) }),
    });
    // Refusals and restore failures return normally instead of dropping the connection.
    // In both cases the proxy did not reach a clean-stop result, so re-enable the control
    // and surface the server's remediation instead of leaving "stopping…" stuck forever.
    if (!outcome.accepted) {
      setProxyActionPending(false);
      alert(outcome.message);
    }
  };

  const proxyControlKey: TKey = desktopRuntime?.state === "offline"
    ? "dash.start"
    : desktopRuntime?.state === "starting"
      ? "dash.starting"
      : desktopRuntime?.state === "stopping" || proxyActionPending
        ? "dash.stopping"
        : "dash.stop";
  const proxyControlDisabled = proxyActionPending
    || desktopRuntime?.state === "starting"
    || desktopRuntime?.state === "stopping";

  const brand = (
    <div className="brand">
      <span className="brand-logo" role="img" aria-label={t("app.logoAria")} />
      <span className="name">Remodex</span>
      <span className="ver">v{displayedVersion}</span>
    </div>
  );

  return (
    <div className="app">
      {/* inert while the drawer is open: keeps focus and assistive tech inside the drawer */}
      <header className="mobile-topbar" inert={navOpen}>
        <button ref={menuBtnRef} type="button" className="menu-toggle" onClick={() => setNavOpen(o => !o)}
          aria-expanded={navOpen} aria-controls="app-sidebar"
          aria-label={t(navOpen ? "nav.closeMenu" : "nav.openMenu")} title={t(navOpen ? "nav.closeMenu" : "nav.openMenu")}>
          <IconMenu />
        </button>
        {brand}
        <button type="button" className="theme-toggle stop-toggle" onClick={handleProxyToggle} disabled={proxyControlDisabled}
          aria-label={t(proxyControlKey)} title={t(proxyControlKey)}>
          <IconPower />
        </button>
      </header>
      {navOpen && <div className="drawer-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <aside id="app-sidebar" className={`sidebar${navOpen ? " open" : ""}`} ref={sidebarRef} tabIndex={-1}>
        <div className="drawer-head">
          {brand}
          <button type="button" className="menu-toggle drawer-close" onClick={() => setNavOpen(false)}
            aria-label={t("nav.closeMenu")} title={t("nav.closeMenu")}>
            <IconX />
          </button>
        </div>
        <nav>
          {/*
            The sidebar is navigation only — no row owns a mutation. That rule was
            written when the Claude row carried the Claude Code connection switch;
            ClaudeCode owns GET/PUT /api/claude-code now, and the row itself is gone.
          */}
          {NAV.map(entry => {
            const { id, tkey, Icon } = entry;
            const active = id === page || (id === "android-remote" && (page === "dashboard" || page === "codex-auth"));
            return (
              <div key={id} className="nav-entry">
                <button type="button" className={`nav-item${active ? " active" : ""}`}
                  data-page={id}
                  onClick={() => {
                    // Deliberate sidebar navigation — push a history entry.
                    navigateToPage(id);
                    setNavOpen(false);
                  }}
                  aria-current={active ? "page" : undefined}>
                  <Icon /> {t(tkey)}
                </button>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="lang-toggle">
            <IconGlobe aria-hidden />
            <Select
              value={locale}
              options={LOCALES.map(l => ({ value: l.code, label: l.name }))}
              onChange={v => setLocale(v as Locale)}
              label={t("lang.label")}
              placement="right"
              portal={false}
              style={{ flex: 1, minWidth: 0, width: "100%" }}
            />
          </div>
          <button type="button" className="theme-toggle" onClick={cycleTheme}
            aria-label={`${t("theme.label")}: ${t(THEME_TKEY[theme])}`} title={`${t("theme.label")}: ${t(THEME_TKEY[theme])}`}>
            <ThemeIcon /> <span className="mode">{t(THEME_TKEY[theme])}</span>
          </button>
          <button type="button" className="theme-toggle stop-toggle" onClick={handleProxyToggle} disabled={proxyControlDisabled}
            aria-label={t(proxyControlKey)} title={t(proxyControlKey)}>
            <IconPower /> <span className="mode">{t(proxyControlKey)}</span>
          </button>
          <SidebarUpdateAction apiBase={API_BASE} triggerRef={updateTriggerRef} onOpenUpdate={() => {
            setNavOpen(false);
            setUpdateOpen(true);
          }} />
        </div>
      </aside>

      <main className="main" inert={navOpen}>
        <div className="main-inner">
          <ErrorBoundary
            key={page}
            pageName={t(PAGE_TKEY[page])}
            title={t("errorBoundary.title")}
            message={t("errorBoundary.message")}
            detailsLabel={t("errorBoundary.details")}
            reloadLabel={t("errorBoundary.reload")}
          >
            {page === "logs" && <Logs apiBase={API_BASE} />}
            {page === "usage" && <Usage apiBase={API_BASE} />}
            {page === "storage" && <Storage apiBase={API_BASE} />}
            {page === "android-remote" && <AndroidRemote apiBase={API_BASE} />}
            {page === "guide" && <Guide />}
            {page === "advanced" && <AdvancedSettings apiBase={API_BASE} />}
          </ErrorBoundary>
        </div>
      </main>
      <Updates apiBase={API_BASE} open={updateOpen} onClose={() => setUpdateOpen(false)} triggerRef={updateTriggerRef} />
    </div>
  );
}
