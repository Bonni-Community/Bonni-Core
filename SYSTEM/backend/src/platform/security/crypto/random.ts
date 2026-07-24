import { randomBytes, randomInt } from "node:crypto";

const DEFAULT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEFAULT_TOKEN_BYTES = 32;

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function assertAlphabet(alphabet: string): void {
  if (!alphabet || alphabet.length < 2) {
    throw new Error("alphabet must contain at least two characters.");
  }
}

export function secureRandomBytes(length = DEFAULT_TOKEN_BYTES): Buffer {
  assertPositiveInteger(length, "length");
  return randomBytes(length);
}

export function createRandomString(length: number, alphabet = DEFAULT_CODE_ALPHABET): string {
  assertPositiveInteger(length, "length");
  assertAlphabet(alphabet);

  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += alphabet[randomInt(0, alphabet.length)];
  }
  return value;
}

export function createRandomCode(length = 10): string {
  return createRandomString(length, DEFAULT_CODE_ALPHABET);
}

export function createNumericCode(length = 8): string {
  return createRandomString(length, "0123456789");
}

export function createHexToken(bytes = DEFAULT_TOKEN_BYTES): string {
  assertPositiveInteger(bytes, "bytes");
  return randomBytes(bytes).toString("hex");
}

export function createBase64UrlToken(bytes = DEFAULT_TOKEN_BYTES): string {
  assertPositiveInteger(bytes, "bytes");
  return randomBytes(bytes).toString("base64url");
}
