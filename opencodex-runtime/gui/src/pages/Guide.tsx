import { useState } from "react";
import { navigateHash } from "../hash-routing";
import {
  IconActivity,
  IconBot,
  IconBoxes,
  IconGrid,
  IconGlobe,
  IconHardDrive,
  IconKey,
  IconList,
  IconMonitor,
  IconPower,
  IconServer,
  IconSmartphone,
} from "../icons";
import { useT, type TKey } from "../i18n/shared";
import type { Page } from "../app-routing";
import {
  readGuideAudience,
  writeGuideAudience,
  type GuideAudience,
} from "./guide-preference";

type GuideSection = {
  id: string;
  labelKey: TKey;
  beginnerKey: TKey;
  advancedKey: TKey;
  includesKey: TKey;
  target?: Page;
  Icon: typeof IconGrid;
};

const GUIDE_SECTIONS: GuideSection[] = [
  {
    id: "dashboard",
    labelKey: "nav.dashboard",
    beginnerKey: "guide.section.dashboard.beginner",
    advancedKey: "guide.section.dashboard.advanced",
    includesKey: "guide.section.dashboard.includes",
    target: "dashboard",
    Icon: IconGrid,
  },
  {
    id: "codex-auth",
    labelKey: "nav.codexAuth",
    beginnerKey: "guide.section.codexAuth.beginner",
    advancedKey: "guide.section.codexAuth.advanced",
    includesKey: "guide.section.codexAuth.includes",
    target: "codex-auth",
    Icon: IconKey,
  },
  {
    id: "providers",
    labelKey: "nav.providers",
    beginnerKey: "guide.section.providers.beginner",
    advancedKey: "guide.section.providers.advanced",
    includesKey: "guide.section.providers.includes",
    target: "providers",
    Icon: IconServer,
  },
  {
    id: "models",
    labelKey: "nav.models",
    beginnerKey: "guide.section.models.beginner",
    advancedKey: "guide.section.models.advanced",
    includesKey: "guide.section.models.includes",
    target: "models",
    Icon: IconBoxes,
  },
  {
    id: "subagents",
    labelKey: "nav.subagents",
    beginnerKey: "guide.section.subagents.beginner",
    advancedKey: "guide.section.subagents.advanced",
    includesKey: "guide.section.subagents.includes",
    target: "subagents",
    Icon: IconBot,
  },
  {
    id: "logs",
    labelKey: "nav.logs",
    beginnerKey: "guide.section.logs.beginner",
    advancedKey: "guide.section.logs.advanced",
    includesKey: "guide.section.logs.includes",
    target: "logs",
    Icon: IconList,
  },
  {
    id: "usage",
    labelKey: "nav.usage",
    beginnerKey: "guide.section.usage.beginner",
    advancedKey: "guide.section.usage.advanced",
    includesKey: "guide.section.usage.includes",
    target: "usage",
    Icon: IconActivity,
  },
  {
    id: "storage",
    labelKey: "nav.storage",
    beginnerKey: "guide.section.storage.beginner",
    advancedKey: "guide.section.storage.advanced",
    includesKey: "guide.section.storage.includes",
    target: "storage",
    Icon: IconHardDrive,
  },
  {
    id: "integrations",
    labelKey: "nav.integrations",
    beginnerKey: "guide.section.integrations.beginner",
    advancedKey: "guide.section.integrations.advanced",
    includesKey: "guide.section.integrations.includes",
    target: "integrations",
    Icon: IconGlobe,
  },
  {
    id: "android-remote",
    labelKey: "nav.androidRemote",
    beginnerKey: "guide.section.androidRemote.beginner",
    advancedKey: "guide.section.androidRemote.advanced",
    includesKey: "guide.section.androidRemote.includes",
    target: "android-remote",
    Icon: IconSmartphone,
  },
  {
    id: "startup",
    labelKey: "nav.startup",
    beginnerKey: "guide.section.startup.beginner",
    advancedKey: "guide.section.startup.advanced",
    includesKey: "guide.section.startup.includes",
    target: "startup",
    Icon: IconPower,
  },
  {
    id: "sidebar",
    labelKey: "guide.section.sidebar.title",
    beginnerKey: "guide.section.sidebar.beginner",
    advancedKey: "guide.section.sidebar.advanced",
    includesKey: "guide.section.sidebar.includes",
    Icon: IconMonitor,
  },
];

