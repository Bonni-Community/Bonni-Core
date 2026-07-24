const allowedMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];

export function validateTaskAttachment(file: any): void {
  if (!file) {
    throw new Error("TASK_ATTACHMENT_REQUIRED");
  }

  if (!allowedMimeTypes.includes(file.mimetype)) {
    throw new Error("TASK_ATTACHMENT_TYPE_NOT_ALLOWED");
  }

  if (file.size > 10 * 1024 * 1024) {
    throw new Error("TASK_ATTACHMENT_TOO_LARGE");
  }
}
