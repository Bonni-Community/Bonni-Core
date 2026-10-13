export const dataDomains = [
  "core",
  "people",
  "organization",
  "privacy",
  "hocket",
  "kontor",
  "meet",
  "stueberl",
  "pos",
] as const;

export type DataDomain = (typeof dataDomains)[number];

export const dataDomainSchemas: Readonly<Record<DataDomain, string>> = Object.freeze({
  core: "core",
  people: "people",
  organization: "organization",
  privacy: "privacy",
  hocket: "hocket",
  kontor: "kontor",
  meet: "meet",
  stueberl: "stueberl",
  pos: "pos",
});

export const dataDomainRuntimeRoles: Readonly<Record<DataDomain, string>> = Object.freeze({
  core: "core_user",
  people: "people_user",
  organization: "organization_user",
  privacy: "privacy_user",
  hocket: "hocket_user",
  kontor: "kontor_user",
  meet: "meet_user",
  stueberl: "stueberl_user",
  pos: "pos_user",
});

export const dataDomainOwnerRoles: Readonly<Record<DataDomain, string>> = Object.freeze({
  core: "core_owner",
  people: "people_owner",
  organization: "organization_owner",
  privacy: "privacy_owner",
  hocket: "hocket_owner",
  kontor: "kontor_owner",
  meet: "meet_owner",
  stueberl: "stueberl_owner",
  pos: "pos_owner",
});

const moduleDomains: Readonly<Record<string, DataDomain>> = Object.freeze({
  "app.hocketapp": "hocket",
  "app.kontorapp": "kontor",
  "app.meetapp": "meet",
  "app.stueberlapp": "stueberl",
  "app.jeldapp": "pos",
  "app.pos": "pos",
  "app.posapp": "pos",
});

export function isDataDomain(value: unknown): value is DataDomain {
  return typeof value === "string" && (dataDomains as readonly string[]).includes(value);
}

export function dataDomainForModule(
  moduleKey: string,
  declaredDomain?: unknown,
): DataDomain {
  if (isDataDomain(declaredDomain)) return declaredDomain;
  const normalized = String(moduleKey || "").trim().toLowerCase();
  const mapped = moduleDomains[normalized];
  if (mapped) return mapped;
  throw Object.assign(new Error(`MODULE_DATA_DOMAIN_REQUIRED:${normalized || "unknown"}`), {
    statusCode: 500,
  });
}

export function dataDomainDatabase(domain: DataDomain): "main" | "pos" {
  return domain === "pos" ? "pos" : "main";
}

/**
 * Financially binding POS writes and protected personal data must never be
 * acknowledged from the generic JSON emergency queue. Their callers receive
 * a hard failure and can retry after the owning database is healthy again.
 */
export function dataDomainAllowsJsonEmergency(domain: DataDomain): boolean {
  return !["people", "organization", "privacy", "pos"].includes(domain);
}
