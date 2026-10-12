import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

import { prisma } from "../database/prisma.js";
import {
  getCoreMediaStore,
  type ModuleMediaStore,
  resolveMediaPublicBasePath,
} from "../media/index.js";
import { CORE_BRANDING_MEDIA_OWNER } from "./branding-media-reference.js";
import {
  BRANDING_SNAPSHOT_SCHEMA,
  availableBrandingFromSnapshot,
  brandingSnapshotStore,
  readAvailableSnapshotBranding,
  type BrandingSnapshot,
} from "./branding-snapshot.js";
import {
  mayDeleteSupersededBrandingMedia,
  replicateCommittedBrandingRow,
} from "./branding-replication.js";
import { withPersistentSnapshotLock } from "../storage/persistent-snapshot-lock.js";
import {
  getDatabaseWriteOrder,
  isDatabaseConnectionFailure,
} from "../database/database-routing.js";

export const BRANDING_SCHEMA_VERSION = "bonni.branding/v1" as const;
export const BRANDING_SETTING_KEY = "system.branding" as const;
export const BRANDING_MEDIA_OWNER = CORE_BRANDING_MEDIA_OWNER;
export const BRANDING_MAX_PNG_BYTES = 2 * 1024 * 1024;
export const BRANDING_MAX_PNG_DIMENSION = 2048;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_DISPLAY_NAME = "Bonni Core";
const DEFAULT_LOGO_ALT_TEXT = "Bonni Logo";
const PUBLIC_LOGO_FALLBACK_URL = "/system/brand/bonni-logo-original.png";

type StoredLogo = {
  mediaId: string;
  sha256: string;
  width: number;
  height: number;
  mimeType: "image/png";
};

type StoredBranding = {
  schemaVersion: typeof BRANDING_SCHEMA_VERSION;
  revision: number;
  displayName: string;
  logoAltText: string;
  logo: StoredLogo | null;
  updatedByAccountId: string | null;
};

type SettingRow = {
  id?: string;
  key: string;
  value: unknown;
  createdAt?: Date;
  updatedAt: Date;
};

type BrandingDatabase = {
  systemSetting: {
    findUnique(input: any): Promise<SettingRow | null>;
    create(input: any): Promise<SettingRow>;
    updateMany(input: any): Promise<{ count: number }>;
  };
  auditLog: {
    create(input: any): Promise<unknown>;
  };
  $transaction<T>(callback: (transaction: BrandingDatabase) => Promise<T>): Promise<T>;
};

export type PublicBrandingDto = {
  schemaVersion: typeof BRANDING_SCHEMA_VERSION;
  revision: number;
  displayName: string;
  logoAltText: string;
  logo: {
    url: string;
    width: number;
    height: number;
    mimeType: "image/png";
  } | null;
  updatedAt: string | null;
  fallback: boolean;
};

type BrandingServiceOptions = {
  database?: BrandingDatabase;
  mediaStore?: ModuleMediaStore;
  publicMediaBasePath?: string;
  publicCacheTtlMs?: number;
  clock?: () => number;
  snapshotStore?: Pick<typeof brandingSnapshotStore, "read" | "write">;
  replicateCommittedRow?: (row: SettingRow) => Promise<void>;
  withSnapshotLock?: <T>(operation: string, callback: () => Promise<T>) => Promise<T>;
  mayDeleteSupersededMedia?: (mediaId: string) => Promise<boolean>;
  assertAuthoritativeWriteAllowed?: () => void;
};

type ParsedPng = {
  bytes: Buffer;
  width: number;
  height: number;
  sha256: string;
};

function brandingError(code: string, statusCode: number, details?: Record<string, unknown>) {
  return Object.assign(new Error(code), { code, statusCode, ...(details ? { details } : {}) });
}

function boundedText(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string") throw brandingError(`BRANDING_${field}_INVALID`, 400);
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw brandingError(`BRANDING_${field}_INVALID`, 400, { maxCharacters: maximum });
  }
  return normalized;
}

function expectedRevision(value: unknown) {
  const revision = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw brandingError("BRANDING_EXPECTED_REVISION_INVALID", 400);
  }
  return revision;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function storedLogo(value: unknown): StoredLogo | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const mediaId = String(value.mediaId || "").trim();
  const sha256 = String(value.sha256 || "").trim().toLowerCase();
  const width = Number(value.width);
  const height = Number(value.height);
  if (
    !/^[A-Za-z0-9_-]{4,256}\.[A-Za-z0-9_-]{32}$/.test(mediaId)
    || !/^[a-f0-9]{64}$/.test(sha256)
    || !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 1
    || height < 1
    || width > BRANDING_MAX_PNG_DIMENSION
    || height > BRANDING_MAX_PNG_DIMENSION
    || value.mimeType !== "image/png"
  ) return undefined;
  return { mediaId, sha256, width, height, mimeType: "image/png" };
}

