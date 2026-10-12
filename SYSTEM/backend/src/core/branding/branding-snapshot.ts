import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolvePersistentStorageRoot } from "../../../scripts/storage/persistent-storage-root.mjs";
import { getCoreMediaStore, type ModuleMediaStore } from "../media/index.js";
import type { PublicBrandingDto } from "./branding.service.js";

export const BRANDING_SNAPSHOT_SCHEMA = "bonni.branding-snapshot/v1" as const;

export type BrandingSnapshot = {
  schemaVersion: typeof BRANDING_SNAPSHOT_SCHEMA;
  branding: PublicBrandingDto;
  logoReference: {
    mediaId: string;
    sha256: string;
    revision: number;
    width?: number;
    height?: number;
    /** False keeps the expected capability identity while serving no URL. */
    available?: boolean;
  } | null;
  writtenAt: string;
};

function snapshotPath(root = resolvePersistentStorageRoot()) {
  return path.join(root, "system", "branding", "current.json");
}

function validSnapshot(value: unknown): value is BrandingSnapshot {
  const snapshot = value as BrandingSnapshot;
  const branding = snapshot?.branding;
  const reference = snapshot?.logoReference;
  const validText = (text: unknown, maximum: number) => typeof text === "string"
    && text.length > 0
    && text.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(text);
  const validLogo = branding?.logo === null || Boolean(
    branding?.logo
    && branding.logo.mimeType === "image/png"
    && Number.isSafeInteger(branding.logo.width) && branding.logo.width >= 1 && branding.logo.width <= 2048
    && Number.isSafeInteger(branding.logo.height) && branding.logo.height >= 1 && branding.logo.height <= 2048
    && typeof branding.logo.url === "string"
  );
  return Boolean(
    snapshot?.schemaVersion === BRANDING_SNAPSHOT_SCHEMA
    && branding?.schemaVersion === "bonni.branding/v1"
    && Number.isSafeInteger(branding.revision) && branding.revision >= 0
    && validText(branding.displayName, 120)
    && validText(branding.logoAltText, 180)
    && validLogo
    && (branding.updatedAt === null || Number.isFinite(Date.parse(branding.updatedAt)))
    && typeof branding.fallback === "boolean"
    && (reference === null || (
      typeof reference?.mediaId === "string"
      && /^[A-Za-z0-9_-]{4,256}\.[A-Za-z0-9_-]{32}$/.test(reference.mediaId)
      && /^[a-f0-9]{64}$/.test(reference.sha256)
      && reference.revision === branding.revision
      && (
        (reference.width === undefined && reference.height === undefined)
        || (
          typeof reference.width === "number"
          && Number.isSafeInteger(reference.width) && reference.width >= 1 && reference.width <= 2048
          && typeof reference.height === "number"
          && Number.isSafeInteger(reference.height) && reference.height >= 1 && reference.height <= 2048
        )
      )
      && (reference.available === undefined || typeof reference.available === "boolean")
      && (reference.available === false || (
        branding.logo?.mimeType === "image/png"
        && branding.logo?.url === `/api/branding/logo/${encodeURIComponent(reference.mediaId)}`
      ))
    ))
    && (
      (branding.logo === null && reference === null)
      || (branding.logo === null && reference?.available === false && branding.fallback === true)
      || (branding.logo !== null && reference !== null && reference.available !== false)
    )
    && Number.isFinite(Date.parse(snapshot.writtenAt))
  );
}

export function createBrandingSnapshotStore(options: { root?: string } = {}) {
  const file = snapshotPath(options.root);
  return Object.freeze({
    async read(): Promise<BrandingSnapshot | null> {
      try {
        const state = await fs.lstat(file);
        if (!state.isFile() || state.isSymbolicLink() || state.size > 64 * 1024) return null;
        const parsed = JSON.parse(await fs.readFile(file, "utf8"));
        return validSnapshot(parsed) ? structuredClone(parsed) : null;
      } catch {
        return null;
      }
    },
    async write(snapshot: BrandingSnapshot) {
      if (!validSnapshot(snapshot)) throw new Error("BRANDING_SNAPSHOT_INVALID");
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, file);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    },
  });
}

export const brandingSnapshotStore = createBrandingSnapshotStore();

export function snapshotFallbackBranding(): PublicBrandingDto {
  return {
    schemaVersion: "bonni.branding/v1",
    revision: 0,
    displayName: "Bonni Core",
    logoAltText: "Bonni Logo",
    logo: null,
    updatedAt: null,
    fallback: true,
  };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CORE_BRANDING_MEDIA_OWNER = "core.branding";

/**
 * A snapshot is the failover read model, but its media reference is not proof
 * that the immutable object is still readable. Keep the useful organization
 * text/revision when media storage is unavailable and suppress only the logo
 * capability. The persistent snapshot is deliberately not rewritten here so
 * a temporary storage outage can recover without a database write.
 */
export async function availableBrandingFromSnapshot(
  snapshot: BrandingSnapshot,
  mediaStore: Pick<ModuleMediaStore, "read"> = getCoreMediaStore(),
): Promise<PublicBrandingDto> {
  if (!snapshot.logoReference) return snapshot.branding;
  try {
    const media = await mediaStore.read(snapshot.logoReference.mediaId);
    const bytes = Buffer.from(media.bytes);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (
      media.moduleKey !== CORE_BRANDING_MEDIA_OWNER
      || media.kind !== "image"
      || media.mimeType !== "image/png"
      || media.id !== snapshot.logoReference.mediaId
      || media.sha256 !== snapshot.logoReference.sha256
      || digest !== snapshot.logoReference.sha256
      || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) throw new Error("BRANDING_SNAPSHOT_MEDIA_INVALID");
    if (snapshot.branding.logo) return snapshot.branding;
    if (
      snapshot.logoReference.available === false
      && Number.isSafeInteger(snapshot.logoReference.width)
      && Number.isSafeInteger(snapshot.logoReference.height)
    ) {
      return {
        ...snapshot.branding,
        logo: {
          url: `/api/branding/logo/${encodeURIComponent(snapshot.logoReference.mediaId)}`,
          width: snapshot.logoReference.width!,
          height: snapshot.logoReference.height!,
          mimeType: "image/png",
        },
        fallback: false,
      };
    }
    return snapshot.branding;
  } catch {
    return { ...snapshot.branding, logo: null, fallback: true };
  }
}

export async function readAvailableSnapshotBranding(
  store: Pick<typeof brandingSnapshotStore, "read"> = brandingSnapshotStore,
  mediaStore: Pick<ModuleMediaStore, "read"> = getCoreMediaStore(),
): Promise<PublicBrandingDto> {
  const snapshot = await store.read().catch(() => null);
  return snapshot
    ? availableBrandingFromSnapshot(snapshot, mediaStore)
    : snapshotFallbackBranding();
}

export function createSnapshotBrandingReadService(
  store = brandingSnapshotStore,
  mediaStore: Pick<ModuleMediaStore, "read"> = getCoreMediaStore(),
) {
  return Object.freeze({
    async getPublicBranding() {
      return readAvailableSnapshotBranding(store, mediaStore);
    },
  });
}
