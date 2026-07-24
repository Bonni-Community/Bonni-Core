import { canUploadTaskAttachment } from "../helpers/task-permission.helper.js";

export class TaskAttachmentService {
  async uploadAttachment(taskId: string, file: any, user: any) {
    if (!canUploadTaskAttachment(user)) {
      throw new Error("TASK_ATTACHMENT_UPLOAD_FORBIDDEN");
    }

    return {
      id: "hex-id-placeholder",
      taskId,
      uploadedByMemberId: user?.memberId,
      filename: file?.originalname ?? "upload",
      mimeType: file?.mimetype ?? "application/octet-stream",
      sizeInBytes: file?.size ?? 0,
      storageKey: `tasks/${taskId}/${Date.now()}-${file?.originalname ?? "upload"}`,
      createdAt: new Date(),
    };
  }
}

export const taskAttachmentService = new TaskAttachmentService();
