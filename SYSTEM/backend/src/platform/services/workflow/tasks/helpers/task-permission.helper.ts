export function hasRole(user: any, role: string): boolean {
  return Array.isArray(user?.roles) && user.roles.includes(role);
}

export function canCreateTask(user: any): boolean {
  return hasRole(user, "MANAGER") || hasRole(user, "ADMIN");
}

export function canEditTaskDeadline(user: any): boolean {
  return hasRole(user, "MANAGER") || hasRole(user, "ADMIN");
}

export function canDeleteTask(user: any): boolean {
  return hasRole(user, "MANAGER") || hasRole(user, "ADMIN");
}

export function canCompleteTask(user: any): boolean {
  return Boolean(user?.memberId);
}

export function canPostponeTask(user: any): boolean {
  return Boolean(user?.memberId);
}

export function canUploadTaskAttachment(user: any): boolean {
  return Boolean(user?.memberId);
}
