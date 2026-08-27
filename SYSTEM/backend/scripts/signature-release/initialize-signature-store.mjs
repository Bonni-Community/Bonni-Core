#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFINITIONS = Object.freeze({
  root: Object.freeze({ directory: "root", productId: "bonni-trust-root", keyScope: "root", prefix: "bonni-root" }),
  core: Object.freeze({ directory: "core", productId: "bonni-core", keyScope: "core", prefix: "bonni-core" }),
  kontor: Object.freeze({ directory: "apps/kontor", productId: "bonni-app-kontor", keyScope: "app:kontor", prefix: "bonni-app-kontor" }),
  stueberl: Object.freeze({ directory: "apps/stueberl", productId: "bonni-app-stueberl", keyScope: "app:stueberl", prefix: "bonni-app-stueberl" }),
  hocket: Object.freeze({ directory: "apps/hocket", productId: "bonni-app-hocket", keyScope: "app:hocket", prefix: "bonni-app-hocket" }),
});

const ALIASES = new Map([
  ["root", "root"], ["core", "core"], ["kontor", "kontor"], ["kontorapp", "kontor"],
  ["stueberl", "stueberl"], ["stüberl", "stueberl"], ["hocket", "hocket"], ["hocketapp", "hocket"],
]);

function parseArguments(argv, env = process.env) {
  let signatureRoot = env.BONNI_SIGNATURE_ROOT;
  const targets = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--signature-root") {
      if (signatureRoot && signatureRoot !== env.BONNI_SIGNATURE_ROOT) throw new Error("SIGNATURE_INIT_ROOT_DUPLICATE");
      signatureRoot = argv[++index];
      if (!signatureRoot || signatureRoot.startsWith("--")) throw new Error("SIGNATURE_INIT_ROOT_VALUE_MISSING");
      continue;
    }
    if (value.startsWith("-")) throw new Error(`SIGNATURE_INIT_UNKNOWN_ARGUMENT:${value}`);
    const target = ALIASES.get(String(value).toLocaleLowerCase("de-DE"));
    if (!target) throw new Error(`SIGNATURE_INIT_UNKNOWN_TARGET:${value}`);
    if (!targets.includes(target)) targets.push(target);
  }
  if (!signatureRoot) throw new Error("SIGNATURE_ROOT_REQUIRED: --signature-root oder BONNI_SIGNATURE_ROOT");
  if (!targets.length) throw new Error("SIGNATURE_INIT_TARGET_REQUIRED");
  return { signatureRoot: path.resolve(signatureRoot), targets };
}

async function existingState(target) {
  try { return await fs.lstat(target); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNoLinkedDirectoryComponents(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("SIGNATURE_SCOPE_PATH_INVALID");
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const state = await existingState(cursor);
    if (!state) break;
    if (state.isSymbolicLink() || !state.isDirectory()) throw new Error("SIGNATURE_SCOPE_LINK_FORBIDDEN");
    const real = await fs.realpath(cursor);
    const realRelative = path.relative(root, real);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("SIGNATURE_SCOPE_REALPATH_ESCAPE");
  }
}

function fingerprint(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex");
}

async function writeExclusive(target, data, mode) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const handle = await fs.open(target, "wx", mode);
  try { await handle.writeFile(data); } finally { await handle.close(); }
}

export async function initializeSignatureStore(options) {
  const signatureRoot = path.resolve(options.signatureRoot);
  const rootState = await existingState(signatureRoot);
  if (rootState?.isSymbolicLink() || (rootState && !rootState.isDirectory())) throw new Error("SIGNATURE_ROOT_UNSAFE");
  await fs.mkdir(signatureRoot, { recursive: true, mode: 0o700 });
  const realRoot = await fs.realpath(signatureRoot);
  if (realRoot !== signatureRoot && process.platform !== "win32") throw new Error("SIGNATURE_ROOT_REALPATH_MISMATCH");

  for (const target of options.targets) {
    const definition = DEFINITIONS[target];
    if (!definition) throw new Error(`SIGNATURE_INIT_UNKNOWN_TARGET:${target}`);
    const scopeRoot = path.join(signatureRoot, definition.directory);
    await assertNoLinkedDirectoryComponents(signatureRoot, scopeRoot);
    await assertNoLinkedDirectoryComponents(signatureRoot, path.join(scopeRoot, "keys"));
    for (const relative of ["policy.json", "keys/release-private.pem", "keys/release-public.pem"]) {
      if (await existingState(path.join(scopeRoot, relative))) throw new Error(`SIGNATURE_SCOPE_ALREADY_EXISTS:${target}`);
    }
  }

  const created = [];
  for (const target of options.targets) {
    const definition = DEFINITIONS[target];
    const scopeRoot = path.join(signatureRoot, definition.directory);
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const publicFingerprint = fingerprint(publicKey);
    const keyId = `${definition.prefix}-stable-${publicFingerprint.slice(0, 16)}`;
    await writeExclusive(
      path.join(scopeRoot, "keys", "release-private.pem"),
      privateKey.export({ type: "pkcs8", format: "pem" }),
      0o600,
    );
    await writeExclusive(
      path.join(scopeRoot, "keys", "release-public.pem"),
      publicKey.export({ type: "spki", format: "pem" }),
      0o644,
    );
    const policy = {
      schemaVersion: 1,
      productId: definition.productId,
      keyScope: definition.keyScope,
      keyId,
      privateKeyRelativePath: "keys/release-private.pem",
    };
    await writeExclusive(path.join(scopeRoot, "policy.json"), `${JSON.stringify(policy, null, 2)}\n`, 0o600);
    created.push({ target, productId: definition.productId, keyScope: definition.keyScope, keyId, publicFingerprint });
  }

  const marker = path.join(signatureRoot, "BONNI-SIGNATUR.json");
  if (!(await existingState(marker))) {
    await writeExclusive(marker, `${JSON.stringify({ schemaVersion: 1, type: "BONNI_SIGNATURE_STORE" }, null, 2)}\n`, 0o600);
  }
  return { signatureRoot, created };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const result = await initializeSignatureStore(parseArguments(argv, env));
  for (const entry of result.created) {
    console.log(`${entry.target}: ${entry.keyId} (${entry.publicFingerprint})`);
  }
  console.log("Private Schluessel wurden nur im angegebenen SIGNATUR-Speicher angelegt.");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "SIGNATURE_INIT_FAILED");
    process.exitCode = 1;
  });
}
