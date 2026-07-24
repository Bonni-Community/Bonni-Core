export const STORE_LANGUAGE_MODE_AUTO = "auto";
export const STORE_LANGUAGE_STORAGE_KEY = "bonni.control-center.store.language";
export const STORE_DESCRIPTION_FALLBACK_LANGUAGE = "en";

const ENGLISH_DESCRIPTION_MISSING = "This package has not supplied an English description yet.";

export const STORE_LANGUAGES = Object.freeze([
  { code: "de", label: "Deutsch" },
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "it", label: "Italiano" },
  { code: "nl", label: "Nederlands" },
  { code: "pl", label: "Polski" },
  { code: "pt", label: "Português" },
  { code: "cs", label: "Čeština" },
  { code: "da", label: "Dansk" },
  { code: "sv", label: "Svenska" },
  { code: "no", label: "Norsk" },
  { code: "fi", label: "Suomi" },
  { code: "et", label: "Eesti" },
  { code: "lv", label: "Latviešu" },
  { code: "lt", label: "Lietuvių" },
  { code: "el", label: "Ελληνικά" },
  { code: "ro", label: "Română" },
  { code: "bg", label: "Български" },
  { code: "hr", label: "Hrvatski" },
  { code: "sl", label: "Slovenščina" },
  { code: "sk", label: "Slovenčina" },
  { code: "hu", label: "Magyar" },
  { code: "tr", label: "Türkçe" },
  { code: "uk", label: "Українська" },
  { code: "ru", label: "Русский" },
  { code: "ar", label: "العربية" },
  { code: "he", label: "עברית" },
  { code: "fa", label: "فارسی" },
  { code: "hi", label: "हिन्दी" },
  { code: "bn", label: "বাংলা" },
  { code: "ur", label: "اردو" },
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "th", label: "ไทย" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "ms", label: "Bahasa Melayu" },
  { code: "fil", label: "Filipino" },
  { code: "sw", label: "Kiswahili" },
  { code: "af", label: "Afrikaans" },
  { code: "is", label: "Íslenska" },
  { code: "ga", label: "Gaeilge" },
  { code: "mt", label: "Malti" },
  { code: "sq", label: "Shqip" },
  { code: "sr", label: "Српски" },
  { code: "mk", label: "Македонски" },
]);

const LANGUAGE_CODES = new Map(STORE_LANGUAGES.map((language) => [language.code.toLowerCase(), language.code]));
const CONTROL_CENTER_LANGUAGE_KEYS = [
  "bonni.control-center.language",
  "bonni.control-center.locale",
  "bonni.language",
  "bonni.locale",
];
const CONTROL_CENTER_COUNTRY_KEYS = [
  "bonni.control-center.country",
  "bonni.control-center.region",
  "bonni.country",
  "bonni.region",
];

const COUNTRY_LANGUAGE = {
  AT: "de",
  AU: "en",
  BE: "nl",
  BR: "pt",
  CA: "en",
  CH: "de",
  CN: "zh-CN",
  CZ: "cs",
  DE: "de",
  DK: "da",
  ES: "es",
  FI: "fi",
  FR: "fr",
  GB: "en",
  GR: "el",
  IE: "en",
  IN: "hi",
  IT: "it",
  JP: "ja",
  KR: "ko",
  NL: "nl",
  NO: "no",
  PL: "pl",
  PT: "pt",
  SE: "sv",
  TW: "zh-TW",
  UA: "uk",
  US: "en",
};

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function browserStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function storageValue(storage, key) {
  try {
    return storage?.getItem?.(key) || "";
  } catch {
    return "";
  }
}