const QUICK_START_STEPS = ["connect", "models", "clients"] as const;

export default function Guide() {
  const t = useT();
  const [audience, setAudience] = useState<GuideAudience>(readGuideAudience);

  const chooseAudience = (next: GuideAudience) => {
    setAudience(next);
    writeGuideAudience(next);
  };

  return (
    <section className="guide-page">
      <div className="page-head">
        <h2>{t("guide.title")}</h2>
      </div>
      <p className="page-sub">{t("guide.subtitle")}</p>

      <section className="guide-audience" aria-labelledby="guide-audience-title">
        <div className="guide-audience-copy">
          <span className="guide-eyebrow">{t("guide.mode.label")}</span>
          <h3 id="guide-audience-title">
            {t(audience === "beginner" ? "guide.mode.beginnerTitle" : "guide.mode.advancedTitle")}
          </h3>
          <p>
            {t(audience === "beginner"
              ? "guide.mode.beginnerDescription"
              : "guide.mode.advancedDescription")}
          </p>
        </div>
        <div className="guide-mode-switch" role="group" aria-label={t("guide.mode.label")}>
          {(["beginner", "advanced"] as const).map(mode => (
            <button
              key={mode}
              type="button"
              className={audience === mode ? "active" : ""}
              data-guide-audience={mode}
              aria-pressed={audience === mode}
              onClick={() => chooseAudience(mode)}
            >
              {t(mode === "beginner" ? "guide.mode.beginner" : "guide.mode.advanced")}
            </button>
          ))}
        </div>
      </section>

      <div className="guide-content">
        <section className="guide-block" aria-labelledby="guide-quick-start-title">
          <div className="guide-block-head">
            <h3 id="guide-quick-start-title">{t("guide.quickStart.title")}</h3>
            <p>
              {t(audience === "beginner"
                ? "guide.quickStart.subtitle.beginner"
                : "guide.quickStart.subtitle.advanced")}
            </p>
          </div>
          <ol className="guide-quick-start">
            {QUICK_START_STEPS.map(step => (
              <li key={step}>
                <h4>{t(`guide.quickStart.${step}.title` as TKey)}</h4>
                <p>{t(`guide.quickStart.${step}.${audience}` as TKey)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="guide-flow" aria-labelledby="guide-flow-title">
          <div className="guide-block-head">
            <h3 id="guide-flow-title">{t("guide.flow.title")}</h3>
          </div>
          <div className="guide-flow-row" aria-label={t("guide.flow.aria")}>
            <div>
              <IconServer aria-hidden />
              <strong>{t("guide.flow.providers")}</strong>
            </div>
            <span className="guide-flow-line" aria-hidden />
            <div className="guide-flow-center">
              <IconGrid aria-hidden />
              <strong>{t("guide.flow.openCodex")}</strong>
            </div>
            <span className="guide-flow-line" aria-hidden />
            <div>
              <IconMonitor aria-hidden />
              <strong>{t("guide.flow.clients")}</strong>
            </div>
          </div>
          <p>
            {t(audience === "beginner" ? "guide.flow.note.beginner" : "guide.flow.note.advanced")}
          </p>
        </section>

        <section className="guide-block" aria-labelledby="guide-sections-title">
          <div className="guide-block-head">
            <h3 id="guide-sections-title">{t("guide.sections.title")}</h3>
            <p>
              {t(audience === "beginner"
                ? "guide.sections.subtitle.beginner"
                : "guide.sections.subtitle.advanced")}
            </p>
          </div>
          <div className="guide-section-grid">
            {GUIDE_SECTIONS.map(section => {
              const label = t(section.labelKey);
              const Icon = section.Icon;
              return (
                <article className="guide-section-card" key={section.id}>
                  <div className="guide-section-card-head">
                    <span className="guide-section-icon"><Icon aria-hidden /></span>
                    <h4>{label}</h4>
                  </div>
                  <p>{t(audience === "beginner" ? section.beginnerKey : section.advancedKey)}</p>
                  <dl>
                    <dt>{t("guide.section.includes")}</dt>
                    <dd>{t(section.includesKey)}</dd>
                  </dl>
                  {section.target && (
                    <a
                      href={`#${section.target}`}
                      onClick={event => {
                        event.preventDefault();
                        navigateHash(section.target!);
                      }}
                    >
                      {t("guide.section.open", { section: label })}
                    </a>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </section>
  );
}
