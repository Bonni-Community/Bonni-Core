import { z } from "zod";

export const createTerminalSchema = z.object({
  body: z.object({
    key: z.string().min(1),
    name: z.string().min(1),
    type: z.string().min(1),
    layoutPreset: z.string().default("DEFAULT"),
    roomId: z.string().optional(),
    localNodeId: z.string().optional()
  })
});

export const updateTerminalSchema = z.object({
  body: z.object({
    name: z.string().optional(),
    layoutPreset: z.string().optional(),
    active: z.boolean().optional()
  })
});

export const capabilitySchema = z.object({
  body: z.object({
    capability: z.string().min(1),
    enabled: z.boolean()
  })
});

export const startSessionSchema = z.object({
  // Die Identität kommt ausschließlich aus dem verifizierten Bearer-Token.
  // Vom Client gelieferte accountId/personId-Werte werden nicht akzeptiert.
  body: z.object({}).default({})
});


export const executeShellCommandSchema = z.object({
  body: z.object({
    command: z.string().min(1).max(4000),
    cwd: z.string().min(1).max(1000).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional()
  })
});
