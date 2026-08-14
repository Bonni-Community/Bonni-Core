import { useEffect, useMemo, useState } from "react";

import {
  activateControlCenterRuntimeModule,
  deactivateControlCenterRuntimeModule,
  fetchControlCenterRuntimeModuleDetails,
  fetchControlCenterRuntimeModuleInstallPlan,
  fetchControlCenterRuntimeModules,
  installControlCenterRuntimeModule,
  runControlCenterRuntimeModuleLifecycle,
} from "../../../system/api/controlCenterRuntimeApi.js";
import {
  confirmCurrentUserTotpSetup,
  getControlCenterSystemSettings,
  getCurrentTwoFactorStatus,
  saveControlCenterSystemSettings,
  startCurrentUserTotpSetup,
} from "../../../system/api/systemSettingsApi.js";
import { BONNI_CORE_VERSION } from "../../../system/version.js";

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

const TWO_FACTOR_PLUGIN_KEY = "plugin.privacyidea";
const STORE_FEEDBACK_DRAFT_PREFIX = "bonni.store.feedback.";

const STORE_FEEDBACK_CATEGORIES = Object.freeze([
  "Verbesserungsvorschlag",
  "Fehler melden",
  "Bedienung und Darstellung",
  "Installationshilfe und Dokumentation",
]);

