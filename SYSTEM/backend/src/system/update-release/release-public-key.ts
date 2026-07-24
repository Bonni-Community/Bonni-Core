import crypto, { type KeyObject } from "node:crypto";
import fs from "node:fs/promises";

import type { ReleasePublicKey } from "./release-signature.js";

const SPKI_PUBLIC_KEY_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/;

function pemText(value: ReleasePublicKey) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return null;
}

/**
 * Parses only an Ed25519 SubjectPublicKeyInfo PEM. In particular, Node's
 * `createPublicKey` also accepts a private PEM and derives its public half;
 * that convenience is unsafe for a mounted release trust store.
 */
export function parseEd25519SpkiPublicKey(value: ReleasePublicKey): KeyObject {
  const text = pemText(value);
  if (text !== null && !SPKI_PUBLIC_KEY_PEM.test(text.trim())) {
    throw new Error("RELEASE_KEY_MUST_BE_ED25519_SPKI_PUBLIC_KEY");
  }

  const key = value instanceof crypto.KeyObject ? value : crypto.createPublicKey(value);
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("RELEASE_KEY_MUST_BE_ED25519_SPKI_PUBLIC_KEY");
  }
  return key;
}

export async function loadEd25519SpkiPublicKeyFile(file: string): Promise<string> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 32 || stat.size > 16_384) {
    throw new Error("RELEASE_KEY_FILE_MUST_BE_SECURE_REGULAR_FILE");
  }
  const pem = await fs.readFile(file, "utf8");
  parseEd25519SpkiPublicKey(pem);
  return pem;
}
