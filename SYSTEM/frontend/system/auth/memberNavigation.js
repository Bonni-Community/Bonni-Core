import { canOpenLaunchTarget } from "./accessPolicy.js";

export function canOpenMembers(user, shell) {
  const identity = shell?.identity?.type ? shell.identity : user;
  const type = String(identity?.type || "").toUpperCase();
  return type === "MEMBER" || (type === "ADMIN" && Boolean(identity?.memberId));
}

export function getMemberNavigation(user, shell) {
  const entries = shell?.permissions?.memberNavigation;
  if (!canOpenMembers(user, shell) || !Array.isArray(entries)) return [];
  return entries.filter((item) => typeof item?.app === "string"
    && item.app.startsWith("app.") && item.section && item.label && canOpenLaunchTarget(item.app, user, shell));
}