const TWO_FACTOR_INSTALLATION_GUIDE = Object.freeze({
  de: {
    title: "Zwei-Faktor-Authentifizierung einrichten",
    intro: "Diese Installationshilfe führt dich Schritt für Schritt durch die Einrichtung. Token und Passwörter werden von Bonni nicht gespeichert.",
    steps: [
      ["Anbieter auswählen", "Wähle unter „Einrichtung“ eine gewöhnliche Authenticator-App oder privacyIDEA als externen Anbieter."],
      ["Verbindung eintragen", "Bei privacyIDEA trägst du die HTTPS-Adresse deines Servers und – falls verwendet – den Realm ein."],
      ["Sicherheitsregeln festlegen", "Lege Gültigkeit, erlaubte Versuche sowie die Reihenfolge von Token und Passwort fest. Empfohlen sind 60 Sekunden und 8 Versuche."],
      ["QR-Code scannen", "Bei einer normalen Authenticator-App erzeugt Bonni den QR-Code für deinen Zugang. Bei privacyIDEA wird der Token zuerst im privacyIDEA-System zugeordnet; der dort angezeigte QR-Code wird anschließend mit der App gescannt."],
      ["Prüfen und speichern", "Bestätige den ersten Einmalcode und bewahre ausgegebene Wiederherstellungscodes sicher und getrennt vom Gerät auf."],
    ],
    privacyIdeaNote: "Wichtig: Bonni darf keinen Ersatz-QR-Code für einen privacyIDEA-Token erfinden. Der geheime Schlüssel und der zugehörige QR-Code werden ausschließlich bei der Tokenausgabe durch privacyIDEA erzeugt.",
  },
  en: {
    title: "Set up two-factor authentication",
    intro: "This installation guide walks you through the setup step by step. Bonni does not store tokens or passwords.",
    steps: [
      ["Choose a provider", "Under “Setup”, select a regular authenticator app or privacyIDEA as an external provider."],
      ["Enter the connection", "For privacyIDEA, enter the HTTPS address of your server and the realm if one is used."],
      ["Set the security policy", "Choose the validity period, allowed attempts and the token/password order. The recommended defaults are 60 seconds and 8 attempts."],
      ["Scan the QR code", "For a regular authenticator app, Bonni creates the QR code for your account. With privacyIDEA, assign the token in privacyIDEA first and scan the QR code shown there."],
      ["Verify and save", "Confirm the first one-time code and keep the recovery codes in a safe place separate from the device."],
    ],
    privacyIdeaNote: "Important: Bonni must not invent a replacement QR code for a privacyIDEA token. The secret and its QR code are created only when privacyIDEA issues the token.",
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
  return module?.version || module?.manifest?.version || module?.installation?.version || module?.installedVersion || "—";
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
      `- Bonni-Core-Version: ${BONNI_CORE_VERSION}`,
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
    apps: modules.filter((module) => kindOf(module) === "app").length,
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
        <span className="store-package-card__icon" aria-hidden="true">{packageIcon(module)}</span>
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

function StoreSettingsModal({ open, sourceUrl, localUpdatePath, onSourceUrlChange, onLocalUpdatePathChange, onClose, onSaveDraft }) {
  if (!open) return null;

  return (
    <div className="store-settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="store-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="store-settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="store-settings-dialog__header">
          <div>
            <p className="store-eyebrow">Store</p>
            <h2 id="store-settings-title">Einstellungen</h2>
            <p>Vorbereitung für externe Store-Quellen. Hier kann später eine Webseite oder Repository-Adresse hinterlegt werden.</p>
          </div>
          <button type="button" className="store-detail__close" onClick={onClose} aria-label="Einstellungen schließen">×</button>
        </header>

        <div className="store-settings-grid">
          <label className="store-settings-field">
            <span>Externe Store-Quelle / Webseite</span>
            <input
              value={sourceUrl}
              onChange={(event) => onSourceUrlChange(event.target.value)}
              placeholder="https://example.com/store/index.json"
            />
            <small>Nur Vorbereitung: Die Adresse wird aktuell nur in der Oberfläche vorgemerkt.</small>
          </label>

          <label className="store-settings-field">
            <span>Lokale Aktualisierung / UPDATE</span>
            <input
              value={localUpdatePath}
              onChange={(event) => onLocalUpdatePathChange(event.target.value)}
              placeholder="UPDATE/"
            />
            <small>Alles, was später im UPDATE-Ordner liegt, kann als lokale Store-Quelle angezeigt und zur Installation vorbereitet werden.</small>
          </label>
        </div>

        <div className="store-settings-note">
          <strong>Späterer Ablauf</strong>
          <p>Der Package Manager liest externe Katalogdaten und den lokalen UPDATE-Ordner, prüft Manifest, Versionen und Abhängigkeiten und zeigt installierbare Pakete im Store an.</p>
        </div>

        <footer className="store-settings-dialog__footer">
          <button type="button" onClick={onClose}>Abbrechen</button>
          <button type="button" className="is-primary" onClick={onSaveDraft}>Vorbereiten</button>
        </footer>
      </section>
    </div>
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

function StoreTwoFactorSetup({ token }) {
  const [systemSettings, setSystemSettings] = useState(null);
  const [draft, setDraft] = useState(() => normalizeTwoFactorSettings(null));
  const [status, setStatus] = useState(null);
  const [totpSetup, setTotpSetup] = useState(null);
  const [confirmationCode, setConfirmationCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [nextSettings, nextStatus] = await Promise.all([
        getControlCenterSystemSettings(token),
        getCurrentTwoFactorStatus(token),
      ]);
      setSystemSettings(nextSettings);
      setDraft(normalizeTwoFactorSettings(nextSettings));
      setStatus(nextStatus);
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
  const selectedExternal = externalProviders.find((provider) => provider.id === draft.provider) || null;
  const values = selectedExternal?.configuration?.values || {};
  const savedProvider = systemSettings?.twoFactor?.provider || "local";

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
      setStatus(await getCurrentTwoFactorStatus(token));
      setMessage("Die 2FA-Konfiguration wurde gespeichert.");
    } catch (saveError) {
      setError(saveError?.message || "Die 2FA-Konfiguration konnte nicht gespeichert werden.");
    } finally {
      setSaving(false);
    }
  }

  async function createQrCode() {
    setMessage("");
    setError("");
    setRecoveryCodes([]);
    try {
      const result = await startCurrentUserTotpSetup(token, {
        issuer: "Bonni Core",
        includeManualSecret: true,
      });
      setTotpSetup(result);
    } catch (setupError) {
      setError(setupError?.message || "Der QR-Code konnte nicht erzeugt werden.");
    }
  }

  async function confirmQrCode() {
    if (!totpSetup?.credentialId || !confirmationCode.trim()) return;
    setMessage("");
    setError("");
    try {
      const result = await confirmCurrentUserTotpSetup(token, {
        credentialId: totpSetup.credentialId,
        code: confirmationCode.trim(),
      });
      setRecoveryCodes(result?.recoveryCodes || []);
      setTotpSetup(null);
      setConfirmationCode("");
      setStatus(await getCurrentTwoFactorStatus(token));
      setMessage("Die Authenticator-App wurde erfolgreich bestätigt.");
    } catch (confirmError) {
      setError(confirmError?.message || "Der Einmalcode konnte nicht bestätigt werden.");
    }
  }

  if (loading) return <div className="store-detail-block"><p>2FA-Einstellungen werden geladen …</p></div>;

  return (
    <div className="store-2fa-setup">
      {message ? <div className="store-alert store-alert--success">{message}</div> : null}
      {error ? <div className="store-alert store-alert--error">{error}</div> : null}

      <section className="store-detail-block">
        <div className="store-2fa-section-head">
          <div>
            <h3>2FA-Anbieter auswählen</h3>
            <p>Die Auswahl gilt für die Anmeldung an Bonni Core.</p>
          </div>
          <span className={draft.configured ? "store-2fa-ready is-ready" : "store-2fa-ready"}>{draft.configured ? "Bereit" : "Unvollständig"}</span>
        </div>
        <div className="store-2fa-provider-grid">
          <button type="button" className={draft.provider === "local" ? "is-selected" : ""} onClick={() => setDraft((current) => ({ ...current, provider: "local" }))}>
            <strong>Authenticator-App (TOTP)</strong>
            <span>Für 2FAS, Aegis, FreeOTP, Google Authenticator, Microsoft Authenticator und andere TOTP-Apps.</span>
          </button>
          {externalProviders.map((provider) => (
            <button key={provider.id} type="button" className={draft.provider === provider.id ? "is-selected" : ""} onClick={() => setDraft((current) => ({ ...current, provider: provider.id }))}>
              <strong>{provider.label}</strong>
              <span>Externer 2FA-Anbieter über das installierte Plugin.</span>
            </button>
          ))}
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
      )) : null}

      <section className="store-detail-block store-2fa-qr-card">
        <h3>Authenticator-App und QR-Code</h3>
        {selectedExternal ? (
          <div className="store-2fa-provider-note">
            <strong>Der Token wird durch {selectedExternal.label} ausgegeben.</strong>
            <p>Ordne den Benutzer dort einem Token zu und scanne anschließend den von {selectedExternal.label} angezeigten QR-Code. Bonni erzeugt keinen Ersatzschlüssel und speichert weder Token noch Passwort.</p>
          </div>
        ) : savedProvider !== "local" ? (
          <p>Speichere zuerst „Authenticator-App (TOTP)“ als Anbieter. Danach kann Bonni den persönlichen QR-Code sicher erzeugen.</p>
        ) : status?.enabled ? (
          <div className="store-2fa-provider-note is-success"><strong>Für deinen Zugang ist bereits eine Authenticator-App eingerichtet.</strong></div>
        ) : totpSetup ? (
          <div className="store-2fa-enrollment">
            <img src={totpSetup.qrCodeDataUrl} alt="Persönlicher QR-Code für die 2FA-Einrichtung" />
            <div>
              <h4>1. QR-Code mit der Authenticator-App scannen</h4>
              <p>Der QR-Code gehört nur zu deinem Benutzerkonto. Zeige ihn niemandem und speichere ihn nicht als Screenshot.</p>
              {totpSetup.manualEntrySecret ? <details><summary>Schlüssel manuell eingeben</summary><code>{totpSetup.manualEntrySecret}</code></details> : null}
              <label className="store-2fa-field">
                <span>2. Angezeigten Einmalcode bestätigen</span>
                <input value={confirmationCode} inputMode="numeric" autoComplete="one-time-code" maxLength={8} onChange={(event) => setConfirmationCode(event.target.value.replace(/\D/g, ""))} placeholder="123456" />
              </label>
              <button type="button" className="store-2fa-primary" onClick={confirmQrCode} disabled={!confirmationCode.trim()}>Einmalcode bestätigen</button>
            </div>
          </div>
        ) : (
          <button type="button" className="store-2fa-primary" onClick={createQrCode}>Persönlichen QR-Code erzeugen</button>
        )}
        {recoveryCodes.length ? (
          <div className="store-2fa-recovery">
            <strong>Wiederherstellungscodes – nur jetzt sichtbar</strong>
            <p>Bewahre diese Codes sicher und getrennt vom Gerät auf.</p>
            <pre>{recoveryCodes.join("\n")}</pre>
          </div>
        ) : null}
      </section>

      <div className="store-2fa-footer">
        <button type="button" onClick={load} disabled={saving}>Neu laden</button>
        <button type="button" className="store-2fa-primary" onClick={save} disabled={saving}>{saving ? "Speichert …" : "Konfiguration speichern"}</button>
      </div>
    </div>
  );
}

function StoreTwoFactorGuide({ language, guideLanguage, onGuideLanguageChange }) {
  const resolvedLanguage = guideLanguage === "auto" ? (language === "de" ? "de" : "en") : guideLanguage;
  const guide = TWO_FACTOR_INSTALLATION_GUIDE[resolvedLanguage] || TWO_FACTOR_INSTALLATION_GUIDE.en;
  const illustrations = [
    "/system/guides/2fa/01-provider.svg",
    "/system/guides/2fa/02-connection.svg",
    "/system/guides/2fa/03-policy.svg",
    "/system/guides/2fa/04-qr-code.svg",
    "/system/guides/2fa/05-finish.svg",
  ];
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
            <img src={illustrations[index]} alt="" aria-hidden="true" />
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

function StoreDetail({ open, module, language, details, plan, result, busy, token, onClose, onLoadPlan, onInstall, onActivate, onDeactivate, onHealthcheck, onRollback }) {
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

  const installed = isInstalled(module);
  const active = isActive(module);
  const lifecycleHooks = details?.lifecycle?.value?.hooks || details?.lifecycle?.hooks || [];
  const support = storeSupportInfo(module);
  const compatibility = plan?.compatibility || module?.compatibility || null;
  const compatible = compatibility?.ok !== false;
  const isTwoFactorPlugin = moduleKey === TWO_FACTOR_PLUGIN_KEY;

  return (
    <div className="store-settings-backdrop store-detail-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="store-settings-dialog store-package-dialog store-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="store-package-detail-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="store-settings-dialog__header store-detail__header">
          <span className="store-detail__icon" aria-hidden="true">{packageIcon(module)}</span>
          <div>
            <p className="store-eyebrow">{kindLabel(kindOf(module))}</p>
            <h2 id="store-package-detail-title">{titleOf(module, language)}</h2>
            <small>{keyOf(module)}</small>
          </div>
          <button type="button" className="store-detail__close" onClick={onClose} aria-label="Details schließen">×</button>
        </header>

        {isTwoFactorPlugin ? (
          <nav className="store-detail-tabs" role="tablist" aria-label="2FA-Plugin">
            <button type="button" role="tab" aria-selected={activeTab === "description"} className={activeTab === "description" ? "is-active" : ""} onClick={() => setActiveTab("description")}>Beschreibung</button>
            <button type="button" role="tab" aria-selected={activeTab === "setup"} className={activeTab === "setup" ? "is-active" : ""} onClick={() => setActiveTab("setup")}>Einrichtung</button>
            <button type="button" role="tab" aria-selected={activeTab === "guide"} className={activeTab === "guide" ? "is-active" : ""} onClick={() => setActiveTab("guide")}>Installationshilfe</button>
            <button type="button" role="tab" aria-selected={activeTab === "feedback"} className={activeTab === "feedback" ? "is-active" : ""} onClick={() => setActiveTab("feedback")}>Feedback &amp; Vorschläge</button>
          </nav>
        ) : null}

        {activeTab === "setup" && isTwoFactorPlugin ? <StoreTwoFactorSetup token={token} /> : null}
        {activeTab === "guide" && isTwoFactorPlugin ? <StoreTwoFactorGuide language={language} guideLanguage={guideLanguage} onGuideLanguageChange={setGuideLanguage} /> : null}
        {activeTab === "feedback" && isTwoFactorPlugin ? <StorePluginFeedback module={module} language={language} support={support} /> : null}

        {activeTab === "description" ? <>

        <div className="store-package-dialog__content">
          <div className="store-package-dialog__main">
            <dl className="store-detail-meta">
              <div><dt>Version</dt><dd>{versionOf(module)}</dd></div>
              <div><dt>Status</dt><dd>{statusText(module)}</dd></div>
              <div><dt>Owner</dt><dd>{module?.owner || "—"}</dd></div>
              <div><dt>Quelle</dt><dd>{module?.sourceRoot || module?.source || "Manifest"}</dd></div>
              <div><dt>Support</dt><dd>{support?.independentlySupported ? `Eigenständig · ${support.extensionKey || keyOf(module)}` : "—"}</dd></div>
            </dl>

            <p className="store-detail-description" lang={language} dir={storeLanguageDirection(language)}>
              {descriptionOf(module, language)}
            </p>

            <div className="store-detail-actions">
              <button type="button" onClick={onLoadPlan} disabled={Boolean(busy)}>Plan laden</button>
              {!installed ? (
                <button type="button" className="is-primary" onClick={onInstall} disabled={Boolean(busy) || !compatible}>{compatible ? "Installieren" : "Installation gesperrt"}</button>
              ) : active ? (
                <button type="button" onClick={onDeactivate} disabled={Boolean(busy)}>Deaktivieren</button>
              ) : (
                <button type="button" className="is-primary" onClick={onActivate} disabled={Boolean(busy) || !compatible}>{compatible ? "Aktivieren" : "Aktivierung gesperrt"}</button>
              )}
              <button type="button" onClick={onHealthcheck} disabled={Boolean(busy)}>Healthcheck</button>
              <button type="button" className="is-danger" onClick={onRollback} disabled={Boolean(busy)}>Rollback</button>
            </div>
          </div>

          <div className="store-package-dialog__side">
            <section className={`store-detail-block store-compatibility${compatible ? " is-compatible" : " is-incompatible"}`}>
              <h3>Kompatibilität</h3>
              {compatibility ? (
                <>
                  <p><strong>{compatible ? "Freigegeben" : "Gesperrt"}</strong> für Bonni Core {compatibility.coreVersion || "—"}</p>
                  {compatibility.minimumCoreVersion ? <small>Mindestens Bonni Core {compatibility.minimumCoreVersion}</small> : null}
                  {compatibility.maximumCoreVersion ? <small>Höchstens Bonni Core {compatibility.maximumCoreVersion}</small> : null}
                  {compatibility.reasons?.length ? <ul>{compatibility.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
                </>
              ) : <p>Wird aus dem Manifest geladen.</p>}
            </section>
            <section className="store-detail-block">
              <h3>Provides</h3>
              {module?.provides?.length ? (
                <ul className="store-chip-list">{module.provides.map((item) => <li key={item}>{item}</li>)}</ul>
              ) : <p>Keine Provides geladen.</p>}
            </section>

            <section className="store-detail-block">
              <h3>Depends On</h3>
              {compatibility?.dependencies?.length ? (
                <ul className="store-dependency-list">{compatibility.dependencies.map((item) => <li key={item.key} className={item.satisfied ? "is-ready" : "is-missing"}><span>{item.satisfied ? "✓" : "×"}</span><b>{item.key}</b></li>)}</ul>
              ) : module?.dependsOn?.length ? (
                <ul className="store-chip-list">{module.dependsOn.map((item) => <li key={item}>{item}</li>)}</ul>
              ) : <p>Keine Abhängigkeiten geladen.</p>}
            </section>
          </div>
        </div>

        <section className="store-detail-block">
          <h3>Installationsplan</h3>
          {plan?.value || plan ? (
            <pre>{JSON.stringify(plan?.value || plan, null, 2)}</pre>
          ) : <p>Noch nicht geladen.</p>}
        </section>

        <section className="store-detail-block">
          <h3>Lifecycle</h3>
          {lifecycleHooks.length ? (
            <ul className="store-hook-list">
              {lifecycleHooks.map((hook) => (
                <li key={hook.hook}><span>{hook.hook}</span><b>{hook.available ? "vorhanden" : "fehlt"}</b></li>
              ))}
            </ul>
          ) : <p>Keine Lifecycle-Information geladen.</p>}
        </section>

        {result ? (
          <section className="store-detail-block">
            <h3>Letztes Ergebnis</h3>
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </section>
        ) : null}
        </> : null}
      </section>
    </div>
  );
}

export default function StorePage({ token }) {
  const [payload, setPayload] = useState(null);
  const [packages, setPackages] = useState([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [details, setDetails] = useState(null);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sortMode, setSortMode] = useState("key");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [storeSettingsOpen, setStoreSettingsOpen] = useState(false);
  const [storeSourceUrl, setStoreSourceUrl] = useState("");
  const [localUpdatePath, setLocalUpdatePath] = useState("UPDATE/");
  const [languageMode, setLanguageMode] = useState(readStoreLanguageMode);
  const storeLanguage = useMemo(
    () => resolveStoreLanguage({ mode: languageMode, controlCenterLanguage: labels.language }),
    [languageMode],
  );

  const counts = useMemo(() => buildCounts(packages), [packages]);
  const visiblePackages = useMemo(() => {
    const filtered = packages.filter((module) => matchesFilter(module, filter, storeLanguage) && matchesSearch(module, search, storeLanguage));
    return sortPackages(filtered, sortMode, storeLanguage);
  }, [packages, filter, search, sortMode, storeLanguage]);
  const selectedPackage = packages.find((module) => keyOf(module) === selectedKey) || null;

  async function loadPackages({ preserveSelection = true } = {}) {
    setLoading(true);
    setError("");
    try {
      const nextPayload = await fetchControlCenterRuntimeModules(token);
      const items = normalizePayload(nextPayload);
      setPayload(nextPayload);
      setPackages(items);
      if (!preserveSelection || (selectedKey && !items.some((item) => keyOf(item) === selectedKey))) {
        setSelectedKey("");
        setDetailOpen(false);
        setDetails(null);
        setPlan(null);
      }
    } catch (loadError) {
      setError(loadError?.message || labels.store.loadError || "Store konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }

  async function loadDetails(key = selectedKey) {
    if (!key) return null;
    setError("");
    try {
      const nextDetails = await fetchControlCenterRuntimeModuleDetails(token, key);
      setDetails(nextDetails);
      return nextDetails;
    } catch (detailsError) {
      setDetails(null);
      setError(detailsError?.message || labels.store.detailsLoadError || "Details konnten nicht geladen werden.");
      return null;
    }
  }

  async function loadPlan(key = selectedKey) {
    if (!key) return null;
    setBusy(`plan:${key}`);
    setError("");
    try {
      const nextPlan = await fetchControlCenterRuntimeModuleInstallPlan(token, key);
      setPlan(nextPlan);
      setResult(nextPlan);
      return nextPlan;
    } catch (planError) {
      setError(planError?.message || labels.store.planLoadError || "Installationsplan konnte nicht geladen werden.");
      return null;
    } finally {
      setBusy("");
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
    const key = keyOf(module);
    setSelectedKey(key);
    setDetailOpen(true);
    setDetails(null);
    setPlan(null);
    setResult(null);
  }

  function changeStoreLanguage(nextMode) {
    setLanguageMode(saveStoreLanguageMode(nextMode));
  }

  useEffect(() => {
    loadPackages({ preserveSelection: false });
  }, []);

  useEffect(() => {
    if (selectedKey) loadDetails(selectedKey);
  }, [selectedKey]);

  return (
    <section className="control-center-page store-page">
      <header className="store-hero">
        <div>
          <p className="store-eyebrow">Control Center</p>
          <h1>Store</h1>
          <p>Pakete aus Manifest, Registry und Package Manager. Die UI bereitet nur auf, was das Manifest liefert.</p>
        </div>
        <button type="button" onClick={() => loadPackages({ preserveSelection: true })} disabled={loading || Boolean(busy)}>
          {loading ? "Lade..." : "Store aktualisieren"}
        </button>
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
            open={detailOpen}
            module={selectedPackage}
            language={storeLanguage}
            details={details}
            plan={plan}
            result={result}
            busy={busy}
            token={token}
            onClose={() => setDetailOpen(false)}
            onLoadPlan={() => loadPlan(keyOf(selectedPackage || {}))}
            onInstall={() => runAction(selectedPackage, "Install", (key) => installControlCenterRuntimeModule(token, key))}
            onActivate={() => runAction(selectedPackage, "Activate", (key) => activateControlCenterRuntimeModule(token, key))}
            onDeactivate={() => runAction(selectedPackage, "Deactivate", (key) => deactivateControlCenterRuntimeModule(token, key))}
            onHealthcheck={() => runAction(selectedPackage, "Healthcheck", (key) => runControlCenterRuntimeModuleLifecycle(token, key, "healthcheck", { source: "store" }))}
            onRollback={() => runAction(selectedPackage, "Rollback", (key) => runControlCenterRuntimeModuleLifecycle(token, key, "rollback", { source: "store" }))}
          />
          <StoreSettingsModal
            open={storeSettingsOpen}
            sourceUrl={storeSourceUrl}
            localUpdatePath={localUpdatePath}
            onSourceUrlChange={setStoreSourceUrl}
            onLocalUpdatePathChange={setLocalUpdatePath}
            onClose={() => setStoreSettingsOpen(false)}
            onSaveDraft={() => {
              setStoreSettingsOpen(false);
              const externalPart = storeSourceUrl ? `Externe Quelle: ${storeSourceUrl}` : "Externe Quelle: nicht gesetzt";
              const localPart = localUpdatePath ? `Lokale Quelle: ${localUpdatePath}` : "Lokale Quelle: nicht gesetzt";
              setMessage(`Store-Einstellungen vorbereitet. ${externalPart}. ${localPart}.`);
            }}
          />
        </main>
      </div>
    </section>
  );
}
