import {
  getDatabaseRoutingStatus,
  getDatabaseTargetPrismaClient,
} from "../database/prisma.js";

type CommittedSettingRow = {
  id?: string;
  key: string;
  value: unknown;
  createdAt?: Date;
  updatedAt: Date;
};

function revision(value: unknown) {
  const candidate = value as { revision?: unknown } | null;
  const result = Number(candidate?.revision);
  return Number.isSafeInteger(result) && result >= 0 ? result : -1;
}

/**
 * A routed Prisma `$transaction` is pinned to one physical client. In `both`
 * mode, replicate the already committed value/revision to the other target;
 * never execute the CAS mutation independently on both databases.
 */
export async function replicateCommittedBrandingRow(row: CommittedSettingRow) {
  const routing = getDatabaseRoutingStatus();
  if (routing.mode !== "both") return;
  const target = routing.primary === "normal" ? "redundant" : "normal";
  const client = getDatabaseTargetPrismaClient(target);
  try {
    await client.$transaction(async (transaction) => {
      const existing = await transaction.systemSetting.findUnique({ where: { key: row.key } });
      const existingRevision = revision(existing?.value);
      const committedRevision = revision(row.value);
      if (committedRevision < 0 || existingRevision > committedRevision) {
        throw new Error("BRANDING_REPLICA_REVISION_DIVERGED");
      }
      await transaction.systemSetting.upsert({
        where: { key: row.key },
        update: { value: row.value as any, updatedAt: row.updatedAt },
        create: {
          ...(row.id ? { id: row.id } : {}),
          key: row.key,
          value: row.value as any,
          ...(row.createdAt ? { createdAt: row.createdAt } : {}),
          updatedAt: row.updatedAt,
        },
      });
      const verified = await transaction.systemSetting.findUnique({ where: { key: row.key } });
      if (
        revision(verified?.value) !== committedRevision
        || JSON.stringify(verified?.value) !== JSON.stringify(row.value)
      ) throw new Error("BRANDING_REPLICA_VERIFICATION_FAILED");
      await transaction.auditLog.create({
        data: {
          category: "SYSTEM",
          event: "SYSTEM_BRANDING_REPLICATED",
          result: "SUCCESS",
          targetType: "SystemSetting",
          targetId: row.key,
          severity: "INFO",
          metadataJson: { revision: committedRevision, target },
        },
      });
    });
  } catch (error) {
    throw Object.assign(new Error("BRANDING_REPLICATION_FAILED"), {
      code: "BRANDING_REPLICATION_FAILED",
      statusCode: 503,
      cause: error,
    });
  }
}

/** Fail closed: every configured database must prove it no longer references the asset. */
export async function mayDeleteSupersededBrandingMedia(mediaId: string) {
  const routing = getDatabaseRoutingStatus();
  const targets = (["normal", "redundant"] as const).filter((target) => routing.configured[target]);
  try {
    for (const target of targets) {
      const row = await getDatabaseTargetPrismaClient(target).systemSetting.findUnique({
        where: { key: "system.branding" },
      });
      const value = row?.value as { logo?: { mediaId?: unknown } | null } | null;
      if (value?.logo?.mediaId === mediaId) return false;
    }
    return true;
  } catch {
    return false;
  }
}
