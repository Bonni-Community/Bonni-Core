import ModuleMaintenance from './ModuleMaintenance.jsx';
import CaptureLearningModule from './CaptureLearningModule.jsx';
import AppInstallPanel from "./AppInstallPanel.jsx";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  activateControlCenterRuntimeModule,
  deactivateControlCenterRuntimeModule,
  fetchControlCenterRuntimeModuleDetails,
  fetchControlCenterRuntimeModules,
  installControlCenterRuntimeModule,
} from "../../../system/api/controlCenterRuntimeApi.js";
import {
  getControlCenterSystemSettings,
  saveControlCenterSystemSettings,
} from "../../../system/api/systemSettingsApi.js";
import { BONNI_CORE_VERSION } from "../../../system/version.js";
import { formatBonniCoreVersion } from "../update/localUpdatePresentation.js";

import { controlCenterLabels as labels, labelKind, labelStatus } from "../language/index.js";
import {
  STORE_LANGUAGES,
  STORE_LANGUAGE_MODE_AUTO,
  localizedStoreDescription,
  localizedStoreShortDescription,
  localizedStoreTitle,
  readStoreLanguageMode,
  resolveStoreLanguage,
  saveStoreLanguageMode,
  storeLanguageDirection,
  storeLanguageLabel,
  storeSupportInfo,
} from "./storeLocalization.js";
import { stueberlStorePresentation } from "./stueberlStorePresentation.js";
import { gourmetStorePresentation } from "./gourmetStorePresentation.js";
import meetAppLogo from "./meetapp-logo.png";

import "./StorePage.css";

const FILTERS = [
  { key: "installed", label: "Installiert" },
  { key: "updates", label: "Updates" },
  { key: "all", label: "Alle Pakete", separated: true },
  { key: "app", label: "Apps" },
  { key: "addon", label: "Addons" },
  { key: "plugin", label: "Plugins" },
  { key: "bridge", label: "Bridges" },
  { key: "license", label: "Lizenzen" },
];

const STORE_SECTIONS = [
  { key: "recent", title: "Zuletzt hinzugefügt", badge: "Neu" },
  { key: "spotlight", title: "Spotlight", badge: "Empfohlen" },
  { key: "installed", title: "Installierte Pakete", badge: "Aktiv" },
];

const PACKAGE_PRESENTATIONS = new Map([
  ["app.stueberlapp", stueberlStorePresentation],
  ["addon.gourmet", gourmetStorePresentation],
  ["app.meetapp", { logo: meetAppLogo }],
]);

const ICONS = {
  app: "▦",
  addon: "▣",
  plugin: "◈",
  bridge: "⇄",
  provider: "☁",
  platform: "⌘",
  system: "●",
  frontend: "◫",
  internal: "◇",
};

const CAPTURE_KEY = "addon.capture";
const CAPTURE_RECORD_TABS = [
  { key: "description", label: "Allgemein" },
  { key: "training", label: "Training" },
  { key: "learning", label: "Lernmodul" },
];
const TWO_FACTOR_PLUGIN_KEY = "plugin.privacyidea";
const CORE_RECORD_KEY = "bonni-core";
const STORE_FEEDBACK_DRAFT_PREFIX = "bonni.store.feedback.";

const STORE_FEEDBACK_CATEGORIES = Object.freeze([
  "Verbesserungsvorschlag",
  "Fehler melden",
  "Bedienung und Darstellung",
  "Installationshilfe und Dokumentation",
]);

const TWO_FACTOR_INSTALLATION_GUIDE = Object.freeze({
  de: {
    title: "privacyIDEA-Adapter administrieren",
    intro: "Diese Hilfe richtet den optionalen externen Anbieter ein. Persoenliche 2FA-Einrichtungen erfolgen ausschliesslich in den zentralen Bonni-Core-Einstellungen.",
    steps: [
      ["Plugin installieren", "Installiere und aktiviere den privacyIDEA-Adapter im Bonni Store."],
      ["Verbindung eintragen", "Trage die HTTPS-Adresse des privacyIDEA-Servers und – falls verwendet – den Realm ein."],
      ["Sicherheitsregeln festlegen", "Lege Gueltigkeit, erlaubte Versuche sowie die vom Anbieter geforderten Prueffelder fest."],
      ["Verbindung pruefen", "Speichere die Adapterkonfiguration und pruefe die Erreichbarkeit ohne Benutzergeheimnisse in Bonni zu uebernehmen."],
      ["Benutzer zentral freigeben", "Administratoren stossen die 2FA-Einrichtung kontogenau an. Benutzer schliessen sie in „Einstellungen“ ab."],
    ],
    privacyIdeaNote: "Wichtig: Der Store zeigt niemals persoenliche Token, QR-Codes, Freigabepasswoerter oder Wiederherstellungscodes an.",
  },
  en: {
    title: "Administer the privacyIDEA adapter",
    intro: "This guide configures the optional external provider. Personal 2FA enrollment is available only in the central Bonni Core settings.",
    steps: [
      ["Install the plugin", "Install and activate the privacyIDEA adapter in the Bonni Store."],
      ["Enter the connection", "Enter the HTTPS address of the privacyIDEA server and its realm if one is used."],
      ["Set the security policy", "Choose validity, allowed attempts and the proof fields required by the provider."],
      ["Test the connection", "Save the adapter configuration and test availability without importing user secrets into Bonni."],
      ["Approve users centrally", "Administrators initiate 2FA for an exact account. Users finish it in My Settings."],
    ],
    privacyIdeaNote: "Important: The Store never displays personal tokens, QR codes, enrollment passwords or recovery codes.",
  },
});

function titleOf(module, language = "en") {
  return localizedStoreTitle(module, language);
}

function shortDescriptionOf(module, language = "en") {
  return localizedStoreShortDescription(module, language);
}

function descriptionOf(module, language = "en") {
  return localizedStoreDescription(module, language);
}

function versionOf(module) {
  const version = module?.version || module?.manifest?.version || module?.installation?.version || module?.installedVersion || "";
  return module?.source === "bonni-core" ? formatBonniCoreVersion(version) : version || "—";
}

function keyOf(module) {
  return module?.key || module?.id || module?.manifestId || titleOf(module);
}

function kindOf(module) {
  return String(module?.kind || module?.type || "internal").toLowerCase();
}

function kindLabel(kind) {
  return labelKind(kind, labels) || kind;
}

function readStoreFeedbackDraft(moduleKey) {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(`${STORE_FEEDBACK_DRAFT_PREFIX}${moduleKey}`) || "{}") || {};
  } catch {
    return {};
  }
}

