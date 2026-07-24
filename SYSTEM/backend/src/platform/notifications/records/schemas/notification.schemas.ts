import { z } from "zod";

export const createNotificationSchema = z.object({
  body: z.object({
    type: z.string().min(1),
    severity: z.enum(["DEBUG", "INFO", "WARN", "ERROR", "FATAL"]).default("INFO"),
    message: z.string().min(1),
    targetRole: z.string().optional(),
    accountId: z.string().optional(),
    relatedEntityType: z.string().optional(),
    relatedEntityId: z.string().optional(),
    metadataJson: z.unknown().optional()
  })
});
