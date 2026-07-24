#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const privateFile = path.resolve(argument("--private") || "release-secrets/bonni-core-release-private.pem");
const publicFile = path.resolve(argument("--public") || "release-secrets/bonni-core-release-public.pem");

if (privateFile === publicFile) throw new Error("Privater und öffentlicher Schlüssel benötigen unterschiedliche Dateien.");

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
await fs.mkdir(path.dirname(privateFile), { recursive: true, mode: 0o700 });
await fs.mkdir(path.dirname(publicFile), { recursive: true, mode: 0o700 });

const privateHandle = await fs.open(privateFile, "wx", 0o600);
try {
  await privateHandle.writeFile(privateKey.export({ type: "pkcs8", format: "pem" }));
} finally {
  await privateHandle.close();
}

try {
  const publicHandle = await fs.open(publicFile, "wx", 0o644);
  try {
    await publicHandle.writeFile(publicKey.export({ type: "spki", format: "pem" }));
  } finally {
    await publicHandle.close();
  }
} catch (error) {
  await fs.unlink(privateFile).catch(() => undefined);
  throw error;
}

console.log(`Privater Release-Schlüssel: ${privateFile}`);
console.log(`Öffentlicher Vertrauensschlüssel: ${publicFile}`);
console.log("Den privaten Schlüssel ausschließlich auf dem getrennten Release-System aufbewahren.");