function buildStoreFeedbackText({ category, title, description, includeTechnicalDetails, module, language }) {
  const lines = [
    `## ${title.trim()}`,
    "",
    `**Kategorie:** ${category}`,
    "",
    "### Beschreibung",
    description.trim(),
  ];
  if (includeTechnicalDetails) {
    lines.push(
      "",
      "### Technische Angaben",
      `- Paket: ${keyOf(module)}`,
      `- Plugin-Version: ${versionOf(module)}`,
      `- Bonni-Core-Version: ${formatBonniCoreVersion(BONNI_CORE_VERSION)}`,
      `- Oberflächensprache: ${language || "—"}`,
    );
  }
  return lines.join("\n");
}

function buildGithubFeedbackUrl(baseUrl, title, body) {
  try {
    const target = new URL(baseUrl);
    if (target.protocol !== "https:" || target.hostname.toLowerCase() !== "github.com") return "";
    target.searchParams.set("title", title.trim());
    target.searchParams.set("body", body);
    return target.toString();
  } catch {
    return "";
  }
}

async function copyStoreFeedback(value) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

function isInstalled(module) {
  return Boolean(module?.installed || module?.enabled || module?.installedVersion || module?.installation?.installed);
}

function isActive(module) {
  return Boolean(module?.enabled || module?.runtimeStatus === "active" || module?.status === "active");
}

function hasUpdate(module) {
  return Boolean(module?.updateAvailable || module?.upgradeAvailable || module?.installStatus === "to_upgrade");
}

function isCompatible(module) {
  return module?.compatible !== false && module?.compatibility?.ok !== false;
}

function statusText(module) {
  if (!isCompatible(module)) return "Nicht kompatibel";
  if (isActive(module)) return labels.status.active;
  if (isInstalled(module)) return labels.status.installed;
  if (hasUpdate(module)) return "Update verfügbar";
  return labelStatus(module?.installStatus || module?.status || "not-installed", labels);
}

function statusClass(module) {
  if (!isCompatible(module)) return "is-error";
  if (module?.installStatus === "failed" || module?.status === "failed") return "is-error";
  if (hasUpdate(module)) return "is-update";
  if (isActive(module)) return "is-active";
  if (isInstalled(module)) return "is-installed";
  return "is-available";
}

function packageIcon(module) {
  const key = keyOf(module).toLowerCase();
  const logo = PACKAGE_PRESENTATIONS.get(key)?.logo;
  if (logo) return <img className="store-package-logo" src={logo} alt="" />;
  if (key.includes("pos")) return "▣";
  if (key.includes("oidc") || key.includes("auth")) return "🔐";
  if (key.includes("dsgvo") || key.includes("privacy")) return "🛡";
  if (key.includes("timecapsule")) return "◷";
  if (key.includes("datev")) return "⇄";
  if (key.includes("loader")) return "◈";
  return ICONS[kindOf(module)] || "□";
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function normalizePayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.modules)) return payload.modules;
  if (Array.isArray(payload?.packages)) return payload.packages;
  return [];
}

function matchesFilter(module, filter, language = "en") {
  const kind = kindOf(module);
  if (filter === "all") return true;
  if (filter === "installed") return isInstalled(module);
  if (filter === "updates") return hasUpdate(module);
  if (filter === "app" && keyOf(module) === CAPTURE_KEY) return true;
  if (filter === "license") {
    const key = keyOf(module).toLowerCase();
    const title = titleOf(module, language).toLowerCase();
    return kind === "license" || kind === "licence" || key.includes("license") || key.includes("lizenz") || title.includes("license") || title.includes("lizenz");
  }
  return kind === filter;
}

function matchesSearch(module, search, language = "en") {
  const needle = lower(search).trim();
  if (!needle) return true;

  const haystack = [
    keyOf(module),
    titleOf(module, language),
    shortDescriptionOf(module, language),
    descriptionOf(module, language),
    kindOf(module),
    module?.owner,
    module?.sourceRoot,
    ...(module?.provides || []),
    ...(module?.dependsOn || []),
    ...(module?.installProfiles || []),
  ].map(lower).join(" ");

  return haystack.includes(needle);
}

function buildCounts(modules) {
  return {
    total: modules.length,
    active: modules.filter(isActive).length,
    installed: modules.filter(isInstalled).length,
    apps: modules.filter((module) => matchesFilter(module, "app")).length,
    addons: modules.filter((module) => kindOf(module) === "addon").length,
    plugins: modules.filter((module) => kindOf(module) === "plugin").length,
    bridges: modules.filter((module) => kindOf(module) === "bridge").length,
    licenses: modules.filter((module) => matchesFilter(module, "license")).length,
    installedApps: modules.filter((module) => isInstalled(module) && kindOf(module) === "app").length,
    installedAddons: modules.filter((module) => isInstalled(module) && kindOf(module) === "addon").length,
    installedPlugins: modules.filter((module) => isInstalled(module) && kindOf(module) === "plugin").length,
    installedBridges: modules.filter((module) => isInstalled(module) && kindOf(module) === "bridge").length,
    installedLicenses: modules.filter((module) => isInstalled(module) && matchesFilter(module, "license")).length,
    updates: modules.filter(hasUpdate).length,
  };
}

function sortPackages(modules, sortMode, language = "en") {
  const next = [...modules];
  if (sortMode === "name") return next.sort((a, b) => titleOf(a, language).localeCompare(titleOf(b, language), language));
  if (sortMode === "kind") return next.sort((a, b) => kindOf(a).localeCompare(kindOf(b), language) || titleOf(a, language).localeCompare(titleOf(b, language), language));
  if (sortMode === "installed") return next.sort((a, b) => Number(isInstalled(b)) - Number(isInstalled(a)) || titleOf(a, language).localeCompare(titleOf(b, language), language));
  return next.sort((a, b) => keyOf(a).localeCompare(keyOf(b), language));
}

function getSectionPackages(modules, sectionKey, language = "en") {
  if (sectionKey === "installed") return modules.filter(isInstalled).slice(0, 8);
  if (sectionKey === "spotlight") {
    const wanted = ["pos", "oidc", "dsgvo", "timecapsule", "datev", "module-loader", "security", "permissions"];
    const spotlight = modules.filter((module) => wanted.some((term) => keyOf(module).toLowerCase().includes(term) || titleOf(module, language).toLowerCase().includes(term)));
    return (spotlight.length ? spotlight : modules).slice(0, 8);
  }
  return modules.slice(0, 8);
}

function SummaryBar({ counts }) {
  const items = [
    { key: "active", label: "Aktiv", value: counts.active },
    { key: "apps", label: "Apps", value: counts.installedApps },
    { key: "addons", label: "Addons", value: counts.installedAddons },
    { key: "plugins", label: "Plugins", value: counts.installedPlugins },
    { key: "bridges", label: "Bridges", value: counts.installedBridges },
  ];

  return (
    <section className="store-summary" aria-label="Store Übersicht">
      {items.map((item) => (
        <article key={item.key} className="store-summary-card">
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </article>
      ))}
    </section>
  );
}

