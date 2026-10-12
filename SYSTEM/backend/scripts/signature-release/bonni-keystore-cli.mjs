#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { appDirectoryFromId } from "../setup/app-registry.mjs";
import {
  DEFAULT_KEY_DEFINITIONS,
  extendBonniKeystoreWithApp,
  initializeBonniKeystore,
  keyForScope,
  publicTrustExport,
  unlockBonniKeystore,
} from "./bonni-keystore.mjs";

const MAX_KEYSTORE_FILE_BYTES = 8 * 1024 * 1024;
const EXCLUSIVE_WRITE_FALLBACK_CODES = new Set([
  "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM",
]);

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function parseArguments(argv) {
  const command = argv[0];
  if (!new Set(["init", "status", "export-public", "add-app"]).has(command)) {
    fail("BONNI_KEYSTORE_COMMAND_INVALID");
  }
  const values = new Map();
  const apps = [];
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--file", "--output", "--app"]).has(flag) || !value || value.startsWith("--")) {
      fail("BONNI_KEYSTORE_ARGUMENT_INVALID", String(flag || ""));
    }
    if (flag === "--app") {
      apps.push(value);
    } else {
      if (values.has(flag)) fail("BONNI_KEYSTORE_ARGUMENT_DUPLICATE", flag);
      values.set(flag, value);
    }
    index += 1;
  }
  if (!values.has("--file")) fail("BONNI_KEYSTORE_FILE_REQUIRED");
  if (new Set(["export-public", "add-app"]).has(command) && !values.has("--output")) {
    fail("BONNI_KEYSTORE_OUTPUT_REQUIRED");
  }
  if (!new Set(["export-public", "add-app"]).has(command) && values.has("--output")) {
    fail("BONNI_KEYSTORE_ARGUMENT_INVALID", "--output");
  }
  if (!new Set(["init", "add-app"]).has(command) && apps.length) {
    fail("BONNI_KEYSTORE_ARGUMENT_INVALID", "--app");
  }
  if (command === "add-app") {
    if (apps.length !== 1) fail("BONNI_KEYSTORE_APP_REQUIRED");
    if (!path.isAbsolute(values.get("--file")) || !path.isAbsolute(values.get("--output"))) {
      fail("BONNI_KEYSTORE_ADD_APP_ABSOLUTE_PATH_REQUIRED");
    }
  }
  const normalizedApps = apps.map((value) => {
    if (!/^[A-Za-z][A-Za-z0-9._-]{1,63}$/u.test(value)) {
      fail("BONNI_KEYSTORE_APP_INVALID", value);
    }
    const id = value.toUpperCase();
    if (command === "add-app" && value !== id) fail("BONNI_KEYSTORE_APP_INVALID", value);
    let directory;
    try {
      directory = appDirectoryFromId(id);
    } catch {
      fail("BONNI_KEYSTORE_APP_INVALID", id);
    }
    return { id, directory };
  });
  const uniqueDirectories = new Set(normalizedApps.map((entry) => entry.directory));
  if (uniqueDirectories.size !== normalizedApps.length) fail("BONNI_KEYSTORE_APP_DUPLICATE");
  const file = path.resolve(values.get("--file"));
  const output = values.has("--output") ? path.resolve(values.get("--output")) : null;
  if (command === "add-app") {
    const left = process.platform === "win32" ? file.toLowerCase() : file;
    const right = process.platform === "win32" ? output.toLowerCase() : output;
    if (left === right) fail("BONNI_KEYSTORE_OUTPUT_MUST_DIFFER");
  }
  return {
    command,
    file,
    output,
    apps: normalizedApps.map((entry) => entry.directory).sort(),
    appId: command === "add-app" ? normalizedApps[0].id : null,
  };
}

async function readPasswordFromStdin() {
  if (process.stdin.isTTY) fail("BONNI_KEYSTORE_PASSWORD_REQUIRES_STDIN");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 4096) fail("BONNI_KEYSTORE_PASSWORD_INPUT_TOO_LARGE");
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString("utf8");
  const password = input.replace(/\r?\n$/u, "");
  if (password.includes("\n") || password.includes("\r")) fail("BONNI_KEYSTORE_PASSWORD_INPUT_INVALID");
  return password;
}

