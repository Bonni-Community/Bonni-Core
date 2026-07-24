export const modulePermissions = {
  user: [
    "control-center.user.read",
    "control-center.user.create",
    "control-center.user.update",
    "control-center.user.delete",
  ],
  system: [
    "control-center.system.read",
    "control-center.system.registry.sync",
  ],
  diagnostics: [
    "control-center.diagnostics.read",
  ],
  backup: [
    "control-center.backup.read",
    "control-center.backup.create",
    "control-center.backup.restore",
  ],
};

export function getModulePermissions(moduleKey) {
  return modulePermissions[moduleKey] || [];
}

export default modulePermissions;
