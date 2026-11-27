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
  "hub",
  "gourmet",
  "capture",
  "paypal",
  "works",
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
  hub: "hub",
  gourmet: "gourmet",
  capture: "capture",
  paypal: "paypal",
  works: "works",
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
  hub: "hub_user",
  gourmet: "gourmet_user",
  capture: "capture_user",
  paypal: "paypal_user",
  works: "works_user",
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
  hub: "hub_owner",
  gourmet: "gourmet_owner",
  capture: "capture_owner",
  paypal: "paypal_owner",
  works: "works_owner",
});

const moduleDomains: Readonly<Record<string, DataDomain>> = Object.freeze({
  "addon.hub": "hub",
  "app.worksapp": "works",
  "addon.gourmet": "gourmet",
  "addon.capture": "capture",
  "addon.paypal": "paypal",
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
  if (declaredDomain === "works" && moduleKey !== "app.worksapp" || moduleKey === "app.worksapp" && declaredDomain !== undefined && declaredDomain !== "works") throw new Error("WORKS_DATA_DOMAIN_DENIED");
  if(declaredDomain==='paypal'&&moduleKey!=='addon.paypal'||moduleKey==='addon.paypal'&&declaredDomain!==undefined&&declaredDomain!=='paypal')throw new Error('PAYPAL_DATA_DOMAIN_DENIED');
  if (declaredDomain === "capture" && moduleKey !== "addon.capture") throw new Error("CAPTURE_DATA_DOMAIN_DENIED");
  if (moduleKey === "addon.capture" && declaredDomain !== undefined && declaredDomain !== "capture") throw new Error("CAPTURE_DATA_DOMAIN_DENIED");
  if (declaredDomain === "gourmet" && moduleKey !== "addon.gourmet") throw new Error("GOURMET_DATA_DOMAIN_DENIED");
  if (moduleKey === "addon.gourmet" && declaredDomain !== undefined && declaredDomain !== "gourmet") throw new Error("GOURMET_DATA_DOMAIN_DENIED");
  if (declaredDomain === "hub" && moduleKey !== "addon.hub") throw new Error("HUB_DATA_DOMAIN_DENIED");
  if (moduleKey === "addon.hub" && declaredDomain !== undefined && declaredDomain !== "hub") throw new Error("HUB_DATA_DOMAIN_DENIED");
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
  return !["people", "organization", "privacy", "pos", "hub", "gourmet", "capture", "paypal", "works"].includes(domain);
}
