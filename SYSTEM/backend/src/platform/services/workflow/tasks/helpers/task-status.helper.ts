import { TaskStatus } from "../types/tasks.types.js";

export function isTaskOpen(status: TaskStatus): boolean {
  return ["OPEN", "IN_PROGRESS", "POSTPONED", "OVERDUE"].includes(status);
}

export function isTaskClosed(status: TaskStatus): boolean {
  return ["DONE", "CANCELLED"].includes(status);
}
