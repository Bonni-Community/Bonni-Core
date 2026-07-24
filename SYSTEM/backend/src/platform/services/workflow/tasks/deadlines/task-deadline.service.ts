import { canEditTaskDeadline } from "../helpers/task-permission.helper.js";

export class TaskDeadlineService {
  async updateDeadline(taskId: string, dueAt: Date, user: any) {
    if (!canEditTaskDeadline(user)) {
      throw new Error("TASK_DEADLINE_EDIT_FORBIDDEN");
    }

    return {
      taskId,
      dueAt,
      updatedAt: new Date(),
    };
  }

  async markOverdue(taskId: string) {
    return {
      taskId,
      status: "OVERDUE",
      updatedAt: new Date(),
    };
  }
}

export const taskDeadlineService = new TaskDeadlineService();
