import { prisma } from "../../../../../core/core.js";

export async function listTasks() {
  return prisma.workflowTask.findMany({
    include: {
      comments: true,
      checklist: true
    },
    orderBy: [
      { priority: "desc" },
      { createdAt: "desc" }
    ]
  });
}

export async function getTask(id: string) {
  return prisma.workflowTask.findUnique({
    where: { id },
    include: {
      comments: {
        orderBy: {
          createdAt: "asc"
        }
      },
      checklist: {
        orderBy: {
          createdAt: "asc"
        }
      }
    }
  });
}

export async function createTask(data: {
  key?: string;
  title: string;
  description?: string;
  type:
    | "KITCHEN"
    | "SHOPPING"
    | "EVENT"
    | "TECH"
    | "CLEANING"
    | "MAINTENANCE"
    | "GENERAL";
  priority:
    | "LOW"
    | "NORMAL"
    | "HIGH"
    | "CRITICAL";
  assignedToAccountId?: string;
  assignedToRoleId?: string;
  dueAt?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  createdByAccountId?: string;
}) {
  return prisma.workflowTask.create({
    data: {
      key: data.key,
      title: data.title,
      description: data.description,
      type: data.type,
      priority: data.priority,
      assignedToAccountId: data.assignedToAccountId,
      assignedToRoleId: data.assignedToRoleId,
      dueAt: data.dueAt
        ? new Date(data.dueAt)
        : undefined,
      relatedEntityType: data.relatedEntityType,
      relatedEntityId: data.relatedEntityId,
      createdByAccountId: data.createdByAccountId,
      status: "OPEN"
    }
  });
}

export async function updateTask(id: string, data: {
  title?: string;
  description?: string | null;
  priority?:
    | "LOW"
    | "NORMAL"
    | "HIGH"
    | "CRITICAL";
  dueAt?: string | null;
}) {
  return prisma.workflowTask.update({
    where: { id },
    data: {
      title: data.title,
      description: data.description,
      priority: data.priority,
      dueAt: data.dueAt
        ? new Date(data.dueAt)
        : data.dueAt === null
          ? null
          : undefined
    }
  });
}

export async function claimTask(id: string, data: {
  accountId?: string;
  note?: string;
}) {
  return prisma.workflowTask.update({
    where: { id },
    data: {
      assignedToAccountId: data.accountId,
      status: "CLAIMED",
      claimNote: data.note
    }
  });
}

export async function startTask(id: string, data: {
  accountId?: string;
  note?: string;
}) {
  return prisma.workflowTask.update({
    where: { id },
    data: {
      status: "IN_PROGRESS",
      startedAt: new Date(),
      startedByAccountId: data.accountId,
      startNote: data.note
    }
  });
}

export async function completeTask(id: string, data: {
  accountId?: string;
  note?: string;
}) {
  return prisma.workflowTask.update({
    where: { id },
    data: {
      status: "DONE",
      completedAt: new Date(),
      completedByAccountId: data.accountId,
      completionNote: data.note
    }
  });
}

export async function cancelTask(id: string, data: {
  accountId?: string;
  note?: string;
}) {
  return prisma.workflowTask.update({
    where: { id },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelledByAccountId: data.accountId,
      cancellationNote: data.note
    }
  });
}

export async function addComment(id: string, data: {
  message: string;
  accountId?: string;
}) {
  return prisma.workflowTaskComment.create({
    data: {
      taskId: id,
      message: data.message,
      createdByAccountId: data.accountId
    }
  });
}

export async function addChecklistItem(id: string, data: {
  label: string;
  checked: boolean;
}) {
  return prisma.workflowTaskChecklist.create({
    data: {
      taskId: id,
      label: data.label,
      checked: data.checked
    }
  });
}

export async function getTaskBoard() {
  const tasks = await prisma.workflowTask.findMany({
    orderBy: {
      createdAt: "desc"
    }
  });

  return {
    open: tasks.filter((task) => task.status === "OPEN"),
    claimed: tasks.filter((task) => task.status === "CLAIMED"),
    inProgress: tasks.filter((task) => task.status === "IN_PROGRESS"),
    done: tasks.filter((task) => task.status === "DONE"),
    cancelled: tasks.filter((task) => task.status === "CANCELLED")
  };
}

export async function getTaskCalendar() {
  return prisma.workflowTask.findMany({
    where: {
      dueAt: {
        not: null
      }
    },
    orderBy: {
      dueAt: "asc"
    }
  });
}

export async function createAutomaticTask(data: {
  title: string;
  description?: string;
  type:
    | "KITCHEN"
    | "SHOPPING"
    | "EVENT"
    | "TECH"
    | "CLEANING"
    | "MAINTENANCE"
    | "GENERAL";
  relatedEntityType?: string;
  relatedEntityId?: string;
}) {
  return prisma.workflowTask.create({
    data: {
      title: data.title,
      description: data.description,
      type: data.type,
      priority: "HIGH",
      relatedEntityType: data.relatedEntityType,
      relatedEntityId: data.relatedEntityId,
      status: "OPEN",
      automatic: true
    }
  });
}
