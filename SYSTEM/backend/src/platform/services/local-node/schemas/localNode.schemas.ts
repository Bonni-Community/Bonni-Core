import { z } from "zod";

export const createLocalNodeSchema = z.object({
  body: z.object({
    key: z.string().min(1),
    name: z.string().min(1),
    location: z.string().optional()
  })
});

export const updateLocalNodeSchema = z.object({
  body: z.object({
    name: z.string().optional(),
    location: z.string().optional(),
    warningMessage: z.string().nullable().optional()
  })
});

export const heartbeatSchema = z.object({
  body: z.object({
    hasInternet: z.boolean(),
    canReachMainDb: z.boolean(),
    status: z.enum([
      "ONLINE",
      "DEGRADED",
      "EMERGENCY_LOCAL",
      "SYNCING",
      "READ_ONLY",
      "ERROR"
    ]).optional(),
    warningMessage: z.string().optional()
  })
});

export const emergencyModeSchema = z.object({
  body: z.object({
    enabled: z.boolean(),
    reason: z.string().optional()
  })
});

export const offlineQueueItemSchema = z.object({
  body: z.object({
    terminalId: z.string().optional(),
    localSequence: z.number().int(),
    operationType: z.string().min(1),
    entityType: z.string().optional(),
    entityId: z.string().optional(),
    payloadJson: z.unknown(),
    payloadHash: z.string().min(1),
    createdAtLocal: z.string().datetime()
  })
});

export const markQueueItemSchema = z.object({
  body: z.object({
    status: z.enum(["PENDING", "SYNCED", "FAILED", "CONFLICT"]),
    errorMessage: z.string().optional()
  })
});
