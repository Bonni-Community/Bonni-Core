export function hasPermission(accountPermissions: string[], permission: string): boolean {
  return accountPermissions.includes(permission);
}