function StoreSidebar({ activeFilter, counts, languageMode, storeLanguage, onFilterChange, onLanguageChange, onOpenSettings }) {
  return (
    <aside className="store-sidebar" aria-label="Store Navigation">
      <div className="store-sidebar__block">
        {FILTERS.map((filter) => {
          const amount = filter.key === "all"
            ? counts.total
            : filter.key === "installed"
              ? counts.installed
              : filter.key === "updates"
                ? counts.updates
                : filter.key === "license"
                  ? counts.licenses
                  : counts[`${filter.key}s`] || 0;

          return (
            <button
              key={filter.key}
              type="button"
              className={`store-sidebar-item${filter.separated ? " is-separated" : ""}${activeFilter === filter.key ? " is-active" : ""}`}
              onClick={() => onFilterChange(filter.key)}
            >
              <span>{filter.label}</span>
              <b>{amount}</b>
            </button>
          );
        })}
      </div>

      <label className="store-sidebar__block store-sidebar__meta store-language-picker" htmlFor="store-language">
        <span>Sprache der Beschreibung</span>
        <select id="store-language" value={languageMode} onChange={(event) => onLanguageChange(event.target.value)}>
          <option value={STORE_LANGUAGE_MODE_AUTO}>Automatisch ({storeLanguageLabel(storeLanguage)})</option>
          {STORE_LANGUAGES.map((language) => (
            <option key={language.code} value={language.code}>{language.label}</option>
          ))}
        </select>
        <small>Die Kurzbeschreibung kommt direkt aus dem Paket-Manifest.</small>
      </label>

      <button type="button" className="store-sidebar-refresh" onClick={onOpenSettings}>
        Einstellungen
      </button>
    </aside>
  );
}

function StorePackageCard({ module, language, selected, onSelect, onInstall, onActivate, onDeactivate, busy }) {
  const installed = isInstalled(module);
  const active = isActive(module);
  const key = keyOf(module);
  const disabled = Boolean(busy);
  const support = storeSupportInfo(module);
  const compatible = isCompatible(module);

  function handleAction(event, action) {
    event.stopPropagation();
    action?.();
  }

  return (
    <article className={`store-package-card ${statusClass(module)} ${selected ? "is-selected" : ""}`}>
      <button type="button" className="store-package-card__main" onClick={() => onSelect(module)}>
        <span className={`store-package-card__icon${module.appUpdate ? " has-app-update" : ""}`} aria-hidden="true">
          {packageIcon(module)}
          {module.appUpdate ? <><span className="store-app-update-arrow">↑</span><small className="store-app-update-version">{module.appUpdate.version}</small></> : null}
        </span>
        {module.appUpdate ? <span className="store-app-update-accessible">Neue Version {module.appUpdate.version} verfügbar.</span> : null}
        <span className="store-package-card__body">
          <span className="store-package-card__topline">
            <strong>{titleOf(module, language)}</strong>
            <em>v{versionOf(module)}</em>
          </span>
          <span className="store-package-card__badges">
            <b>{kindLabel(kindOf(module))}</b>
            <i>{statusText(module)}</i>
            {support?.independentlySupported ? <i>Eigener Support</i> : null}
          </span>
          <span className="store-package-card__description" lang={language} dir={storeLanguageDirection(language)}>
            {shortDescriptionOf(module, language)}
          </span>
          <small>{key}</small>
        </span>
      </button>

      <div className="store-package-card__actions">
        <button type="button" onClick={(event) => handleAction(event, () => onSelect(module))}>Info</button>
        {!installed ? (
          <button type="button" className="is-primary" disabled={disabled || !compatible} onClick={(event) => handleAction(event, onInstall)}>
            {compatible ? "Installieren" : "Nicht kompatibel"}
          </button>
        ) : active ? (
          <button type="button" disabled={disabled} onClick={(event) => handleAction(event, onDeactivate)}>
            Deaktivieren
          </button>
        ) : (
          <button type="button" className="is-primary" disabled={disabled || !compatible} onClick={(event) => handleAction(event, onActivate)}>
            {compatible ? "Aktivieren" : "Nicht kompatibel"}
          </button>
        )}
      </div>
    </article>
  );
}

function StoreSection({ section, modules, language, selectedKey, onSelect, onInstall, onActivate, onDeactivate, busy }) {
  const items = getSectionPackages(modules, section.key, language);
  if (!items.length) return null;

  return (
    <section className="store-section">
      <div className="store-section__head">
        <div>
          <span>{section.badge}</span>
          <h2>{section.title}</h2>
        </div>
        <small>{items.length} Pakete</small>
      </div>
      <div className="store-card-grid">
        {items.map((module) => (
          <StorePackageCard
            key={keyOf(module)}
            module={module}
            language={language}
            selected={selectedKey === keyOf(module)}
            onSelect={onSelect}
            onInstall={() => onInstall(module)}
            onActivate={() => onActivate(module)}
            onDeactivate={() => onDeactivate(module)}
            busy={busy}
          />
        ))}
      </div>
    </section>
  );
}