export function normalizeStoreLanguage(value) {
  const raw = String(value || "").trim().replaceAll("_", "-");
  if (!raw) return "";

  const aliases = {
    deutsch: "de",
    deutschland: "de",
    germany: "de",
    german: "de",
    english: "en",
  };
  const aliased = aliases[raw.toLowerCase()] || raw;
  const exact = LANGUAGE_CODES.get(aliased.toLowerCase());
  if (exact) return exact;

  const base = aliased.split("-")[0].toLowerCase();
  if (base === "zh") {
    const normalized = aliased.toLowerCase();
    return normalized.includes("tw") || normalized.includes("hant") || normalized.includes("hk") ? "zh-TW" : "zh-CN";
  }
  return LANGUAGE_CODES.get(base) || "";
}

export function languageForCountry(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (["deutschland", "germany", "deutsch"].includes(raw.toLowerCase())) return "de";
  return COUNTRY_LANGUAGE[raw.toUpperCase()] || "";
}

export function readStoreLanguageMode(storage = browserStorage()) {
  const stored = storageValue(storage, STORE_LANGUAGE_STORAGE_KEY);
  if (!stored || stored === STORE_LANGUAGE_MODE_AUTO) return STORE_LANGUAGE_MODE_AUTO;
  return normalizeStoreLanguage(stored) || STORE_LANGUAGE_MODE_AUTO;
}

export function saveStoreLanguageMode(mode, storage = browserStorage()) {
  const normalized = mode === STORE_LANGUAGE_MODE_AUTO
    ? STORE_LANGUAGE_MODE_AUTO
    : normalizeStoreLanguage(mode) || STORE_LANGUAGE_MODE_AUTO;
  try {
    storage?.setItem?.(STORE_LANGUAGE_STORAGE_KEY, normalized);
  } catch {
    // Der Store bleibt auch ohne verfügbaren Browser-Speicher bedienbar.
  }
  return normalized;
}

export function detectControlCenterLanguage({
  storage = browserStorage(),
  controlCenterLanguage = "",
  controlCenterCountry = "",
  documentLanguage = typeof document !== "undefined" ? document.documentElement?.lang : "",
  navigatorLanguages = typeof navigator !== "undefined" ? navigator.languages : [],
} = {}) {
  for (const key of CONTROL_CENTER_LANGUAGE_KEYS) {
    const detected = normalizeStoreLanguage(storageValue(storage, key));
    if (detected) return detected;
  }

  for (const key of CONTROL_CENTER_COUNTRY_KEYS) {
    const detected = languageForCountry(storageValue(storage, key));
    if (detected) return detected;
  }

  const explicitLanguage = normalizeStoreLanguage(controlCenterLanguage);
  if (explicitLanguage) return explicitLanguage;

  const countryLanguage = languageForCountry(controlCenterCountry);
  if (countryLanguage) return countryLanguage;

  const htmlLanguage = normalizeStoreLanguage(documentLanguage);
  if (htmlLanguage) return htmlLanguage;

  for (const value of Array.isArray(navigatorLanguages) ? navigatorLanguages : [navigatorLanguages]) {
    const detected = normalizeStoreLanguage(value);
    if (detected) return detected;
  }

  return "en";
}

export function resolveStoreLanguage({ mode = STORE_LANGUAGE_MODE_AUTO, ...preferences } = {}) {
  if (mode !== STORE_LANGUAGE_MODE_AUTO) {
    const selected = normalizeStoreLanguage(mode);
    if (selected) return selected;
  }
  return detectControlCenterLanguage(preferences);
}

export function storeLanguageLabel(code) {
  return STORE_LANGUAGES.find((language) => language.code === normalizeStoreLanguage(code))?.label || "English";
}

export function storeLanguageDirection(code) {
  return ["ar", "he", "fa", "ur"].includes(normalizeStoreLanguage(code)) ? "rtl" : "ltr";
}

export function storeSupportInfo(module) {
  for (const store of storeMetadataCandidates(module)) {
    if (!isRecord(store.support)) continue;
    return {
      scope: firstText(store.support.scope) || "extension",
      extensionKey: firstText(store.support.extensionKey, module?.key, manifestOf(module)?.key),
      independentlySupported: store.support.independentlySupported === true,
      url: firstText(store.support.url),
      email: firstText(store.support.email),
    };
  }
  return null;
}

