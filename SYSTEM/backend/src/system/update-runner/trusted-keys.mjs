import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const SPKI_PUBLIC_KEY_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function parseEd25519SpkiPublicKey(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : null;
  if (text !== null && !SPKI_PUBLIC_KEY_PEM.test(text.trim())) {
    throw new Error("RELEASE_KEY_MUST_BE_ED25519_SPKI_PUBLIC_KEY");
  }
  const key = value instanceof crypto.KeyObject ? value : crypto.createPublicKey(value);
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("RELEASE_KEY_MUST_BE_ED25519_SPKI_PUBLIC_KEY");
  }
  return key;
}

async function loadPublicKeyFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 32 || stat.size > 16_384) {
    throw new Error("RELEASE_KEY_FILE_MUST_BE_SECURE_REGULAR_FILE");
  }
  const pem = await fs.readFile(file, "utf8");
  parseEd25519SpkiPublicKey(pem);
  return pem;
}

export async function loadTrustedReleaseKeys(env, projectRoot) {
  const keyDirectory = env.BONNI_UPDATE_TRUSTED_KEYS_DIR
    ? path.resolve(env.BONNI_UPDATE_TRUSTED_KEYS_DIR)
    : null;
  if (keyDirectory) {
    const directoryStat = await fs.lstat(keyDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("Release-Vertrauensspeicher ist kein sicheres Verzeichnis.");
    }
    const entries = await fs.readdir(keyDirectory, { withFileTypes: true });
    const result = {};
    for (const entry of entries) {
      const match = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\.pem$/.exec(entry.name);
      if (!match) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Ungültiger Release-Schlüssel: ${entry.name}`);
      result[match[1]] = await loadPublicKeyFile(path.join(keyDirectory, entry.name));
    }
    return result;
  }

  const keyringPath = path.resolve(env.BONNI_UPDATE_TRUSTED_KEYS_FILE || path.join(projectRoot, "System", "backend", "config", "update", "trusted-keys.json"));
  if (existsSync(keyringPath)) {
    const parsed = JSON.parse(await fs.readFile(keyringPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Ungültiger Release-Keyring.");
    const result = {};
    for (const [keyId, relativeOrPem] of Object.entries(parsed)) {
      if (!KEY_ID.test(keyId) || typeof relativeOrPem !== "string") throw new Error("Ungültiger Eintrag im Release-Keyring.");
      if (relativeOrPem.includes("-----BEGIN")) {
        parseEd25519SpkiPublicKey(relativeOrPem);
        result[keyId] = relativeOrPem;
      } else {
        result[keyId] = await loadPublicKeyFile(path.resolve(path.dirname(keyringPath), relativeOrPem));
      }
    }
    return result;
  }

  const publicKeyPath = path.resolve(env.BONNI_UPDATE_PUBLIC_KEY_PATH || path.join(projectRoot, "System", "backend", "config", "update", "public-key.pem"));
  const keyId = env.BONNI_UPDATE_KEY_ID || "bonni-core-release";
  if (!KEY_ID.test(keyId)) throw new Error("Ungültige Release-Key-ID.");
  if (!existsSync(publicKeyPath)) return {};
  return { [keyId]: await loadPublicKeyFile(publicKeyPath) };
}
