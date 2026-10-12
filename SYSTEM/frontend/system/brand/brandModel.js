export const BRANDING_SCHEMA_VERSION = "bonni.branding/v1";
export const DEFAULT_BRAND_LOGO_URL = "/system/brand/bonni-logo-original.png";

export const DEFAULT_BRANDING = Object.freeze({
  schemaVersion: BRANDING_SCHEMA_VERSION,
  revision: "default",
  displayName: "Bonni Core",
  logoAltText: "Bonni Logo",
  logo: Object.freeze({
    url: DEFAULT_BRAND_LOGO_URL,
    width: 600,
    height: 600,
    mimeType: "image/png",
  }),
  updatedAt: null,
  fallback: true,
});

function boundedText(value, fallback, maxLength) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength || /[\r\n\0]/u.test(normalized)) return fallback;
  return normalized;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2048 ? parsed : fallback;
}

export function safeBrandLogoUrl(value, browserOrigin = globalThis.location?.origin || "") {
  if (typeof value !== "string" || !value.trim()) return "";
  const candidate = value.trim();
  // URL normalisiert Backslashes je nach Kontext zu Pfad- oder Hosttrennern.
  // Vor dem Parsen bleiben deshalb nur unverwechselbare, nicht kodierte
  // Same-Origin-Kandidaten erlaubt. Die Core-API liefert ausschließlich
  // root-relative, bereits URL-sichere Media-IDs.
  if (
    /[\\\u0000-\u0020\u007f]/u.test(candidate)
    || candidate.includes("%")
    || candidate.startsWith("//")
  ) return "";
  const rootRelative = candidate.startsWith("/");
  const absoluteHttp = /^https?:\/\//iu.test(candidate);
  if (!rootRelative && (!absoluteHttp || !browserOrigin)) return "";
  try {
    const base = new URL(browserOrigin || "https://bonni.invalid");
    const url = new URL(candidate, base);
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.origin !== base.origin
      || url.username
      || url.password
    ) return "";
    return rootRelative ? `${url.pathname}${url.search}${url.hash}` : url.href;
  } catch {
    return "";
  }
}

export function normalizeBranding(value, { browserOrigin } = {}) {
  if (!value || typeof value !== "object") return DEFAULT_BRANDING;
  const displayName = boundedText(value.displayName, DEFAULT_BRANDING.displayName, 120);
  const logoAltText = boundedText(value.logoAltText, displayName, 180);
  const logoUrl = safeBrandLogoUrl(value.logo?.url, browserOrigin);
  const logo = logoUrl ? Object.freeze({
    url: logoUrl,
    width: positiveInteger(value.logo?.width, DEFAULT_BRANDING.logo.width),
    height: positiveInteger(value.logo?.height, DEFAULT_BRANDING.logo.height),
    mimeType: value.logo?.mimeType === "image/png" ? "image/png" : DEFAULT_BRANDING.logo.mimeType,
  }) : DEFAULT_BRANDING.logo;
  const revision = ["string", "number"].includes(typeof value.revision)
    ? String(value.revision).slice(0, 160)
    : DEFAULT_BRANDING.revision;
  const updatedAt = typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
    ? value.updatedAt
    : null;

  return Object.freeze({
    schemaVersion: boundedText(value.schemaVersion, BRANDING_SCHEMA_VERSION, 80),
    revision: revision || DEFAULT_BRANDING.revision,
    displayName,
    logoAltText,
    logo,
    updatedAt,
    fallback: Boolean(value.fallback || !logoUrl),
  });
}
