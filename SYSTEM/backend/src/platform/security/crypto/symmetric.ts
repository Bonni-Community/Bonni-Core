import { createCipheriv, createDecipheriv } from "node:crypto";

import { secureRandomBytes } from "./random.js";

const AES_256_GCM_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;

function assertAes256Key(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== AES_256_GCM_KEY_BYTES) {
    throw new Error(`AES-256-GCM key must be ${AES_256_GCM_KEY_BYTES} bytes.`);
  }
}

function normalizeAad(additionalAuthenticatedData?: string | Buffer): Buffer | undefined {
  if (!additionalAuthenticatedData) {
    return undefined;
  }

  return Buffer.isBuffer(additionalAuthenticatedData)
    ? additionalAuthenticatedData
    : Buffer.from(additionalAuthenticatedData, "utf8");
}

export function encryptAes256Gcm(
  plaintext: string | Buffer,
  key: Buffer,
  additionalAuthenticatedData?: string | Buffer,
): string {
  assertAes256Key(key);

  const iv = secureRandomBytes(AES_GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const aad = normalizeAad(additionalAuthenticatedData);

  if (aad) {
    cipher.setAAD(aad);
  }

  const encrypted = Buffer.concat([
    cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptAes256Gcm(
  value: string,
  key: Buffer,
  additionalAuthenticatedData?: string | Buffer,
): Buffer {
  assertAes256Key(key);

  const [ivEncoded, authTagEncoded, encryptedEncoded] = value.split(".");
  if (!ivEncoded || !authTagEncoded || !encryptedEncoded) {
    throw Object.assign(new Error("ENCRYPTED_VALUE_CORRUPT"), { statusCode: 500 });
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivEncoded, "base64url"));
  const aad = normalizeAad(additionalAuthenticatedData);

  if (aad) {
    decipher.setAAD(aad);
  }

  decipher.setAuthTag(Buffer.from(authTagEncoded, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedEncoded, "base64url")),
    decipher.final(),
  ]);
}

export function decryptAes256GcmToUtf8(
  value: string,
  key: Buffer,
  additionalAuthenticatedData?: string | Buffer,
): string {
  return decryptAes256Gcm(value, key, additionalAuthenticatedData).toString("utf8");
}
