export type TaskStatus =
  | "OPEN"
  | "IN_PROGRESS"
  | "DONE"
  | "POSTPONED"
  | "CANCELLED"
  | "OVERDUE";

export type TaskTriggerType =
  | "TIME"
  | "STOCK_LEVEL"
  | "EVENT"
  | "MANUAL"
  | "SYSTEM";

export type TaskPriority =
  | "LOW"
  | "NORMAL"
  | "HIGH"
  | "URGENT";

export interface Task {
  id: string;

  title: string;
  description?: string;

  status: TaskStatus;
  priority: TaskPriority;

  triggerType: TaskTriggerType;

  assignedMemberId?: string;
  createdByMemberId: string;
  completedByMemberId?: string;

  dueAt?: Date;
  postponedUntil?: Date;

  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  deletedAt?: Date;
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  uploadedByMemberId: string;

  filename: string;
  mimeType: string;
  sizeInBytes: number;

  storageKey: string;
  url?: string;

  createdAt: Date;
}
