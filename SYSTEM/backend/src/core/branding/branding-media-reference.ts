import { createHash } from "node:crypto";

import { prisma } from "../database/prisma.js";
import type { StoredModuleMedia } from "../media/module-media-runtime.js";
import { brandingSnapshotStore } from "./branding-snapshot.js";

export const CORE_BRANDING_MEDIA_OWNER = "core.branding" as const;
const BRANDING_SETTING_KEY = "system.branding";
const BRANDING_SCHEMA_VERSION = "bonni.branding/v1";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type BrandingReferenceDatabase = {
  systemSetting: {
    findUnique(input: any): Promise<{ value: unknown } | null>;
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Branding capability URLs are intentionally revocable. Unlike ordinary
 * immutable module images, a Core logo is served only while its exact ID and
 * digest are the current `system.branding` reference.
 */
export function createCoreBrandingMediaAuthorizer(
  database: BrandingReferenceDatabase = prisma as unknown as BrandingReferenceDatabase,
) {
  return async (media: StoredModuleMedia) => {
    if (media.moduleKey !== CORE_BRANDING_MEDIA_OWNER) return true;
    try {
      const row = await database.systemSetting.findUnique({ where: { key: BRANDING_SETTING_KEY } });
      const branding = record(row?.value);
      const logo = record(branding?.logo);
      return Boolean(
        branding?.schemaVersion === BRANDING_SCHEMA_VERSION
        && logo?.mediaId === media.id
        && logo?.sha256 === media.sha256
        && logo?.mimeType === "image/png",
      );
    } catch {
      // If the authoritative reference is unavailable, fail closed. The
      // public branding DTO independently falls back to the bundled logo.
      return false;
    }
  };
}

export const authorizeCurrentCoreBrandingMedia = createCoreBrandingMediaAuthorizer();

export function createSnapshotCoreBrandingMediaAuthorizer(store = brandingSnapshotStore) {
  return async (media: StoredModuleMedia) => {
    if (media.moduleKey !== CORE_BRANDING_MEDIA_OWNER) return true;
    const reference = (await store.read())?.logoReference;
    const bytes = Buffer.from(media.bytes);
    return Boolean(
      reference
      && reference.mediaId === media.id
      && reference.sha256 === media.sha256
      && media.kind === "image"
      && media.mimeType === "image/png"
      && createHash("sha256").update(bytes).digest("hex") === reference.sha256
      && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    );
  };
}

export const authorizeSnapshotCoreBrandingMedia = createSnapshotCoreBrandingMediaAuthorizer();
