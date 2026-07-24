// Verantwortlichkeiten für Aufgaben
export class TaskResponsibilityService {
  async assign(taskId: string, memberId: string) {
    return {
      taskId,
      assignedMemberId: memberId,
      assignedAt: new Date(),
    };
  }
}

export const taskResponsibilityService = new TaskResponsibilityService();
