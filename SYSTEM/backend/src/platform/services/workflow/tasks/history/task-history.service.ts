export class TaskHistoryService {
  async record(taskId: string, action: string, userId?: string, data?: unknown) {
    return {
      taskId,
      action,
      userId,
      data,
      createdAt: new Date(),
    };
  }
}

export const taskHistoryService = new TaskHistoryService();
