import * as fs from "node:fs/promises";
import path from "node:path";

import {
  createBase64UrlToken,
  decryptAes256Gcm,
  derivePurposeRootKey,
  encryptAes256Gcm,
  hmacDigest,
  sha256,
} from "../../platform/security/crypto/index.js";
import { getRunSystemArchivRoot } from "../../system/boot/run-system/run-system.paths.js";

type DocumentDomain = "people" | "organization";

const STORAGE_VERSION = 1;
const DEFAULT_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const OBJECT_KEY_PATTERN = /^pd_[A-Za-z0-9_-]{32}\.arc$/u;

function storageError(statusCode: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { statusCode, code });
}

function uploadLimit() {
  const configured = Number(process.env.ARCHIVE_UPLOAD_LIMIT_BYTES || DEFAULT_UPLOAD_LIMIT_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_UPLOAD_LIMIT_BYTES;
}

function domainValue(value: DocumentDomain) {
  if (value !== "people" && value !== "organization") {
    storageError(500, "PROTECTED_DOCUMENT_DOMAIN_INVALID", "Die Dokumentendomäne ist ungültig.");
  }
  return value;
}

function subjectDigest(domain: DocumentDomain, subjectId: string) {
  const root = derivePurposeRootKey("dsgvo-audit-hash");
  try {
    return hmacDigest(
      `bonni:protected-document-subject:v${STORAGE_VERSION}|${domain}|${subjectId}`,
      root,
      "sha256",
    ).toString("hex");
  } finally {
    root.fill(0);
  }
}

function documentKey(domain: DocumentDomain, subjectId: string) {
  const root = derivePurposeRootKey("personal-data-encryption");
  try {
    return hmacDigest(
      `bonni:protected-document-key:v${STORAGE_VERSION}|${domain}|${subjectId}`,
      root,
      "sha256",
    );
  } finally {
    root.fill(0);
  }
}

function aad(domain: DocumentDomain, subjectId: string, objectKey: string) {
  return `bonni:protected-document:v${STORAGE_VERSION}|${domain}|${subjectId}|${objectKey}`;
}

function documentDirectory(domain: DocumentDomain, subjectId: string) {
  const digest = subjectDigest(domain, subjectId);
  return path.resolve(
    getRunSystemArchivRoot(),
    "protected-documents",
    domain,
    digest.slice(0, 2),
    digest,
  );
}

function documentPath(domain: DocumentDomain, subjectId: string, objectKey: string) {
  if (!OBJECT_KEY_PATTERN.test(objectKey)) {
    storageError(500, "PROTECTED_DOCUMENT_OBJECT_KEY_INVALID", "Der Dokumentpfad ist ungültig.");
  }
  const directory = documentDirectory(domain, subjectId);
  const resolved = path.resolve(directory, objectKey);
  if (path.dirname(resolved) !== directory) {
    storageError(500, "PROTECTED_DOCUMENT_PATH_INVALID", "Der Dokumentpfad ist ungültig.");
  }
  return resolved;
}

export async function storeProtectedDocument(input: {
  domain: DocumentDomain;
  subjectId: string;
  bytes: Buffer | Uint8Array;
  objectKey?: string;
}) {
  const domain = domainValue(input.domain);
  const subjectId = String(input.subjectId || "").trim();
  const bytes = Buffer.from(input.bytes || []);
  if (!subjectId) storageError(500, "PROTECTED_DOCUMENT_SUBJECT_REQUIRED", "Der Dokumenteigentümer fehlt.");
  if (!bytes.length) storageError(400, "PROTECTED_DOCUMENT_EMPTY", "Die ausgewählte Datei ist leer.");
  if (bytes.length > uploadLimit()) {
    storageError(413, "PROTECTED_DOCUMENT_TOO_LARGE", "Die ausgewählte Datei überschreitet die zulässige Größe.");
  }

  const objectKey = input.objectKey || `pd_${createBase64UrlToken(24)}.arc`;
  const directory = documentDirectory(domain, subjectId);
  const finalPath = documentPath(domain, subjectId, objectKey);
  const temporaryPath = `${finalPath}.${createBase64UrlToken(8)}.tmp`;
  const key = documentKey(domain, subjectId);
  let encrypted: string;
  try {
    encrypted = encryptAes256Gcm(bytes, key, aad(domain, subjectId, objectKey));
  } finally {
    key.fill(0);
  }

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporaryPath, encrypted, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporaryPath, finalPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    storageError(507, "PROTECTED_DOCUMENT_STORAGE_WRITE_FAILED", "Die verschlüsselte Datei konnte nicht gespeichert werden.");
  }

  return Object.freeze({
    objectKey,
    checksum: sha256(bytes),
    sizeInBytes: bytes.length,
    storageVersion: STORAGE_VERSION,
    encryptionVersion: STORAGE_VERSION,
    keyVersion: STORAGE_VERSION,
  });
}

export async function readProtectedDocument(input: {
  domain: DocumentDomain;
  subjectId: string;
  objectKey: string;
}) {
  const domain = domainValue(input.domain);
  const subjectId = String(input.subjectId || "").trim();
  const objectKey = String(input.objectKey || "").trim();
  const encrypted = await fs.readFile(documentPath(domain, subjectId, objectKey), "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT") {
        storageError(404, "PROTECTED_DOCUMENT_CONTENT_NOT_FOUND", "Der Dokumentinhalt wurde nicht gefunden.");
      }
      storageError(507, "PROTECTED_DOCUMENT_STORAGE_READ_FAILED", "Die verschlüsselte Datei konnte nicht gelesen werden.");
    });
  const key = documentKey(domain, subjectId);
  try {
    return decryptAes256Gcm(encrypted, key, aad(domain, subjectId, objectKey));
  } finally {
    key.fill(0);
  }
}

export async function deleteProtectedDocument(input: {
  domain: DocumentDomain;
  subjectId: string;
  objectKey: string;
}) {
  const domain = domainValue(input.domain);
  const subjectId = String(input.subjectId || "").trim();
  const objectKey = String(input.objectKey || "").trim();
  await fs.unlink(documentPath(domain, subjectId, objectKey)).catch((error: NodeJS.ErrnoException) => {
    if (error?.code !== "ENOENT") {
      storageError(507, "PROTECTED_DOCUMENT_STORAGE_DELETE_FAILED", "Die verschlüsselte Datei konnte nicht gelöscht werden.");
    }
  });
}
