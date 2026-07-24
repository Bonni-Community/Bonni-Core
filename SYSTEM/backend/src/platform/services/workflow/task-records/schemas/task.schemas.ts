import { z } from "zod";

export const createTaskSchema = z.object({
  body: z.object({
    key: z.string().optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    type: z.enum([
      "KITCHEN",
      "SHOPPING",
      "EVENT",
      "TECH",
      "CLEANING",
      "MAINTENANCE",
      "GENERAL"
    ]).default("GENERAL"),
    priority: z.enum([
      "LOW",
      "NORMAL",
      "HIGH",
      "CRITICAL"
    ]).default("NORMAL"),
    assignedToAccountId: z.string().optional(),
    assignedToRoleId: z.string().optional(),
    dueAt: z.string().datetime().optional(),
    relatedEntityType: z.string().optional(),
    relatedEntityId: z.string().optional()
  })
});

export const updateTaskSchema = z.object({
  body: z.object({
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    priority: z.enum([
      "LOW",
      "NORMAL",
      "HIGH",
      "CRITICAL"
    ]).optional(),
    dueAt: z.string().datetime().nullable().optional()
  })
});

export const taskActionSchema = z.object({
  body: z.object({
    accountId: z.string().optional(),
    note: z.string().optional()
  })
});

export const taskCommentSchema = z.object({
  body: z.object({
    message: z.string().min(1)
  })
});

export const taskChecklistSchema = z.object({
  body: z.object({
    label: z.string().min(1),
    checked: z.boolean().default(false)
  })
});
