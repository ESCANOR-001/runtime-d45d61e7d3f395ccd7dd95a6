import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AGENT_CATALOG, readAgentTab, type AgentId } from "../agent-catalog";
import { navigateHash } from "../hash-routing";
import { useT } from "../i18n/shared";
import { Trans } from "../i18n/provider";
import { IconExternal, IconSmartphone } from "../icons";
import { ManagedClaudeCodeCard } from "./ManagedClaudeCodeCard";
import "./agents.css";

function ClaudeRemoteSetupGuide() {
  const t = useT();
  const steps = [
    { title: t("agents.sync.accountTitle"), body: t("agents.sync.account") },
    { title: t("agents.sync.remodexTitle"), body: t("agents.sync.remodex", {
      enable: t("managedClaude.enable"), sync: t("managedClaude.desktopSync"), auto: t("managedClaude.autoConnect"),
    }) },
    { title: t("agents.sync.desktopTitle"), body: t("managedClaude.desktopSetupSteps") },
    { title: t("agents.sync.verifyTitle"), body: t("agents.sync.verify") },
  ];
  return <section className="agent-remote-guide" aria-labelledby="claude-remote-guide-title">
    <h3 id="claude-remote-guide-title">{t("agents.sync.title")}</h3>
    <p className="agent-remote-intro">{t("agents.sync.intro")}</p>
    <ol className="agent-steps agent-remote-steps">{steps.map((step, index) => <li key={step.title}>
      <span aria-hidden="true">{index + 1}</span><div><strong>{step.title}</strong><p>{step.body}</p></div>
    </li>)}</ol>
    <div className="agent-remote-origins">
      <div><strong>{t("agents.sync.fromAndroidTitle")}</strong><p>{t("agents.sync.fromAndroid")}</p></div>
      <div><strong>{t("agents.sync.fromDesktopTitle")}</strong><p>{t("agents.sync.fromDesktop")}</p></div>
    </div>
    <p><strong>{t("agents.sync.olderTitle")}</strong> <Trans k="agents.sync.older" cmd="/remote-control" /></p>
    <p>{t("agents.sync.keepRunning")}</p>
    <p>{t("managedClaude.desktopSyncLimit")}</p>
    <a className="agent-doc-link" href="https://code.claude.com/docs/en/desktop#control-which-sessions-appear-on-your-other-devices" target="_blank" rel="noreferrer">
      {t("agents.sync.officialGuide")}<IconExternal aria-hidden="true" />
    </a>
  </section>;
}

export default function Agents({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [tab, setTab] = useState(() => readAgentTab(window.location.hash));
  const [visited, setVisited] = useState<ReadonlySet<AgentId>>(() => new Set([readAgentTab(window.location.hash)]));
  const tabs = useRef(new Map<AgentId, HTMLButtonElement>());
  const activate = (next: AgentId) => {
    setTab(next);
    setVisited(previous => previous.has(next) ? previous : new Set([...previous, next]));
  };
  useEffect(() => {
    const sync = () => activate(readAgentTab(window.location.hash));
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);
  const select = (next: AgentId) => {
    activate(next);
    navigateHash(`agents/${next}`);
    tabs.current.get(next)?.focus();
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = AGENT_CATALOG.findIndex(agent => agent.id === tab);
    const next = event.key === "ArrowRight" ? (index + 1) % AGENT_CATALOG.length
      : event.key === "ArrowLeft" ? (index - 1 + AGENT_CATALOG.length) % AGENT_CATALOG.length
      : event.key === "Home" ? 0 : event.key === "End" ? AGENT_CATALOG.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    select(AGENT_CATALOG[next].id);
  };
  return <div className="agents-page">
    <header className="agents-page-heading">
      <h2>{t("nav.agents")}</h2>
      <p className="page-sub">{t("agents.description")}</p>
    </header>
    <div className="page-tabs agents-tabs" role="tablist" aria-label={t("nav.agents")}>
      {AGENT_CATALOG.map(agent => <button type="button" role="tab" key={agent.id}
        id={`agent-tab-${agent.id}`} aria-controls={`agent-panel-${agent.id}`} aria-selected={tab === agent.id}
        tabIndex={tab === agent.id ? 0 : -1}
        ref={node => { if (node) tabs.current.set(agent.id, node); else tabs.current.delete(agent.id); }}
        className={`page-tab${tab === agent.id ? " page-tab--active" : ""}`}
        onClick={() => select(agent.id)} onKeyDown={keyDown}>
        <span className={`agent-brand agent-brand-${agent.id}`} aria-hidden="true" />{agent.name}
      </button>)}
    </div>
    {AGENT_CATALOG.map(agent => visited.has(agent.id) && <section key={agent.id}
      role="tabpanel" id={`agent-panel-${agent.id}`} aria-labelledby={`agent-tab-${agent.id}`}
      tabIndex={0} hidden={tab !== agent.id} className="agent-panel">
      <div className="agent-intro"><h3>{agent.name}</h3><p>{t(agent.description)}</p></div>
      <div className="agent-columns">
        <aside className="agent-guide" aria-labelledby={`agent-guide-${agent.id}`}>
          <h4 id={`agent-guide-${agent.id}`}>{t("agents.getStarted")}</h4>
          <ol className="agent-steps">{agent.steps.map((step, index) => <li key={step}>
            <span aria-hidden="true">{index + 1}</span><p>{step === "agents.claude.install"
              ? <Trans k={step} cmd="claude auth login" /> : t(step)}</p>
          </li>)}</ol>
          <a className="agent-doc-link" href={agent.guide} target="_blank" rel="noreferrer">
            {t("agents.installGuide")}<IconExternal aria-hidden="true" />
          </a>
          <div className="agent-pairing-note"><IconSmartphone aria-hidden="true" /><div>
            <strong>{t("agents.onePc")}</strong><p>{t("agents.onePcHint")}</p>
            <a href="#android-remote">{t("agents.manageConnection")}</a>
          </div></div>
        </aside>
        <div className="agent-controls">
          {agent.id === "claude-code" ? <ManagedClaudeCodeCard apiBase={apiBase} /> : <section className="agent-settings" aria-labelledby="codex-settings-title">
            <h4 id="codex-settings-title">{t("agents.settings")}</h4>
            <div className="agent-settings-card">
              <div className="agent-setting-copy"><strong>{t("agents.codex.account")}</strong><p>{t("agents.codex.accountHint")}</p></div>
              <div className="agent-setting-copy"><strong>{t("agents.chatSettings")}</strong><p>{t("agents.chatSettingsHint")}</p></div>
              <div className="agent-setting-copy"><strong>{t("agents.codex.connection")}</strong><p>{t("agents.codex.connectionHint")}</p>
                <a href="#android-remote">{t("agents.manageConnection")}</a></div>
            </div>
          </section>}
        </div>
      </div>
      {agent.id === "claude-code" && <ClaudeRemoteSetupGuide />}
    </section>)}
  </div>;
}
