import {
  ADD_ON_SURFACE, APP_SURFACE, CONTROL_CENTER_SURFACE, LOCAL_USAGE,
  PLUG_IN_SURFACE, TECHNICAL_USAGE, getNewMemberModulePermissions,
} from "../new-member/newMemberWindowUtils.js";
import { getPrimaryAccount, getUsageLabels } from "./memberWindowUtils.js";

export function getFixedAccountUsage(member) {
  const type = String(getPrimaryAccount(member)?.type || member?.type || "").toUpperCase();
  if (["TERMINAL", "SERVICE"].includes(type)) return TECHNICAL_USAGE;
  if (["MEMBER", "ADMIN"].includes(type)) return LOCAL_USAGE;
  return getUsageLabels(member).includes(TECHNICAL_USAGE) ? TECHNICAL_USAGE : LOCAL_USAGE;
}

export function getAccountSurfaces(usage) {
  return usage === TECHNICAL_USAGE
    ? [APP_SURFACE, ADD_ON_SURFACE, PLUG_IN_SURFACE]
    : [CONTROL_CENTER_SURFACE, APP_SURFACE];
}

export function getAccountModuleCatalog(moduleCatalog, usage) {
  const surfaces = getAccountSurfaces(usage);
  return moduleCatalog.filter((module) => (
    surfaces.includes(module.surface) && getNewMemberModulePermissions(module, usage).length > 0
  ));
}

export function getAccountPermissions(module, usage, values) {
  const normalize = (value) => String(value || "").trim().toLocaleLowerCase("de");
  const selected = new Set(values.map(normalize));
  return getNewMemberModulePermissions(module, usage).filter((label) => {
    if (selected.has(normalize(label))) return true;
    return (module.accessProfiles || []).some((profile) => (
      profile.label === label && [profile.key, profile.permission].some((value) => selected.has(normalize(value)))
    ));
  });
}
