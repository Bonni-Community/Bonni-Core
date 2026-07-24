export function shouldRemindTask(dueAt?: Date): boolean {
  if (!dueAt) return false;

  const now = Date.now();
  const due = dueAt.getTime();

  return due > now && due - now <= 24 * 60 * 60 * 1000;
}