async function writeExclusiveSynced(file, contents) {
  const parent = path.dirname(file);
  const state = await fs.lstat(parent).catch(() => null);
  if (!state || !state.isDirectory() || state.isSymbolicLink()) fail("BONNI_KEYSTORE_OUTPUT_PARENT_UNSAFE");
  let handle;
  try {
    handle = await fs.open(file, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") fail("BONNI_KEYSTORE_OUTPUT_EXISTS", file);
    throw error;
  } finally {
    await handle?.close();
  }
}

function sameOpenFile(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function sameResolvedPath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function assertCanonicalParent(file, code) {
  const parent = path.dirname(file);
  const state = await fs.lstat(parent).catch(() => null);
  if (!state?.isDirectory() || state.isSymbolicLink()) fail(code, parent);
  const realParent = await fs.realpath(parent).catch(() => null);
  if (!realParent || !sameResolvedPath(realParent, parent)) fail(code, parent);
  return parent;
}

async function readStableKeystoreFile(file, unsafeCode = "BONNI_KEYSTORE_FILE_UNSAFE") {
  await assertCanonicalParent(file, unsafeCode);
  const lexical = await fs.lstat(file, { bigint: true }).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (
    !lexical
    || !lexical.isFile()
    || lexical.isSymbolicLink()
    || lexical.nlink !== 1n
    || lexical.size < 1n
    || lexical.size > BigInt(MAX_KEYSTORE_FILE_BYTES)
  ) fail(unsafeCode, file);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
  } catch {
    fail(unsafeCode, file);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.size < 1n
      || before.size > BigInt(MAX_KEYSTORE_FILE_BYTES)
      || !sameOpenFile(lexical, before)
    ) fail(unsafeCode, file);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameOpenFile(before, after) || BigInt(bytes.length) !== before.size) {
      fail("BONNI_KEYSTORE_FILE_CHANGED", file);
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!new Set(["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertPlainOutputParent(file) {
  return assertCanonicalParent(file, "BONNI_KEYSTORE_OUTPUT_PARENT_UNSAFE");
}

export async function publishExtendedKeystore({
  file,
  contents,
  password,
  expected,
  linkFile = fs.link,
}) {
  const parent = await assertPlainOutputParent(file);
  const existing = await fs.lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) fail("BONNI_KEYSTORE_OUTPUT_EXISTS", file);
  const temporary = path.join(
    parent,
    `.bonni-keystore-add-app-${process.pid}-${randomBytes(16).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    const stagedBytes = await readStableKeystoreFile(
      temporary,
      "BONNI_KEYSTORE_OUTPUT_WRITEBACK_INVALID",
    );
    if (!stagedBytes.equals(Buffer.from(contents, "utf8"))) {
      fail("BONNI_KEYSTORE_OUTPUT_WRITEBACK_INVALID", temporary);
    }
    const staged = await unlockBonniKeystore(stagedBytes, password);
    const stagedApp = keyForScope(staged, expected.app.scope);
    if (
      staged.storeId !== expected.storeId
      || staged.createdAt !== expected.createdAt
      || staged.keys.length !== expected.keyCount
      || stagedApp.keyId !== expected.app.keyId
      || stagedApp.publicKeyPem !== expected.app.publicKeyPem
      || stagedApp.fingerprintSha256 !== expected.app.fingerprintSha256
    ) fail("BONNI_KEYSTORE_OUTPUT_WRITEBACK_INVALID", temporary);

    await assertPlainOutputParent(file);
    let hardLinkPublished = false;
    try {
      await linkFile(temporary, file);
      hardLinkPublished = true;
    } catch (error) {
      if (error?.code === "EEXIST") fail("BONNI_KEYSTORE_OUTPUT_EXISTS", file);
      if (!EXCLUSIVE_WRITE_FALLBACK_CODES.has(error?.code)) {
        fail("BONNI_KEYSTORE_OUTPUT_PUBLISH_FAILED", String(error?.code || "link"));
      }
      await assertPlainOutputParent(file);
      // FAT/exFAT and some network filesystems cannot publish through a hard
      // link. The fallback remains non-overwriting (`wx`) and is fsynced and
      // fully read back before success. A crash may leave a new partial file;
      // it is never reported as verified and is deliberately not unlinked by
      // path, because another process could have replaced that path.
      let outputHandle;
      try {
        outputHandle = await fs.open(file, "wx", 0o600);
        await outputHandle.writeFile(contents, "utf8");
        await outputHandle.sync();
      } catch (fallbackError) {
        if (fallbackError?.code === "EEXIST") fail("BONNI_KEYSTORE_OUTPUT_EXISTS", file);
        fail(
          "BONNI_KEYSTORE_OUTPUT_PUBLISH_FAILED",
          String(fallbackError?.code || "exclusive-write"),
        );
      } finally {
        await outputHandle?.close().catch(() => undefined);
      }
    }
    if (hardLinkPublished) await fs.unlink(temporary);
    await syncDirectory(parent);
    const finalBytes = await readStableKeystoreFile(
      file,
      "BONNI_KEYSTORE_OUTPUT_WRITEBACK_INVALID",
    );
    if (!finalBytes.equals(Buffer.from(contents, "utf8"))) {
      fail("BONNI_KEYSTORE_OUTPUT_WRITEBACK_INVALID", file);
    }
    return finalBytes.length;
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function runKeystoreCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const password = await readPasswordFromStdin();
  if (options.command === "init") {
    const keyDefinitions = [...DEFAULT_KEY_DEFINITIONS];
    const knownScopes = new Set(keyDefinitions.map((entry) => entry.scope));
    for (const app of options.apps) {
      const definition = { keyId: `bonni-app-${app}-01`, scope: `app:${app}` };
      if (knownScopes.has(definition.scope)) continue;
      knownScopes.add(definition.scope);
      keyDefinitions.push(definition);
    }
    const initialized = await initializeBonniKeystore({
      file: options.file,
      password,
      keyDefinitions,
    });
    return { command: options.command, file: initialized.file, keyCount: keyDefinitions.length };
  }

  const sourceBytes = await readStableKeystoreFile(options.file);
  if (options.command === "add-app") {
    const extended = await extendBonniKeystoreWithApp({
      value: sourceBytes,
      password,
      appId: options.appId,
    });
    const sourceReadback = await readStableKeystoreFile(options.file);
    if (!sourceReadback.equals(sourceBytes)) fail("BONNI_KEYSTORE_SOURCE_CHANGED", options.file);
    const bytes = await publishExtendedKeystore({
      file: options.output,
      contents: extended.contents,
      password,
      expected: extended,
    });
    const finalSourceReadback = await readStableKeystoreFile(options.file);
    if (!finalSourceReadback.equals(sourceBytes)) {
      fail("BONNI_KEYSTORE_SOURCE_CHANGED", options.file);
    }
    return {
      command: options.command,
      sourceFile: options.file,
      file: options.output,
      bytes,
      storeId: extended.storeId,
      createdAt: extended.createdAt,
      keyCount: extended.keyCount,
      app: extended.app,
    };
  }

  const unlocked = await unlockBonniKeystore(sourceBytes, password);
  if (options.command === "status") {
    return {
      command: options.command,
      file: options.file,
      storeId: unlocked.storeId,
      createdAt: unlocked.createdAt,
      keys: unlocked.keys.map(({ keyId, scope, fingerprintSha256 }) => ({ keyId, scope, fingerprintSha256 })),
    };
  }

  const publicTrust = publicTrustExport(unlocked);
  const publicTrustBytes = `${JSON.stringify(publicTrust, null, 2)}\n`;
  await writeExclusiveSynced(options.output, publicTrustBytes);
  return {
    command: options.command,
    file: options.output,
    keyCount: publicTrust.keys.length,
    sha256: createHash("sha256").update(publicTrustBytes).digest("hex"),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runKeystoreCli().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || String(error?.message || "BONNI_KEYSTORE_FAILED").split(":", 1)[0],
    })}\n`);
    process.exitCode = 23;
  });
}
