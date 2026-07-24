import { z } from "zod";

import { isStrictSemVer, parseStrictSemVer } from "./semver.js";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 2 as const;
export const RELEASE_MANIFEST_PRODUCT = "bonni-core" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const IMAGE_COMPONENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function isCanonicalUtcTimestamp(value: string) {
  if (!UTC_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const canonical = parsed.toISOString();
  return value.endsWith(".000Z") ? canonical === value : canonical.replace(/\.000Z$/, "Z") === value;
}

export function isSafeRelativeReleasePath(value: string) {
  if (!value || value.length > 512 || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => Boolean(part) && part !== "." && part !== "..");
}

function isStructurallySecureHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.hash
      && (!url.port || url.port === "443");
  } catch {
    return false;
  }
}

function isImageRepository(value: string) {
  if (!value || value.length > 255 || value !== value.toLowerCase() || value.includes("@")) return false;
  const parts = value.split("/");
  if (parts.length < 2 || parts.some((part) => !part)) return false;

  return parts.every((part, index) => {
    if (index === 0 && part.includes(":")) {
      const separator = part.lastIndexOf(":");
      const host = part.slice(0, separator);
      const port = part.slice(separator + 1);
      return host.split(".").every((component) => IMAGE_COMPONENT_PATTERN.test(component))
        && /^[1-9]\d{0,4}$/.test(port)
        && Number(port) <= 65535;
    }
    return IMAGE_COMPONENT_PATTERN.test(part);
  });
}

const strictSemVerSchema = z.string().max(128).refine(isStrictSemVer, "Muss eine strikte SemVer-Version sein.");
const utcTimestampSchema = z.string().max(32).refine(isCanonicalUtcTimestamp, "Muss ein kanonischer UTC-Zeitstempel sein.");

export const releaseArtifactSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    path: z.string().min(1).max(512).refine(isSafeRelativeReleasePath, "Unsicherer lokaler Paketpfad."),
  }).strict(),
  z.object({
    kind: z.literal("https"),
    url: z.string().min(1).max(2_048).refine(isStructurallySecureHttpsUrl, "Unsichere HTTPS-Paketquelle."),
  }).strict(),
]);

export const releaseImageIdentitySchema = z.object({
  repository: z.string().min(3).max(255).refine(isImageRepository, "Ungültiger OCI-Repositoryname."),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/, "Ungültiger OCI-Image-Digest."),
  platform: z.object({
    os: z.literal("linux"),
    architecture: z.enum(["amd64", "arm64"]),
    variant: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/).optional(),
  }).strict(),
}).strict();

export const releaseMigrationSchema = z.object({
  required: z.boolean(),
  strategy: z.enum(["none", "expand-contract", "offline"]),
  fromSchemaVersion: strictSemVerSchema,
  toSchemaVersion: strictSemVerSchema,
  backwardCompatible: z.boolean(),
}).strict().superRefine((migration, context) => {
  if (!migration.required && migration.strategy !== "none") {
    context.addIssue({ code: "custom", path: ["strategy"], message: "Ohne Migration muss die Strategie none sein." });
  }
  if (migration.required && migration.strategy === "none") {
    context.addIssue({ code: "custom", path: ["strategy"], message: "Eine erforderliche Migration benötigt eine Strategie." });
  }
  if (!migration.required && migration.fromSchemaVersion !== migration.toSchemaVersion) {
    context.addIssue({ code: "custom", path: ["toSchemaVersion"], message: "Ohne Migration dürfen sich Schemas nicht unterscheiden." });
  }
});

export const releaseManifestPayloadSchema = z.object({
  schemaVersion: z.literal(RELEASE_MANIFEST_SCHEMA_VERSION),
  product: z.literal(RELEASE_MANIFEST_PRODUCT),
  channel: z.enum(["stable", "beta", "nightly"]),
  version: strictSemVerSchema,
  artifact: z.object({
    type: z.enum(["oci-image-archive", "bonni-release-bundle"]),
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(SHA256_PATTERN, "Ungültige SHA-256-Prüfsumme."),
    source: releaseArtifactSourceSchema,
    imageIdentity: releaseImageIdentitySchema,
  }).strict(),
  migration: releaseMigrationSchema,
  issuedAt: utcTimestampSchema,
  expiresAt: utcTimestampSchema,
  minimumRunnerVersion: strictSemVerSchema,
  releaseNotes: z.object({
    title: z.string().min(1).max(160),
    descriptions: z.record(z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/), z.string().min(1).max(20_000)).optional(),
    highlights: z.array(z.string().min(1).max(500)).max(50).optional(),
  }).strict().optional(),
}).strict().superRefine((manifest, context) => {
  const issuedAt = Date.parse(manifest.issuedAt);
  const expiresAt = Date.parse(manifest.expiresAt);
  if (expiresAt <= issuedAt) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "expiresAt muss nach issuedAt liegen." });
  }

  const version = parseStrictSemVer(manifest.version);
  if (manifest.channel === "stable" && version.prerelease.length > 0) {
    context.addIssue({ code: "custom", path: ["version"], message: "Der stable-Kanal erlaubt keine Vorabversion." });
  }
});

export const releaseManifestSignatureSchema = z.object({
  algorithm: z.literal("Ed25519"),
  keyId: z.string().regex(KEY_ID_PATTERN, "Ungültige Schlüssel-ID."),
  value: z.string().min(1).max(256),
}).strict();

export const releaseManifestSchema = releaseManifestPayloadSchema.extend({
  signature: releaseManifestSignatureSchema.optional(),
}).strict();

export type ReleaseArtifactSource = z.infer<typeof releaseArtifactSourceSchema>;
export type ReleaseImageIdentity = z.infer<typeof releaseImageIdentitySchema>;
export type ReleaseMigration = z.infer<typeof releaseMigrationSchema>;
export type ReleaseManifestPayload = z.infer<typeof releaseManifestPayloadSchema>;
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  return releaseManifestSchema.parse(value);
}

export function parseReleaseManifestPayload(value: unknown): ReleaseManifestPayload {
  return releaseManifestPayloadSchema.parse(value);
}