function manifestOf(module) {
  if (isRecord(module?.manifest)) return module.manifest;
  if (isRecord(module?.manifestJson)) return module.manifestJson;
  return {};
}

function storeMetadataCandidates(module) {
  const manifest = manifestOf(module);
  return [
    module?.metadata?.store,
    manifest?.metadata?.store,
    module?.store,
    manifest?.store,
  ].filter(isRecord);
}

function translationMaps(module) {
  const manifest = manifestOf(module);
  return [
    ...storeMetadataCandidates(module).flatMap((store) => [store.translations, store.i18n, store.descriptionTranslations]),
    module?.translations,
    module?.i18n,
    manifest?.translations,
    manifest?.i18n,
  ].filter(isRecord);
}

function translationAt(map, code) {
  if (!code) return null;
  if (map[code] != null) return map[code];
  const wanted = code.toLowerCase();
  const key = Object.keys(map).find((candidate) => candidate.toLowerCase() === wanted);
  return key ? map[key] : null;
}

function localizedEntry(module, language) {
  const normalized = normalizeStoreLanguage(language) || STORE_DESCRIPTION_FALLBACK_LANGUAGE;
  const fallbackCodes = [normalized, normalized.split("-")[0], STORE_DESCRIPTION_FALLBACK_LANGUAGE];

  for (const map of translationMaps(module)) {
    for (const code of [...new Set(fallbackCodes)]) {
      const entry = translationAt(map, code);
      if (typeof entry === "string" && entry.trim()) return { shortDescription: entry.trim(), description: entry.trim() };
      if (isRecord(entry)) return entry;
    }
  }

  return {};
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function declaredDescriptionLanguage(module) {
  const manifest = manifestOf(module);
  const stores = storeMetadataCandidates(module);
  return normalizeStoreLanguage(firstText(
    ...stores.map((store) => store.defaultLanguage),
    module?.defaultLanguage,
    manifest?.defaultLanguage,
  )) || "de";
}

function mayUseLegacyDescription(module, requestedLanguage) {
  const declared = declaredDescriptionLanguage(module);
  const requested = normalizeStoreLanguage(requestedLanguage) || STORE_DESCRIPTION_FALLBACK_LANGUAGE;
  return declared === STORE_DESCRIPTION_FALLBACK_LANGUAGE || requested === declared;
}

export function localizedStoreTitle(module, language = "en") {
  const manifest = manifestOf(module);
  const localized = localizedEntry(module, language);
  return firstText(localized.name, localized.title, module?.name, module?.label, module?.displayName, manifest?.name, manifest?.label, module?.key, manifest?.key, "Paket");
}

export function localizedStoreShortDescription(module, language = "en") {
  const manifest = manifestOf(module);
  const localized = localizedEntry(module, language);
  const stores = storeMetadataCandidates(module);
  const legacy = mayUseLegacyDescription(module, language) ? [
    ...stores.map((store) => store.shortDescription),
    module?.description,
    module?.summary,
    manifest?.description,
    module?.metadata?.description,
  ] : [];
  return firstText(
    localized.shortDescription,
    localized.description,
    ...legacy,
    ENGLISH_DESCRIPTION_MISSING,
  );
}

export function localizedStoreDescription(module, language = "en") {
  const manifest = manifestOf(module);
  const localized = localizedEntry(module, language);
  const stores = storeMetadataCandidates(module);
  const legacy = mayUseLegacyDescription(module, language) ? [
    module?.description,
    manifest?.description,
    ...stores.map((store) => store.shortDescription),
    module?.summary,
    module?.metadata?.description,
  ] : [];
  return firstText(
    localized.description,
    localized.shortDescription,
    ...legacy,
    ENGLISH_DESCRIPTION_MISSING,
  );
}