function parseStoredBranding(value: unknown): StoredBranding | null {
  if (!isRecord(value) || value.schemaVersion !== BRANDING_SCHEMA_VERSION) return null;
  // A damaged or externally removed logo must not discard an otherwise valid
  // organization name. Only the image falls back to the bundled Core mark.
  const parsedLogo = storedLogo(value.logo);
  const logo = parsedLogo === undefined ? null : parsedLogo;
  if (
    !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
  ) return null;
  try {
    return {
      schemaVersion: BRANDING_SCHEMA_VERSION,
      revision: Number(value.revision),
      displayName: boundedText(value.displayName, "DISPLAY_NAME", 120),
      logoAltText: boundedText(value.logoAltText, "LOGO_ALT_TEXT", 180),
      logo,
      updatedByAccountId: value.updatedByAccountId === null
        ? null
        : boundedText(value.updatedByAccountId, "ACCOUNT_ID", 180),
    };
  } catch {
    return null;
  }
}

function defaultStoredBranding(): StoredBranding {
  return {
    schemaVersion: BRANDING_SCHEMA_VERSION,
    revision: 0,
    displayName: DEFAULT_DISPLAY_NAME,
    logoAltText: DEFAULT_LOGO_ALT_TEXT,
    logo: null,
    updatedByAccountId: null,
  };
}

