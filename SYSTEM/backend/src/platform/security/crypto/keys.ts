import { createBase64UrlToken, secureRandomBytes } from "./random.js";

export function createSecureKey(bytes = 32): string {
  return createBase64UrlToken(bytes);
}

export function createEncryptionKeyBase64(bytes = 32): string {
  return secureRandomBytes(bytes).toString("base64");
}

export function readBase64Key(value: string, expectedBytes = 32): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== expectedBytes) {
    throw new Error(`Invalid key length. Expected ${expectedBytes} bytes.`);
  }
  return key;
}