function StoreTwoFactorField({ field, value, onChange }) {
  if (field.type === "select") {
    return (
      <label className="store-2fa-field">
        <span>{field.label}</span>
        <select value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
          {(field.options || []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {field.help ? <small>{field.help}</small> : null}
      </label>
    );
  }
  if (field.type === "checkbox") {
    return (
      <label className="store-2fa-field store-2fa-field--checkbox">
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.label}</span>
        {field.help ? <small>{field.help}</small> : null}
      </label>
    );
  }
  return (
    <label className="store-2fa-field">
      <span>{field.label}</span>
      <input
        type={field.type === "number" ? "number" : field.type === "password" ? "password" : "text"}
        value={value ?? ""}
        placeholder={field.placeholder || ""}
        min={field.min}
        max={field.max}
        onChange={(event) => onChange(field.type === "number" ? Number(event.target.value) : event.target.value)}
      />
      {field.help ? <small>{field.help}</small> : null}
    </label>
  );
}

function normalizeTwoFactorSettings(settings) {
  const twoFactor = settings?.twoFactor || {};
  return {
    provider: twoFactor.provider || "local",
    configured: twoFactor.configured !== false,
    externalProviders: Array.isArray(twoFactor.externalProviders) ? twoFactor.externalProviders : [],
  };
}

function StoreTwoFactorProviderSetup({ token }) {
  const [systemSettings, setSystemSettings] = useState(null);
  const [draft, setDraft] = useState(() => normalizeTwoFactorSettings(null));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const nextSettings = await getControlCenterSystemSettings(token);
      setSystemSettings(nextSettings);
      setDraft(normalizeTwoFactorSettings(nextSettings));
    } catch (loadError) {
      setError(loadError?.message || "Die 2FA-Einstellungen konnten nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [token]);

  const externalProviders = draft.externalProviders || [];
  const selectedExternal = externalProviders.find((provider) => (
    String(provider?.id || "").toLowerCase().includes("privacyidea")
  )) || null;
  const values = selectedExternal?.configuration?.values || {};

  function patchProviderValue(name, value) {
    if (!selectedExternal) return;
    setDraft((current) => ({
      ...current,
      externalProviders: current.externalProviders.map((provider) => provider.id === selectedExternal.id
        ? {
            ...provider,
            configuration: {
              ...provider.configuration,
              values: { ...(provider.configuration?.values || {}), [name]: value },
            },
          }
        : provider),
    }));
  }

  async function save() {
    if (!systemSettings) return;
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const result = await saveControlCenterSystemSettings(token, {
        oidc: systemSettings.oidc || {},
        twoFactor: draft,
        database: systemSettings.database || {},
        json: systemSettings.json || {},
      });
      setSystemSettings(result);
      setDraft(normalizeTwoFactorSettings(result));
      setMessage("Die privacyIDEA-Adapterkonfiguration wurde gespeichert.");
    } catch (saveError) {
      setError(saveError?.message || "Die 2FA-Konfiguration konnte nicht gespeichert werden.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="store-detail-block"><p>Adapterkonfiguration wird geladen …</p></div>;

  return (
    <div className="store-2fa-setup">
      {message ? <div className="store-alert store-alert--success">{message}</div> : null}
      {error ? <div className="store-alert store-alert--error">{error}</div> : null}

      <section className="store-detail-block">
        <div className="store-2fa-section-head">
          <div>
            <h3>privacyIDEA-Adapter</h3>
            <p>Hier verwalten Administratoren nur die Verbindung und Richtlinie des externen Anbieters.</p>
          </div>
          <span className={selectedExternal ? "store-2fa-ready is-ready" : "store-2fa-ready"}>{selectedExternal ? "Registriert" : "Nicht registriert"}</span>
        </div>
        <div className="store-2fa-provider-note">
          <strong>Keine persoenlichen 2FA-Daten im Store</strong>
          <p>Benutzerauftraege, Freigabepasswoerter, QR-Codes und Wiederherstellungscodes werden ausschliesslich in den dafuer vorgesehenen Core-Oberflaechen verarbeitet.</p>
        </div>
      </section>

      {selectedExternal ? selectedExternal.configuration?.sections?.map((section) => (
        <section className="store-detail-block" key={section.title}>
          <h3>{section.title}</h3>
          {section.description ? <p>{section.description}</p> : null}
          <div className="store-2fa-form-grid">
            {(section.fields || []).map((field) => (
              <StoreTwoFactorField key={field.name} field={field} value={values[field.name]} onChange={(value) => patchProviderValue(field.name, value)} />
            ))}
          </div>
        </section>
      )) : <section className="store-detail-block"><p>Der privacyIDEA-Adapter ist noch nicht registriert. Installiere oder aktiviere zuerst das Plugin.</p></section>}

      <div className="store-2fa-footer">
        <button type="button" onClick={load} disabled={saving}>Neu laden</button>
        <button type="button" className="store-2fa-primary" onClick={save} disabled={saving || !selectedExternal}>{saving ? "Speichert …" : "Adapterkonfiguration speichern"}</button>
      </div>
    </div>
  );
}

function StoreTwoFactorGuide({ language, guideLanguage, onGuideLanguageChange }) {
  const resolvedLanguage = guideLanguage === "auto" ? (language === "de" ? "de" : "en") : guideLanguage;
  const guide = TWO_FACTOR_INSTALLATION_GUIDE[resolvedLanguage] || TWO_FACTOR_INSTALLATION_GUIDE.en;
  return (
    <div className="store-2fa-guide" lang={resolvedLanguage}>
      <div className="store-2fa-guide__head">
        <div><h3>{guide.title}</h3><p>{guide.intro}</p></div>
        <label className="store-2fa-guide-language">
          <span>{resolvedLanguage === "de" ? "Sprache" : "Language"}</span>
          <select value={guideLanguage} onChange={(event) => onGuideLanguageChange(event.target.value)}>
            <option value="auto">Auto</option>
            <option value="de">DE</option>
            <option value="en">EN</option>
          </select>
        </label>
      </div>
      <ol className="store-2fa-guide__steps">
        {guide.steps.map(([title, description], index) => (
          <li key={title}>
            <div><span>{index + 1}</span><h4>{title}</h4><p>{description}</p></div>
          </li>
        ))}
      </ol>
      <div className="store-2fa-guide__note">{guide.privacyIdeaNote}</div>
    </div>
  );
}

function StorePluginFeedback({ module, language, support }) {
  const moduleKey = keyOf(module);
  const initialDraft = useMemo(() => readStoreFeedbackDraft(moduleKey), [moduleKey]);
  const [category, setCategory] = useState(initialDraft.category || STORE_FEEDBACK_CATEGORIES[0]);
  const [title, setTitle] = useState(initialDraft.title || "");
  const [description, setDescription] = useState(initialDraft.description || "");
  const [includeTechnicalDetails, setIncludeTechnicalDetails] = useState(initialDraft.includeTechnicalDetails === true);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const updateOnlineStatus = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, []);

  useEffect(() => {
    if (!title.trim() && !description.trim() && category === STORE_FEEDBACK_CATEGORIES[0] && !includeTechnicalDetails) {
      window.localStorage.removeItem(`${STORE_FEEDBACK_DRAFT_PREFIX}${moduleKey}`);
      return;
    }
    window.localStorage.setItem(`${STORE_FEEDBACK_DRAFT_PREFIX}${moduleKey}`, JSON.stringify({
      category,
      title,
      description,
      includeTechnicalDetails,
    }));
  }, [category, description, includeTechnicalDetails, moduleKey, title]);

  const feedbackText = useMemo(() => buildStoreFeedbackText({
    category,
    title,
    description,
    includeTechnicalDetails,
    module,
    language,
  }), [category, description, includeTechnicalDetails, language, module, title]);
  const githubUrl = buildGithubFeedbackUrl(support?.url || "", title, feedbackText);
  const valid = title.trim().length >= 5 && description.trim().length >= 20;

  const clearStatus = () => {
    setMessage("");
    setError("");
  };

  const handleCopy = async () => {
    clearStatus();
    if (!valid) {
      setError("Bitte gib einen kurzen Titel und eine Beschreibung mit mindestens 20 Zeichen ein.");
      return;
    }
    try {
      await copyStoreFeedback(feedbackText);
      setMessage("Der Vorschlag wurde in die Zwischenablage kopiert.");
    } catch {
      setError("Der Text konnte nicht automatisch kopiert werden. Bitte markiere ihn manuell.");
    }
  };

  const handleGithub = () => {
    clearStatus();
    if (!valid) {
      setError("Bitte gib einen kurzen Titel und eine Beschreibung mit mindestens 20 Zeichen ein.");
      return;
    }
    if (!online) {
      setError("Bonni Core ist derzeit offline. Dein Entwurf bleibt lokal gespeichert und kann später geöffnet werden.");
      return;
    }
    if (!githubUrl) {
      setError("Für dieses Plugin ist noch keine gültige GitHub-Adresse hinterlegt.");
      return;
    }
    window.open(githubUrl, "_blank", "noopener,noreferrer");
    setMessage("GitHub wurde geöffnet. Bitte prüfe den Vorschlag dort und bestätige ihn anschließend.");
  };

  const handleEmail = () => {
    clearStatus();
    if (!valid) {
      setError("Bitte gib einen kurzen Titel und eine Beschreibung mit mindestens 20 Zeichen ein.");
      return;
    }
    if (!online) {
      setError("Bonni Core ist derzeit offline. Dein Entwurf bleibt lokal gespeichert.");
      return;
    }
    window.location.href = `mailto:${encodeURIComponent(support.email)}?subject=${encodeURIComponent(title.trim())}&body=${encodeURIComponent(feedbackText)}`;
    setMessage("Das E-Mail-Programm wurde geöffnet. Bitte prüfe die Nachricht und sende sie dort ab.");
  };

  const handleClear = () => {
    setCategory(STORE_FEEDBACK_CATEGORIES[0]);
    setTitle("");
    setDescription("");
    setIncludeTechnicalDetails(false);
    window.localStorage.removeItem(`${STORE_FEEDBACK_DRAFT_PREFIX}${moduleKey}`);
    setError("");
    setMessage("Der lokale Entwurf wurde gelöscht.");
  };

  return (
    <div className="store-feedback">
      <div className="store-feedback__head">
        <div>
          <h3>Feedback und Verbesserungsvorschläge</h3>
          <p>Beschreibe hier eine Idee, einen Fehler oder einen Wunsch für dieses Plugin.</p>
        </div>
        <span className={`store-feedback__connection${online ? " is-online" : " is-offline"}`}>{online ? "Online" : "Nur lokal"}</span>
      </div>

      <div className="store-feedback__notice">
        <strong>Wann wird etwas übertragen?</strong>
        <p>Bonni Core kann vollständig lokal betrieben werden. Deshalb wird deine Eingabe zunächst nur als Entwurf in diesem Browser gespeichert. Erst bei bestehender Internetverbindung und nach einem Klick auf „Auf GitHub öffnen“ wird eine Übermittlung vorbereitet. GitHub öffnet sich in einem neuen Fenster; dort kannst du den Inhalt nochmals prüfen und endgültig absenden.</p>
      </div>

      <div className="store-feedback__security">Keine Passwörter, Token, QR-Geheimnisse oder Wiederherstellungscodes eintragen.</div>

      <div className="store-feedback__form">
        <label>
          <span>Kategorie</span>
          <select value={category} onChange={(event) => { setCategory(event.target.value); clearStatus(); }}>
            {STORE_FEEDBACK_CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label>
          <span>Titel</span>
          <input maxLength={120} value={title} onChange={(event) => { setTitle(event.target.value); clearStatus(); }} placeholder="Was möchtest du verbessern?" />
          <small>{title.length}/120 Zeichen</small>
        </label>
        <label className="store-feedback__description">
          <span>Beschreibung</span>
          <textarea maxLength={5000} rows={10} value={description} onChange={(event) => { setDescription(event.target.value); clearStatus(); }} placeholder="Beschreibe deinen Vorschlag möglichst verständlich. Was ist heute schwierig und wie könnte es besser funktionieren?" />
          <small>{description.length}/5000 Zeichen · Der Entwurf wird nur in diesem Browser gespeichert.</small>
        </label>
        <label className="store-feedback__technical">
          <input type="checkbox" checked={includeTechnicalDetails} onChange={(event) => { setIncludeTechnicalDetails(event.target.checked); clearStatus(); }} />
          <span><strong>Unpersönliche technische Angaben ergänzen</strong><small>Übernimmt nur Paketname, Plugin-Version, Bonni-Core-Version und Sprache – keine Benutzer-, Server- oder Zugangsdaten.</small></span>
        </label>
      </div>

      {error ? <div className="store-feedback__result is-error">{error}</div> : null}
      {message ? <div className="store-feedback__result is-success">{message}</div> : null}

      <div className="store-feedback__actions">
        <button type="button" onClick={handleClear}>Entwurf löschen</button>
        <button type="button" onClick={handleCopy}>Text kopieren</button>
        {support?.email ? <button type="button" onClick={handleEmail} disabled={!online}>E-Mail vorbereiten</button> : null}
        <button type="button" className="store-2fa-primary" onClick={handleGithub} disabled={!online || !githubUrl}>Auf GitHub öffnen</button>
      </div>
    </div>
  );
}

function moduleServicesOf(module) {
  return module?.metadata?.moduleServices ?? module?.manifest?.metadata?.moduleServices;
}

function getAppDependencies(module, compatibility) {
  const related = new Map();
  const selectedKey = keyOf(module);

  function add(key, required, state = {}) {
    if (typeof key !== "string" || !key.startsWith("app.") || key === selectedKey) return;
    const previous = related.get(key);
    if (previous && (!required || previous.satisfied === false)) return;
    related.set(key, { ...state, key, required });
  }

  for (const key of module.dependsOn ?? module.manifest?.dependsOn ?? []) add(key, true);
  for (const dependency of compatibility?.dependencies || []) {
    add(dependency.providerKey || dependency.key, true, dependency);
  }
  const services = moduleServicesOf(module);
  for (const key of services?.connections || []) add(key, false);
  for (const service of services?.consumes || []) add(service?.provider, false);
  return [...related.values()];
}

function hasCompatibleAppServices(module, app) {
  const offers = moduleServicesOf(app)?.provides ?? [];
  const uses = moduleServicesOf(module)?.consumes ?? [];
  return uses.filter(service => service?.provider === keyOf(app)).every(service =>
    offers.some(offer => offer.id === service.id && offer.version === service.version
      && (service.operations ?? []).every(operation => offer.operations?.includes(operation)))
  );
}

function StoreRecordLink({ name, version, status, ready, busy, onOpen }) {
  return (
    <button
      type="button"
      className={`store-record-link${ready ? " is-ready" : ""}`}
      title={status}
      aria-label={`${name} · ${version} · ${status}`}
      onClick={onOpen}
      disabled={busy}
    >
      <strong>{name}</strong>
      <small>{version}</small>
    </button>
  );
}

function StoreRecordLinks({ module, compatibility, packages, language, busy, onOpen }) {
  const coreVersion = compatibility?.coreVersion || BONNI_CORE_VERSION;
  const coreReady = compatibility?.coreVersionCompatible === true;
  const coreStatus = coreReady ? "Installiert und kompatibel"
    : compatibility?.coreVersionCompatible === false ? "Nicht kompatibel" : "Kompatibilität nicht bestätigt";
  const core = { key: CORE_RECORD_KEY, name: "Bonni Core", kind: "system", source: "bonni-core", version: coreVersion, recordType: "core" };
  return (
    <nav className="store-record-links" aria-label="App-Abhängigkeiten">
      <StoreRecordLink
        name="Bonni Core"
        version={versionOf(core)}
        status={coreStatus}
        ready={coreReady}
        busy={busy}
        onOpen={() => onOpen(core)}
      />
      {getAppDependencies(module, compatibility).map(dependency => {
        const app = packages.find(item => keyOf(item) === dependency.key);
        const name = app ? titleOf(app, language) : dependency.key;
        const installed = app ? isInstalled(app) : dependency.installed;
        const version = (installed && (app?.installation?.version || app?.installedVersion)) || versionOf(app);
        const ready = Boolean(app && installed && version !== "—" && dependency.satisfied !== false
          && isCompatible(app) && hasCompatibleAppServices(module, app));
        const state = ready ? "Installiert und kompatibel" : installed ? "Kompatibilität nicht bestätigt" : "Nicht installiert";
        const record = app ?? { key: dependency.key, name, kind: "app", recordType: "missing" };
        return (
          <StoreRecordLink
            key={dependency.key}
            name={name}
            version={version === "—" ? (installed ? "Version unbekannt" : "Nicht installiert") : version}
            status={`${dependency.required ? "Erforderlich" : "Schnittstelle"} · ${state}`}
            ready={ready}
            busy={busy}
            onOpen={() => onOpen(record)}
          />
        );
      })}
    </nav>
  );
}

function StoreAppUpdate({ module, busy, appOperation, onCheck, onInstall }) {
  const update = module.appUpdate;
  if (!update && (kindOf(module) !== "app" || !isInstalled(module))) return null;
  const blocked = Boolean(busy) || appOperation?.busy;
  const actionLabel = update ? "Installieren" : "Nach Updates suchen";
  return (
    <section className="store-detail-block store-app-update" aria-label="Update">
      <div className="store-detail-actions">
        <button
          type="button"
          className={update ? "is-primary" : undefined}
          disabled={blocked || Boolean(update?.error)}
          onClick={update ? () => onInstall(update) : onCheck}
        >
          {update && appOperation?.busy ? "Bitte warten …" : actionLabel}
        </button>
      </div>
      {update ? (
        <>
          <p className="store-app-version-change">
            <span>Installiert <strong>{update.installedVersion}</strong></span>
            <span aria-hidden="true">→</span>
            <span>Verfügbar <strong>{update.version}</strong></span>
          </p>
          {update.channel === "dev" ? <p>DEV – Entwicklungsversion, noch nicht abschließend geprüft.</p> : null}
          <h4>Das hat sich geändert</h4>
          <p className="store-app-release-notes">{update.releaseNotes?.trim() || "Für diese Version wurde keine Änderungsbeschreibung veröffentlicht."}</p>
          <small>{update.source === "offline" ? "Paket im UPDATE-Ordner" : "Veröffentlichung auf GitHub"}</small>
          {update.error === "APP_CORE_TOO_OLD" ? <p>Benötigt Bonni Core {update.minimumCoreVersion} oder neuer.</p> : null}
        </>
      ) : null}
    </section>
  );
}

function CaptureRecordTabs({ activeTab, onSelect, toolsAvailable }) {
  function moveFocus(event) {
    const buttons = [...event.currentTarget.querySelectorAll("button:not(:disabled)")];
    const index = buttons.indexOf(event.target);
    let next;
    switch (event.key) {
      case "ArrowLeft": next = buttons[(index + buttons.length - 1) % buttons.length]; break;
      case "ArrowRight": next = buttons[(index + 1) % buttons.length]; break;
      case "Home": next = buttons[0]; break;
      case "End": next = buttons.at(-1); break;
      default: return;
    }
    event.preventDefault();
    next?.focus();
    next?.click();
  }

  return (
    <nav className="store-capture-tabs" role="tablist" aria-label="Bonni Capture" onKeyDown={moveFocus}>
      {CAPTURE_RECORD_TABS.map(({ key, label }) => (
        <button
          key={key}
          id={`capture-record-tab-${key}`}
          type="button"
          role="tab"
          aria-selected={activeTab === key}
          aria-controls="capture-record-panel"
          tabIndex={activeTab === key ? 0 : -1}
          disabled={key !== "description" && key !== activeTab && !toolsAvailable}
          onClick={() => onSelect(key)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function StoreRecordDialog({ module, language, onClose, headerTabs, training, children }) {
  return (
    <div className={`store-settings-backdrop store-detail-backdrop${training ? " store-detail-backdrop--training" : ""}`}
      role="presentation" onMouseDown={onClose}>
      <section
        className={`store-settings-dialog store-package-dialog store-detail${headerTabs ? " store-package-dialog--capture" : ""}${training ? " store-package-dialog--training" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="store-package-detail-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={`store-settings-dialog__header store-detail__header${headerTabs ? " store-detail__header--capture" : ""}`}>
          <span className="store-detail__icon" aria-hidden="true">{packageIcon(module)}</span>
          <div>
            <p className="store-eyebrow">{kindLabel(kindOf(module))}</p>
            <h2 id="store-package-detail-title">{titleOf(module, language)}</h2>
            {!headerTabs && <small>{keyOf(module)}</small>}
          </div>
          {headerTabs}
          <button type="button" className="store-detail__close" onClick={onClose} aria-label="Details schließen">×</button>
        </header>
        {children}
      </section>
    </div>
  );
}

function StoreDetail({
  open, module, packages, language, details, result, busy, token, onClose, onOpenRecord,
  onOpenCoreUpdate, onInstall, onActivate, onDeactivate, onAppUpdate, onCheckUpdates, appOperation,
}) {
  const moduleKey = module ? keyOf(module) : "";
  const [activeTab, setActiveTab] = useState("description");
  const [guideLanguage, setGuideLanguage] = useState("auto");

  useEffect(() => {
    if (open) {
      setActiveTab("description");
      setGuideLanguage("auto");
    }
  }, [open, moduleKey]);

  if (!open || !module) return null;

  if (module.recordType) {
    const core = module.recordType === "core";
    return (
      <StoreRecordDialog module={module} language={language} onClose={onClose}>
        <dl className="store-detail-meta">
          <div><dt>Version</dt><dd>{versionOf(module)}</dd></div>
          <div><dt>Status</dt><dd>{core ? "Aktiv" : "Nicht im Store erfasst"}</dd></div>
        </dl>
        {core && onOpenCoreUpdate ? (
          <div className="store-detail-actions">
            <button type="button" onClick={onOpenCoreUpdate}>Systemupdate öffnen</button>
          </div>
        ) : null}
      </StoreRecordDialog>
    );
  }

  const installed = isInstalled(module);
  const active = isActive(module);
  const presentation = PACKAGE_PRESENTATIONS.get(moduleKey);
  const descriptionLanguage = presentation?.description && language !== "de" ? "en" : language;
  const support = storeSupportInfo(module);
  const compatibility = module?.compatibility || null;
  const compatible = compatibility?.ok !== false;
  const blocked = Boolean(busy) || appOperation?.busy;
  const isCapture = moduleKey === CAPTURE_KEY;
  const isTwoFactorPlugin = moduleKey === TWO_FACTOR_PLUGIN_KEY;
  const hasMaintenance = active && [
    details?.item?.manifest, details?.item, details?.manifest, details?.value?.manifest, module?.manifest, module,
  ].some(item => item?.metadata?.moduleServices?.provides?.some(offer => offer.control === true && offer.id === "maintenance"));
  const captureTab = hasMaintenance && (activeTab === "training" || activeTab === "learning")
    ? activeTab
    : "description";

  const generalDetails = (
    <>
      <div className="store-package-dialog__content">
        <div className="store-package-dialog__main">
          <dl className="store-detail-meta">
            <div><dt>Version</dt><dd>{versionOf(module)}</dd></div>
            <div><dt>Status</dt><dd>{statusText(module)}</dd></div>
            <div><dt>Owner</dt><dd>{module?.owner || "—"}</dd></div>
            <div><dt>Quelle</dt><dd>{module?.sourceRoot || module?.source || "Manifest"}</dd></div>
            <div><dt>Support</dt><dd>{support?.independentlySupported ? `Eigenständig · ${support.extensionKey || keyOf(module)}` : "—"}</dd></div>
          </dl>

          <p className="store-detail-description" lang={descriptionLanguage} dir={storeLanguageDirection(descriptionLanguage)}>
            {presentation?.description?.[descriptionLanguage] ?? descriptionOf(module, language)}
          </p>

        </div>

        <div className="store-package-dialog__side">
          <StoreRecordLinks
            module={module}
            compatibility={compatibility}
            packages={packages}
            language={language}
            busy={blocked}
            onOpen={onOpenRecord}
          />
          <div className="store-package-dialog__actions">
            <StoreAppUpdate
              module={module}
              busy={busy}
              appOperation={appOperation}
              onCheck={onCheckUpdates}
              onInstall={onAppUpdate}
            />
            <div className="store-detail-actions store-package-dialog__state-action">
              {!installed ? (
                <button type="button" className="is-primary" onClick={onInstall} disabled={blocked || !compatible}>{compatible ? "Installieren" : "Installation gesperrt"}</button>
              ) : active ? (
                <button type="button" onClick={onDeactivate} disabled={blocked}>Deaktivieren</button>
              ) : (
                <button type="button" className="is-primary" onClick={onActivate} disabled={blocked || !compatible}>{compatible ? "Aktivieren" : "Aktivierung gesperrt"}</button>
              )}
            </div>
          </div>
        </div>
      </div>

      {presentation?.screenshots?.length ? (
        <section className="store-detail-block" lang={descriptionLanguage} aria-labelledby="store-screenshots-heading">
          <h3 id="store-screenshots-heading">Screenshots</h3>
          <ul className="store-screenshot-list">
            {presentation.screenshots.map((screenshot) => (
              <li key={screenshot.src}>
                <a className="store-screenshot" href={screenshot.src} target="_blank" rel="noopener">
                  <img src={screenshot.src} alt="" width="1280" height="800" />
                  <span>{screenshot[descriptionLanguage]}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!isCapture && hasMaintenance ? <ModuleMaintenance key={moduleKey} moduleKey={moduleKey} token={token} /> : null}

      {result ? (
        <section className="store-detail-block">
          <h3>Letztes Ergebnis</h3>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </section>
      ) : null}
    </>
  );

  const operationFeedback = (
    <>
      {appOperation?.message ? <p role="status">{appOperation.message}</p> : null}
      {appOperation?.error ? <p role="alert">{appOperation.error}</p> : null}
    </>
  );

  return (
    <StoreRecordDialog
      module={module}
      language={language}
      onClose={onClose}
      training={isCapture && captureTab === "training"}
      headerTabs={isCapture ? (
        <CaptureRecordTabs activeTab={captureTab} onSelect={setActiveTab} toolsAvailable={hasMaintenance && !blocked} />
      ) : null}
    >
      {!isCapture && operationFeedback}
      {isTwoFactorPlugin ? (
        <nav className="store-detail-tabs" role="tablist" aria-label="2FA-Plugin">
          <button type="button" role="tab" aria-selected={activeTab === "description"} className={activeTab === "description" ? "is-active" : ""} onClick={() => setActiveTab("description")}>Beschreibung</button>
          <button type="button" role="tab" aria-selected={activeTab === "setup"} className={activeTab === "setup" ? "is-active" : ""} onClick={() => setActiveTab("setup")}>Einrichtung</button>
          <button type="button" role="tab" aria-selected={activeTab === "guide"} className={activeTab === "guide" ? "is-active" : ""} onClick={() => setActiveTab("guide")}>Installationshilfe</button>
          <button type="button" role="tab" aria-selected={activeTab === "feedback"} className={activeTab === "feedback" ? "is-active" : ""} onClick={() => setActiveTab("feedback")}>Feedback &amp; Vorschläge</button>
        </nav>
      ) : null}

      {activeTab === "setup" && isTwoFactorPlugin ? <StoreTwoFactorProviderSetup token={token} /> : null}
      {activeTab === "guide" && isTwoFactorPlugin ? <StoreTwoFactorGuide language={language} guideLanguage={guideLanguage} onGuideLanguageChange={setGuideLanguage} /> : null}
      {activeTab === "feedback" && isTwoFactorPlugin ? <StorePluginFeedback module={module} language={language} support={support} /> : null}

      {isCapture ? (
        <div className="store-capture-record-panel" id="capture-record-panel" role="tabpanel" aria-labelledby={`capture-record-tab-${captureTab}`}>
          {operationFeedback}
          {captureTab === "description" ? generalDetails : (
            <>
              <CaptureLearningModule key={captureTab} view={captureTab} token={token} />
              {captureTab === "learning" ? (
                <div className="store-detail-actions store-capture-learning__maintenance">
                  <ModuleMaintenance moduleKey={CAPTURE_KEY} token={token} />
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : activeTab === "description" ? generalDetails : null}
    </StoreRecordDialog>
  );
}

export default function StorePage({ token, onNavigate }) {
  const [payload, setPayload] = useState(null);
  const [packages, setPackages] = useState([]);
  const [appCheck,setAppCheck]=useState({availableUpdates:[]});
  const [appOperation,setAppOperation]=useState({busy:false,message:'',error:''});
  const appInstallerRef=useRef(null);
  const storePackages=useMemo(()=>packages.map(module=>{
    const appUpdate=(appCheck.availableUpdates||[]).find(item=>keyOf(module)==='app.'+item.appId.toLowerCase());
    return appUpdate?{...module,appUpdate,updateAvailable:true}:module;
  }),[packages,appCheck]);
  const [selection, setSelection] = useState(null);
  const currentSelection = useRef(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [details, setDetails] = useState(null);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sortMode, setSortMode] = useState("key");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [storeSettingsOpen, setStoreSettingsOpen] = useState(false);
  const [languageMode, setLanguageMode] = useState(readStoreLanguageMode);
  const storeLanguage = useMemo(
    () => resolveStoreLanguage({ mode: languageMode, controlCenterLanguage: labels.language }),
    [languageMode],
  );

  const counts = useMemo(() => buildCounts(storePackages), [storePackages]);
  const visiblePackages = useMemo(() => {
    const filtered = storePackages.filter((module) => matchesFilter(module, filter, storeLanguage) && matchesSearch(module, search, storeLanguage));
    return sortPackages(filtered, sortMode, storeLanguage);
  }, [storePackages, filter, search, sortMode, storeLanguage]);
  const selectedKey = selection?.key || "";
  const selectedPackage = selection?.record?.recordType === "core" ? selection.record
    : storePackages.find((module) => keyOf(module) === selectedKey) ?? selection?.record ?? null;
  const detailKey = selectedPackage && !selectedPackage.recordType ? selectedKey : "";

  async function loadPackages({ preserveSelection = true } = {}) {
    setLoading(true);
    setError("");
    try {
      const nextPayload = await fetchControlCenterRuntimeModules(token);
      const items = normalizePayload(nextPayload);
      setPayload(nextPayload);
      setPackages(items);
      const activeSelection = currentSelection.current;
      if (!preserveSelection || (activeSelection && !activeSelection.record
        && !items.some((item) => keyOf(item) === activeSelection.key))) {
        currentSelection.current = null;
        setSelection(null);
        setDetailOpen(false);
        setDetails(null);
      }
    } catch (loadError) {
      setError(loadError?.message || labels.store.loadError || "Store konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }

  async function loadDetails(key = selectedKey) {
    const requestSelection = currentSelection.current;
    if (!key || requestSelection?.key !== key) return null;
    setError("");
    try {
      const nextDetails = await fetchControlCenterRuntimeModuleDetails(token, key);
      if (currentSelection.current === requestSelection) setDetails(nextDetails);
      return nextDetails;
    } catch (detailsError) {
      if (currentSelection.current === requestSelection) {
        setDetails(null);
        setError(detailsError?.message || labels.store.detailsLoadError || "Details konnten nicht geladen werden.");
      }
      return null;
    }
  }

  async function runAction(module, action, runner) {
    if (!module) return;
    const key = keyOf(module);
    if (!key) return;
    setBusy(`${action}:${key}`);
    setError("");
    setMessage("");
    setResult(null);
    try {
      const actionResult = await runner(key);
      setResult(actionResult);
      setMessage(`${action} für ${key} abgeschlossen.`);
      await loadPackages({ preserveSelection: true });
      await loadDetails(key);
    } catch (actionError) {
      setError(actionError?.message || `${action} fehlgeschlagen.`);
    } finally {
      setBusy("");
    }
  }

  function selectPackage(module) {
    const nextSelection = { key: keyOf(module), record: module.recordType ? module : null };
    currentSelection.current = nextSelection;
    setSelection(nextSelection);
    setDetailOpen(true);
    setDetails(null);
    setResult(null);
  }

  function changeStoreLanguage(nextMode) {
    setLanguageMode(saveStoreLanguageMode(nextMode));
  }

  useEffect(() => {
    loadPackages({ preserveSelection: false });
  }, []);

  useEffect(() => {
    if (detailOpen && detailKey) loadDetails(detailKey);
  }, [detailOpen, detailKey, selection]);

  return (
    <section className="control-center-page store-page" aria-labelledby="store-page-title">
      <header className="store-hero">
        <div>
          <p className="store-eyebrow">Control Center</p>
          <h1 id="store-page-title">Store</h1>
          <p>Apps verwalten und verfügbare Aktualisierungen prüfen.</p>
        </div>

      </header>

      <SummaryBar counts={counts} />

      {error ? <div className="store-alert store-alert--error">{error}</div> : null}
      {message ? <div className="store-alert store-alert--success">{message}</div> : null}

      <div className="store-layout">
        <StoreSidebar
          activeFilter={filter}
          counts={counts}
          languageMode={languageMode}
          storeLanguage={storeLanguage}
          onFilterChange={setFilter}
          onLanguageChange={changeStoreLanguage}
          onOpenSettings={() => setStoreSettingsOpen(true)}
        />

        <main className="store-main">
          <div className="store-toolbar">
            <label>
              <span>Suche</span>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, Key, Capability, Pfad..." />
            </label>
            <label>
              <span>Sortierung</span>
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value)}>
                <option value="key">Key</option>
                <option value="name">Name</option>
                <option value="kind">Typ</option>
                <option value="installed">Installiert</option>
              </select>
            </label>
          </div>

          {visiblePackages.length ? (
            STORE_SECTIONS.map((section) => (
              <StoreSection
                key={section.key}
                section={section}
                modules={visiblePackages}
                language={storeLanguage}
                selectedKey={detailOpen ? keyOf(selectedPackage || {}) : ""}
                onSelect={selectPackage}
                onInstall={(module) => runAction(module, "Install", (key) => installControlCenterRuntimeModule(token, key))}
                onActivate={(module) => runAction(module, "Activate", (key) => activateControlCenterRuntimeModule(token, key))}
                onDeactivate={(module) => runAction(module, "Deactivate", (key) => deactivateControlCenterRuntimeModule(token, key))}
                busy={busy}
              />
            ))
          ) : (
            <section className="store-empty">
              <h2>Keine Pakete gefunden</h2>
              <p>Der Store konnte keine passenden Pakete aus Registry und Manifesten anzeigen.</p>
            </section>
          )}
          <StoreDetail
            key={detailOpen ? selectedKey : ""}
            appOperation={appOperation}
            onAppUpdate={item=>appInstallerRef.current?.install(item,item.source)}
            onCheckUpdates={() => appInstallerRef.current?.refresh()}
            open={detailOpen}
            module={selectedPackage}
            packages={storePackages}
            language={storeLanguage}
            details={details}
            result={result}
            busy={busy}
            token={token}
            onClose={() => setDetailOpen(false)}
            onOpenRecord={selectPackage}
            onOpenCoreUpdate={onNavigate ? () => onNavigate("update") : undefined}
            onInstall={() => runAction(selectedPackage, "Install", (key) => installControlCenterRuntimeModule(token, key))}
            onActivate={() => runAction(selectedPackage, "Activate", (key) => activateControlCenterRuntimeModule(token, key))}
            onDeactivate={() => runAction(selectedPackage, "Deactivate", (key) => deactivateControlCenterRuntimeModule(token, key))}
          />
          <AppInstallPanel
            ref={appInstallerRef}
            token={token}
            open={storeSettingsOpen}
            onClose={() => setStoreSettingsOpen(false)}
            onChecked={setAppCheck}
            onOperation={setAppOperation}
            onRefresh={() => loadPackages({ preserveSelection: true })}
            onInstalled={() => loadPackages({ preserveSelection: true })}
          />
        </main>
      </div>
    </section>
  );
}