function fallbackDto(): PublicBrandingDto {
  return {
    schemaVersion: BRANDING_SCHEMA_VERSION,
    revision: 0,
    displayName: DEFAULT_DISPLAY_NAME,
    logoAltText: DEFAULT_LOGO_ALT_TEXT,
    logo: null,
    updatedAt: null,
    fallback: true,
  };
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let number = 0; number < 256; number += 1) {
    let crc = number;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[number] = crc >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function pngCrc(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function passSize(size: number, start: number, step: number) {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

function expectedInflatedBytes(
  width: number,
  height: number,
  bitsPerPixel: number,
  interlace: number,
) {
  const passes = interlace === 0
    ? [[0, 0, 1, 1]]
    : [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ];
  return passes.reduce((total, [startX, startY, stepX, stepY]) => {
    const passWidth = passSize(width, startX, stepX);
    const passHeight = passSize(height, startY, stepY);
    if (!passWidth || !passHeight) return total;
    return total + passHeight * (1 + Math.ceil((passWidth * bitsPerPixel) / 8));
  }, 0);
}

function assertFilterBytes(
  inflated: Buffer,
  width: number,
  height: number,
  bitsPerPixel: number,
  interlace: number,
) {
  const passes = interlace === 0
    ? [[0, 0, 1, 1]]
    : [
        [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
        [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
      ];
  let offset = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = passSize(width, startX, stepX);
    const passHeight = passSize(height, startY, stepY);
    if (!passWidth || !passHeight) continue;
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8);
    for (let row = 0; row < passHeight; row += 1) {
      if (inflated[offset] > 4) throw brandingError("BRANDING_PNG_FILTER_INVALID", 415);
      offset += rowBytes + 1;
    }
  }
  if (offset !== inflated.length) throw brandingError("BRANDING_PNG_DATA_INVALID", 415);
}

/**
 * Parses a complete PNG, validates every chunk CRC and inflated scanline, then
 * strips all non-rendering metadata. Pixel data is not re-encoded; only IHDR,
 * PLTE, a valid transparency chunk, IDAT and IEND survive.
 */
export function validateAndSanitizeBrandingPng(value: unknown): ParsedPng {
  if (!Buffer.isBuffer(value)) throw brandingError("BRANDING_PNG_BODY_REQUIRED", 400);
  if (!value.length) throw brandingError("BRANDING_PNG_BODY_REQUIRED", 400);
  if (value.length > BRANDING_MAX_PNG_BYTES) {
    throw brandingError("BRANDING_PNG_TOO_LARGE", 413, { maxBytes: BRANDING_MAX_PNG_BYTES });
  }
  if (value.length < 45 || !value.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw brandingError("BRANDING_PNG_SIGNATURE_INVALID", 415);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let paletteEntries = 0;
  let sawHeader = false;
  let sawPalette = false;
  let sawTransparency = false;
  let sawData = false;
  let dataEnded = false;
  let sawEnd = false;
  const retainedChunks: Buffer[] = [];
  const compressedParts: Buffer[] = [];

  while (offset < value.length) {
    if (offset + 12 > value.length) throw brandingError("BRANDING_PNG_TRUNCATED", 415);
    const length = value.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > value.length) throw brandingError("BRANDING_PNG_TRUNCATED", 415);
    const typeBytes = value.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) throw brandingError("BRANDING_PNG_CHUNK_TYPE_INVALID", 415);
    const data = value.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = value.readUInt32BE(offset + 8 + length);
    if (pngCrc(value.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      throw brandingError("BRANDING_PNG_CRC_INVALID", 415);
    }
    if (!sawHeader && type !== "IHDR") throw brandingError("BRANDING_PNG_HEADER_INVALID", 415);
    if (sawEnd) throw brandingError("BRANDING_PNG_TRAILING_DATA", 415);

    let retain = false;
    if (type === "IHDR") {
      if (sawHeader || length !== 13) throw brandingError("BRANDING_PNG_HEADER_INVALID", 415);
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      const validDepths: Record<number, number[]> = {
        // Indexed color is deliberately excluded. Without a full pixel
        // re-encode, validating every palette index is unnecessary risk for a
        // branding upload that is fully served by grayscale/RGB/RGBA PNGs.
        0: [1, 2, 4, 8, 16], 2: [8, 16], 4: [8, 16], 6: [8, 16],
      };
      if (
        width < 1 || height < 1
        || width > BRANDING_MAX_PNG_DIMENSION || height > BRANDING_MAX_PNG_DIMENSION
        || !validDepths[colorType]?.includes(bitDepth)
        || data[10] !== 0 || data[11] !== 0 || ![0, 1].includes(interlace)
      ) throw brandingError("BRANDING_PNG_HEADER_INVALID", 415);
      sawHeader = true;
      retain = true;
    } else if (type === "PLTE") {
      if (sawPalette || sawData || [0, 4].includes(colorType) || length < 3 || length > 768 || length % 3) {
        throw brandingError("BRANDING_PNG_PALETTE_INVALID", 415);
      }
      paletteEntries = length / 3;
      if (colorType === 3 && paletteEntries > 2 ** bitDepth) {
        throw brandingError("BRANDING_PNG_PALETTE_INVALID", 415);
      }
      sawPalette = true;
      retain = true;
    } else if (type === "tRNS") {
      const validLength = colorType === 0
        ? length === 2
        : colorType === 2
          ? length === 6
          : colorType === 3
            ? length > 0 && length <= paletteEntries
            : false;
      if (sawTransparency || sawData || !validLength) {
        throw brandingError("BRANDING_PNG_TRANSPARENCY_INVALID", 415);
      }
      sawTransparency = true;
      retain = true;
    } else if (type === "IDAT") {
      if (dataEnded || (colorType === 3 && !sawPalette)) {
        throw brandingError("BRANDING_PNG_DATA_INVALID", 415);
      }
      sawData = true;
      compressedParts.push(data);
      retain = true;
    } else if (type === "IEND") {
      if (!sawData || length !== 0) throw brandingError("BRANDING_PNG_END_INVALID", 415);
      sawEnd = true;
      retain = true;
    } else {
      if (sawData) dataEnded = true;
      if (["acTL", "fcTL", "fdAT"].includes(type)) {
        throw brandingError("BRANDING_ANIMATED_PNG_NOT_ALLOWED", 415);
      }
      // The first type byte is uppercase for critical chunks. Unknown critical
      // chunks cannot be safely discarded and are therefore rejected.
      if ((typeBytes[0] & 0x20) === 0) throw brandingError("BRANDING_PNG_CRITICAL_CHUNK_INVALID", 415);
      // Ancillary metadata is deliberately stripped from the persisted logo.
    }

    if (retain) retainedChunks.push(value.subarray(offset, chunkEnd));
    offset = chunkEnd;
  }

  if (!sawHeader || !sawData || !sawEnd || offset !== value.length) {
    throw brandingError("BRANDING_PNG_INCOMPLETE", 415);
  }

  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  const bitsPerPixel = channels * bitDepth;
  const inflatedLength = expectedInflatedBytes(width, height, bitsPerPixel, interlace);
  let inflated: Buffer;
  try {
    const compressed = Buffer.concat(compressedParts);
    const result = inflateSync(compressed, {
      maxOutputLength: inflatedLength + 1,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    // Node's inflate accepts and ignores bytes following a complete zlib
    // stream. A PNG logo must bind every IDAT byte to that one stream so an
    // attacker cannot smuggle an unparsed payload into the persisted asset.
    if (result.engine.bytesWritten !== compressed.length) {
      throw brandingError("BRANDING_PNG_DATA_INVALID", 415);
    }
    inflated = result.buffer;
  } catch (error) {
    if ((error as { code?: string })?.code === "BRANDING_PNG_DATA_INVALID") throw error;
    throw brandingError("BRANDING_PNG_DATA_INVALID", 415);
  }
  if (inflated.length !== inflatedLength) throw brandingError("BRANDING_PNG_DATA_INVALID", 415);
  assertFilterBytes(inflated, width, height, bitsPerPixel, interlace);

  const bytes = Buffer.concat([PNG_SIGNATURE, ...retainedChunks]);
  return {
    bytes,
    width,
    height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function mediaUrl(basePath: string, mediaId: string) {
  return `${basePath}/${encodeURIComponent(mediaId)}`;
}

export function brandingEtag(branding: PublicBrandingDto) {
  const identity = branding.logo?.url || PUBLIC_LOGO_FALLBACK_URL;
  const digest = createHash("sha256")
    .update(`${branding.revision}\0${branding.displayName}\0${branding.logoAltText}\0${identity}`)
    .digest("hex")
    .slice(0, 24);
  return `"branding-${branding.revision}-${digest}"`;
}

export function createBrandingService(options: BrandingServiceOptions = {}) {
  const database = options.database || (prisma as unknown as BrandingDatabase);
  const mediaStore = options.mediaStore || getCoreMediaStore();
  const publicMediaBasePath = options.publicMediaBasePath
    ? resolveMediaPublicBasePath(options.publicMediaBasePath)
    : "/api/branding/logo";
  const publicCacheTtlMs = Math.min(60_000, Math.max(0, Number(options.publicCacheTtlMs ?? 5_000)));
  const clock = options.clock || Date.now;
  const snapshotStore = options.snapshotStore
    || (options.database ? { async read() { return null; }, async write() {} } : brandingSnapshotStore);
  const replicateCommittedRow = options.replicateCommittedRow
    || (options.database ? async () => undefined : replicateCommittedBrandingRow);
  const withSnapshotLock = options.withSnapshotLock
    || (options.database
      ? async <T>(_operation: string, callback: () => Promise<T>) => callback()
      : withPersistentSnapshotLock);
  const mayDeleteSupersededMedia = options.mayDeleteSupersededMedia
    || (options.database ? async () => true : mayDeleteSupersededBrandingMedia);
  const assertAuthoritativeWriteAllowed = options.assertAuthoritativeWriteAllowed
    || (options.database ? () => undefined : () => { getDatabaseWriteOrder(); });
  let publicCache: { key: string; expiresAt: number; dto: PublicBrandingDto } | null = null;
  let lastDivergenceAuditKey = "";

  function publicCacheKey(row: SettingRow, branding: StoredBranding) {
    return [
      row.updatedAt.toISOString(),
      branding.revision,
      branding.displayName,
      branding.logoAltText,
      branding.logo?.mediaId || "fallback",
      branding.logo?.sha256 || "fallback",
    ].join("\u0000");
  }

  async function recordCleanupFailure(
    mediaId: string,
    phase: "REPLACED" | "RESET" | "UNCOMMITTED",
    error: unknown,
  ) {
    const reason = String(
      (error as { code?: unknown })?.code
      || (error as { name?: unknown })?.name
      || "MEDIA_REMOVE_FAILED",
    ).slice(0, 120);
    try {
      await database.auditLog.create({
        data: {
          category: "SYSTEM",
          event: "SYSTEM_BRANDING_MEDIA_CLEANUP_PENDING",
          result: "FAILED",
          targetType: "ModuleMedia",
          targetId: mediaId,
          reason,
          severity: "WARN",
          metadataJson: { phase, owner: BRANDING_MEDIA_OWNER },
        },
      });
    } catch (auditError) {
      console.error("[bonni-branding] Media cleanup and cleanup audit failed", {
        mediaId,
        phase,
        reason,
        auditReason: String(
          (auditError as { code?: unknown })?.code
          || (auditError as { name?: unknown })?.name
          || "AUDIT_FAILED",
        ).slice(0, 120),
      });
    }
  }

  async function removeMediaObject(mediaId: string, phase: "REPLACED" | "RESET" | "UNCOMMITTED") {
    // Even "UNCOMMITTED" is only the caller's observation. A connection may
    // drop after PostgreSQL committed but before the transaction ACK reached
    // Node. Every configured database must therefore prove non-reference
    // before any newly created object can be erased.
    if (!await mayDeleteSupersededMedia(mediaId)) {
      await recordCleanupFailure(mediaId, phase, Object.assign(
        new Error("BRANDING_MEDIA_STILL_DATABASE_REFERENCED"),
        { code: "BRANDING_MEDIA_STILL_DATABASE_REFERENCED" },
      ));
      return false;
    }
    try {
      await mediaStore.remove(mediaId, BRANDING_MEDIA_OWNER);
      return true;
    } catch (error) {
      await recordCleanupFailure(mediaId, phase, error);
      return false;
    }
  }

  async function publicDtoFromRow(row: SettingRow | null): Promise<PublicBrandingDto> {
    const branding = parseStoredBranding(row?.value);
    if (!branding || !row) return fallbackDto();
    const cacheKey = publicCacheKey(row, branding);
    if (
      publicCache
      && publicCache.key === cacheKey
      && publicCache.expiresAt >= clock()
    ) return structuredClone(publicCache.dto);
    const remember = (dto: PublicBrandingDto) => {
      publicCache = {
        key: cacheKey,
        expiresAt: clock() + publicCacheTtlMs,
        dto: structuredClone(dto),
      };
      return dto;
    };
    if (!branding.logo) {
      return remember({
        schemaVersion: BRANDING_SCHEMA_VERSION,
        revision: branding.revision,
        displayName: branding.displayName,
        logoAltText: branding.logoAltText,
        logo: null,
        updatedAt: row.updatedAt.toISOString(),
        fallback: true,
      });
    }
    const brandingWithoutLogo = (): PublicBrandingDto => ({
      schemaVersion: BRANDING_SCHEMA_VERSION,
      revision: branding.revision,
      displayName: branding.displayName,
      logoAltText: branding.logoAltText,
      logo: null,
      updatedAt: row.updatedAt.toISOString(),
      fallback: true,
    });
    try {
      const media = await mediaStore.read(branding.logo.mediaId);
      if (
        media.moduleKey !== BRANDING_MEDIA_OWNER
        || media.kind !== "image"
        || media.mimeType !== "image/png"
        || media.sha256 !== branding.logo.sha256
      ) return remember(brandingWithoutLogo());
    } catch {
      return remember(brandingWithoutLogo());
    }
    return remember({
      schemaVersion: BRANDING_SCHEMA_VERSION,
      revision: branding.revision,
      displayName: branding.displayName,
      logoAltText: branding.logoAltText,
      logo: {
        url: mediaUrl(publicMediaBasePath, branding.logo.mediaId),
        width: branding.logo.width,
        height: branding.logo.height,
        mimeType: "image/png",
      },
      updatedAt: row.updatedAt.toISOString(),
      fallback: false,
    });
  }

  async function getPublicBranding(): Promise<PublicBrandingDto> {
    try {
      const row = await database.systemSetting.findUnique({ where: { key: BRANDING_SETTING_KEY } });
      const dto = await publicDtoFromRow(row);
      if (!row || !parseStoredBranding(row.value)) return dto;
      const priorSnapshot = await snapshotStore.read().catch(() => null);
      const expected = snapshotIdentity(row, dto);
      if (priorSnapshot && snapshotIdentityFromSnapshot(priorSnapshot) === expected) return dto;
      const stored = parseStoredBranding(row.value);
      const mediaAvailabilityTransition = Boolean(
        priorSnapshot
        && stored?.logo
        && (
          (snapshotMatchesStoredBranding(priorSnapshot, stored) && dto.logo === null)
          || (snapshotIsMediaFallback(priorSnapshot, stored) && dto.logo !== null)
        )
      );
      if (priorSnapshot && mediaAvailabilityTransition) {
        try {
          return await withSnapshotLock("branding-media-availability", async () => {
            const currentRow = await database.systemSetting.findUnique({ where: { key: BRANDING_SETTING_KEY } });
            const currentStored = parseStoredBranding(currentRow?.value);
            if (!currentRow || !currentStored) return dto;
            const currentDto = await publicDtoFromRow(currentRow);
            const currentSnapshot = await snapshotStore.read().catch(() => priorSnapshot);
            const mayDegrade = currentSnapshot
              && snapshotMatchesStoredBranding(currentSnapshot, currentStored)
              && currentStored.logo
              && currentDto.logo === null;
            const mayRecover = currentSnapshot
              && snapshotIsMediaFallback(currentSnapshot, currentStored)
              && currentDto.logo !== null;
            if (!mayDegrade && !mayRecover) {
              return currentSnapshot
                ? availableBrandingFromSnapshot(currentSnapshot, mediaStore)
                : { ...currentDto, logo: null, fallback: true };
            }
            // Same branding revision, availability-only state transition. No
            // database mutation and no media cleanup occurs here.
            await writeCommittedSnapshot(currentRow, currentDto);
            return currentDto;
          });
        } catch {
          return { ...dto, logo: null, fallback: true };
        }
      }
      if (priorSnapshot && priorSnapshot.branding.revision >= dto.revision) {
        await recordSnapshotDivergence(priorSnapshot, row, dto);
        return availableBrandingFromSnapshot(priorSnapshot, mediaStore);
      }
      try {
        return await withSnapshotLock("branding-read-convergence", async () => {
          // A concurrent mutation may have committed after the first read.
          // Resolve the authoritative row again while holding the same lock
          // used by mutations and database+storage backups.
          const currentRow = await database.systemSetting.findUnique({ where: { key: BRANDING_SETTING_KEY } });
          if (!currentRow || !parseStoredBranding(currentRow.value)) return dto;
          const currentDto = await publicDtoFromRow(currentRow);
          const currentSnapshot = await snapshotStore.read().catch(() => priorSnapshot);
          if (currentSnapshot && snapshotIdentityFromSnapshot(currentSnapshot) === snapshotIdentity(currentRow, currentDto)) {
            return currentDto;
          }
          if (currentSnapshot && currentSnapshot.branding.revision >= currentDto.revision) {
            await recordSnapshotDivergence(currentSnapshot, currentRow, currentDto);
            return availableBrandingFromSnapshot(currentSnapshot, mediaStore);
          }
          await replicateCommittedRow(currentRow);
          await writeCommittedSnapshot(currentRow, currentDto);
          const oldMediaId = currentSnapshot?.logoReference?.mediaId;
          const newMediaId = parseStoredBranding(currentRow.value)?.logo?.mediaId;
          if (oldMediaId && oldMediaId !== newMediaId) {
            await removeMediaObject(oldMediaId, newMediaId ? "REPLACED" : "RESET");
          }
          return currentDto;
        });
      } catch {
        // Never expose a DTO logo which the snapshot-authorized logo endpoint
        // cannot serve. The last validated snapshot is a complete consistent
        // read model while deterministic convergence is retried next request.
        return priorSnapshot
          ? availableBrandingFromSnapshot(priorSnapshot, mediaStore)
          : { ...dto, logo: null, fallback: true };
      }
    } catch {
      // Branding is used before authentication. A database or media failure
      // must never turn the login screen into an unavailable system.
      return readAvailableSnapshotBranding(snapshotStore, mediaStore);
    }
  }

  async function recordSnapshotDivergence(
    snapshot: BrandingSnapshot,
    row: SettingRow,
    dto: PublicBrandingDto,
  ) {
    const key = `${snapshot.branding.revision}:${dto.revision}:${row.updatedAt.toISOString()}`;
    if (lastDivergenceAuditKey === key) return;
    lastDivergenceAuditKey = key;
    await database.auditLog.create({
      data: {
        category: "SYSTEM",
        event: "SYSTEM_BRANDING_DATABASE_BEHIND_SNAPSHOT",
        result: "FAILED",
        targetType: "SystemSetting",
        targetId: BRANDING_SETTING_KEY,
        reason: snapshot.branding.revision > dto.revision
          ? "DATABASE_REVISION_BEHIND_SNAPSHOT"
          : "DATABASE_SNAPSHOT_REVISION_DIVERGED",
        severity: "ERROR",
        metadataJson: {
          databaseRevision: dto.revision,
          snapshotRevision: snapshot.branding.revision,
        },
      },
    }).catch(() => undefined);
  }

  function snapshotMatchesStoredBranding(snapshot: BrandingSnapshot, branding: StoredBranding) {
    return snapshot.branding.revision === branding.revision
      && snapshot.branding.displayName === branding.displayName
      && snapshot.branding.logoAltText === branding.logoAltText
      && (snapshot.logoReference?.mediaId || null) === (branding.logo?.mediaId || null)
      && (snapshot.logoReference?.sha256 || null) === (branding.logo?.sha256 || null);
  }

  function snapshotIsMediaFallback(snapshot: BrandingSnapshot, branding: StoredBranding) {
    return Boolean(
      branding.logo
      && snapshot.branding.revision === branding.revision
      && snapshot.branding.displayName === branding.displayName
      && snapshot.branding.logoAltText === branding.logoAltText
      && snapshot.branding.logo === null
      && snapshot.branding.fallback === true
      && snapshot.logoReference?.available === false
      && snapshot.logoReference.mediaId === branding.logo.mediaId
      && snapshot.logoReference.sha256 === branding.logo.sha256
    );
  }

  function snapshotIdentity(row: SettingRow, dto: PublicBrandingDto) {
    const branding = parseStoredBranding(row.value);
    return JSON.stringify({
      revision: branding?.revision ?? -1,
      updatedAt: dto.updatedAt,
      displayName: dto.displayName,
      logoAltText: dto.logoAltText,
      mediaId: branding?.logo?.mediaId || null,
      sha256: branding?.logo?.sha256 || null,
      fallback: dto.fallback,
    });
  }

  function snapshotIdentityFromSnapshot(snapshot: BrandingSnapshot) {
    return JSON.stringify({
      revision: snapshot.branding.revision,
      updatedAt: snapshot.branding.updatedAt,
      displayName: snapshot.branding.displayName,
      logoAltText: snapshot.branding.logoAltText,
      mediaId: snapshot.logoReference?.mediaId || null,
      sha256: snapshot.logoReference?.sha256 || null,
      fallback: snapshot.branding.fallback,
    });
  }

  async function writeCommittedSnapshot(row: SettingRow, dto: PublicBrandingDto) {
    const stored = parseStoredBranding(row.value);
    const logoReference = stored?.logo
      ? {
          mediaId: stored.logo.mediaId,
          sha256: stored.logo.sha256,
          revision: stored.revision,
          width: stored.logo.width,
          height: stored.logo.height,
          available: Boolean(dto.logo),
        }
      : null;
    const snapshot: BrandingSnapshot = {
      schemaVersion: BRANDING_SNAPSHOT_SCHEMA,
      branding: structuredClone(dto),
      logoReference,
      writtenAt: new Date(clock()).toISOString(),
    };
    try {
      await snapshotStore.write(snapshot);
    } catch (error) {
      await database.auditLog.create({
        data: {
          category: "SYSTEM",
          event: "SYSTEM_BRANDING_SNAPSHOT_WRITE_FAILED",
          result: "FAILED",
          targetType: "SystemSetting",
          targetId: BRANDING_SETTING_KEY,
          reason: String((error as { code?: unknown })?.code || "SNAPSHOT_WRITE_FAILED").slice(0, 120),
          severity: "ERROR",
          metadataJson: { revision: stored?.revision ?? null },
        },
      }).catch(() => undefined);
      throw Object.assign(brandingError("BRANDING_SNAPSHOT_WRITE_FAILED", 503), {
        brandingCommitted: true,
      });
    }
  }

  async function mutate(
    expectedRevisionValue: unknown,
    accountIdValue: unknown,
    operation: "TEXT" | "LOGO" | "RESET",
    change: (current: StoredBranding) => StoredBranding,
  ) {
    const revision = expectedRevision(expectedRevisionValue);
    const accountId = boundedText(accountIdValue, "ACCOUNT_ID", 180);
    let committedRow: SettingRow | null = null;
    // Routed Prisma binds `$transaction` through read order and therefore does
    // not invoke the normal delegate write guard. Assert it explicitly while
    // the persistent snapshot lock is held.
    assertAuthoritativeWriteAllowed();
    try {
    await database.$transaction(async (transaction) => {
      const row = await transaction.systemSetting.findUnique({ where: { key: BRANDING_SETTING_KEY } });
      const current = row ? parseStoredBranding(row.value) : defaultStoredBranding();
      if (!current) throw brandingError("BRANDING_SETTING_CORRUPT", 500);
      const snapshot = await snapshotStore.read().catch(() => null);
      if (
        snapshot
        && (snapshot.branding.revision > current.revision
          || (snapshot.branding.revision === current.revision
            && !snapshotMatchesStoredBranding(snapshot, current)
            && !snapshotIsMediaFallback(snapshot, current)))
      ) {
        throw brandingError("BRANDING_DATABASE_BEHIND_SNAPSHOT", 503, {
          databaseRevision: current.revision,
          snapshotRevision: snapshot.branding.revision,
        });
      }
      if (current.revision !== revision) {
        throw brandingError("BRANDING_REVISION_CONFLICT", 409, { currentRevision: current.revision });
      }
      const next = change(current);
      if (next.revision !== current.revision + 1) throw brandingError("BRANDING_REVISION_INVALID", 500);
      if (row) {
        const updated = await transaction.systemSetting.updateMany({
          where: { key: BRANDING_SETTING_KEY, updatedAt: row.updatedAt },
          data: { value: next },
        });
        if (updated.count !== 1) throw brandingError("BRANDING_REVISION_CONFLICT", 409);
        committedRow = await transaction.systemSetting.findUnique({
          where: { key: BRANDING_SETTING_KEY },
        });
        if (!committedRow) throw brandingError("BRANDING_PERSISTENCE_FAILED", 500);
      } else {
        try {
          committedRow = await transaction.systemSetting.create({
            data: { key: BRANDING_SETTING_KEY, value: next },
          });
        } catch (error) {
          if ((error as { code?: string })?.code === "P2002") {
            throw brandingError("BRANDING_REVISION_CONFLICT", 409);
          }
          throw error;
        }
      }
      await transaction.auditLog.create({
        data: {
          category: "SYSTEM",
          event: operation === "TEXT"
            ? "SYSTEM_BRANDING_UPDATED"
            : operation === "LOGO"
              ? "SYSTEM_BRANDING_LOGO_UPDATED"
              : "SYSTEM_BRANDING_LOGO_RESET",
          result: "SUCCESS",
          accountId,
          targetType: "SystemSetting",
          targetId: BRANDING_SETTING_KEY,
          severity: "INFO",
          metadataJson: {
            revision: next.revision,
            fields: operation === "TEXT" ? ["displayName", "logoAltText"] : ["logo"],
            ...(operation === "LOGO" && next.logo ? {
              logo: {
                mimeType: next.logo.mimeType,
                width: next.logo.width,
                height: next.logo.height,
                sha256: next.logo.sha256,
              },
            } : {}),
          },
        },
      });
    });
    } catch (error) {
      if (isDatabaseConnectionFailure(error)) {
        // A CAS transaction has one explicitly authoritative database. In
        // `both` mode we do not fail over and execute it independently on the
        // replica, because that could advance two unrelated revisions.
        throw Object.assign(
          brandingError("BRANDING_AUTHORITATIVE_DATABASE_OUTCOME_UNKNOWN", 503),
          { brandingOutcomeUnknown: true },
        );
      }
      throw error;
    }
    if (!committedRow) throw brandingError("BRANDING_PERSISTENCE_FAILED", 500);
    const authoritativeRow = committedRow as SettingRow;
    try {
      await replicateCommittedRow(authoritativeRow);
    } catch (error) {
      await database.auditLog.create({
        data: {
          category: "SYSTEM",
          event: "SYSTEM_BRANDING_REPLICATION_FAILED",
          result: "FAILED",
          targetType: "SystemSetting",
          targetId: BRANDING_SETTING_KEY,
          reason: String((error as { code?: unknown })?.code || "BRANDING_REPLICATION_FAILED").slice(0, 120),
          severity: "ERROR",
          metadataJson: { revision: parseStoredBranding(authoritativeRow.value)?.revision ?? null },
        },
      }).catch(() => undefined);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        brandingCommitted: true,
      });
    }
    // Successful text/logo/reset mutations supersede every cached DTO. The
    // newly committed row becomes the sole cache key below.
    publicCache = null;
    const dto = await publicDtoFromRow(authoritativeRow);
    await writeCommittedSnapshot(authoritativeRow, dto);
    return dto;
  }

  async function updateBranding(input: {
    displayName: unknown;
    logoAltText: unknown;
    expectedRevision: unknown;
    accountId: unknown;
  }) {
    const displayName = boundedText(input.displayName, "DISPLAY_NAME", 120);
    const logoAltText = boundedText(input.logoAltText, "LOGO_ALT_TEXT", 180);
    return withSnapshotLock("branding-text", () => mutate(
      input.expectedRevision,
      input.accountId,
      "TEXT",
      (current) => ({
        ...current,
        revision: current.revision + 1,
        displayName,
        logoAltText,
        updatedByAccountId: String(input.accountId),
      }),
    ));
  }

  async function updateLogo(input: {
    png: unknown;
    expectedRevision: unknown;
    accountId: unknown;
  }) {
    const png = validateAndSanitizeBrandingPng(input.png);
    return withSnapshotLock("branding-logo", async () => {
      const created = await mediaStore.create(BRANDING_MEDIA_OWNER, {
        kind: "image",
        fileName: "bonni-branding-logo.png",
        mimeType: "image/png",
        dataBase64: png.bytes.toString("base64"),
        scope: "organization-logo",
        metadata: { width: png.width, height: png.height, sanitized: true },
      });
      const previousLogo: { value: StoredLogo | null } = { value: null };
      try {
        const result = await mutate(input.expectedRevision, input.accountId, "LOGO", (current) => {
          previousLogo.value = current.logo;
          return {
            ...current,
            revision: current.revision + 1,
            logo: {
              mediaId: created.id,
              sha256: created.sha256,
              width: png.width,
              height: png.height,
              mimeType: "image/png",
            },
            updatedByAccountId: String(input.accountId),
          };
        });
        if (previousLogo.value?.mediaId && previousLogo.value.mediaId !== created.id) {
          await removeMediaObject(previousLogo.value.mediaId, "REPLACED");
        }
        return result;
      } catch (error) {
        if (!(error as { brandingCommitted?: unknown })?.brandingCommitted) {
          await removeMediaObject(created.id, "UNCOMMITTED");
        }
        throw error;
      }
    });
  }

  async function resetLogo(input: { expectedRevision: unknown; accountId: unknown }) {
    return withSnapshotLock("branding-reset", async () => {
      const previousLogo: { value: StoredLogo | null } = { value: null };
      const result = await mutate(input.expectedRevision, input.accountId, "RESET", (current) => {
        previousLogo.value = current.logo;
        return {
          ...current,
          revision: current.revision + 1,
          logo: null,
          updatedByAccountId: String(input.accountId),
        };
      });
      if (previousLogo.value?.mediaId) {
        await removeMediaObject(previousLogo.value.mediaId, "RESET");
      }
      return result;
    });
  }

  return Object.freeze({ getPublicBranding, updateBranding, updateLogo, resetLogo });
}

export const brandingService = createBrandingService();
