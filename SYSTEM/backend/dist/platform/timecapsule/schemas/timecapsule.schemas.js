import { z } from "zod";
export const auditQuerySchema = z.object({
    query: z.object({
        module: z.string().optional(),
        level: z.string().optional(),
        entityType: z.string().optional(),
        entityId: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional()
    })
});
export const exportAuditSchema = z.object({
    body: z.object({
        entityType: z.string().optional(),
        entityId: z.string().optional(),
        module: z.string().optional(),
        format: z.enum(["JSON", "CSV"]).default("JSON")
    })
});
export const snapshotSchema = z.object({
    body: z.object({
        module: z.string().min(1),
        entityType: z.string().min(1),
        entityId: z.string().min(1),
        action: z.string().min(1),
        beforeJson: z.unknown().optional(),
        afterJson: z.unknown().optional(),
        metadataJson: z.unknown().optional()
    })
});
