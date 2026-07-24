import { canCreateTask, canDeleteTask, canCompleteTask, canPostponeTask } from "./helpers/task-permission.helper.js";

export class TasksService {
  async listTasks(query: unknown) {
    return {
      items: [],
      query,
    };
  }

  async createTask(data: unknown, user: any) {
    if (!canCreateTask(user)) {
      throw new Error("TASK_CREATE_FORBIDDEN");
    }

    return {
      id: "hex-id-placeholder",
      ...data as object,
      status: "OPEN",
      createdAt: new Date(),
    };
  }

  async completeTask(taskId: string, data: unknown, user: any) {
    if (!canCompleteTask(user)) {
      throw new Error("TASK_COMPLETE_FORBIDDEN");
    }

    return {
      id: taskId,
      status: "DONE",
      completedByMemberId: user?.memberId,
      completedAt: new Date(),
      data,
    };
  }

  async postponeTask(taskId: string, data: unknown, user: any) {
    if (!canPostponeTask(user)) {
      throw new Error("TASK_POSTPONE_FORBIDDEN");
    }

    return {
      id: taskId,
      status: "POSTPONED",
      postponedByMemberId: user?.memberId,
      postponedAt: new Date(),
      data,
    };
  }

  async deleteTask(taskId: string, user: any) {
    if (!canDeleteTask(user)) {
      throw new Error("TASK_DELETE_FORBIDDEN");
    }

    return {
      id: taskId,
      deletedAt: new Date(),
    };
  }
}

export const tasksService = new TasksService();
