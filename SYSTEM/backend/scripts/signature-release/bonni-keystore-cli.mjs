#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_KEY_DEFINITIONS,
  initializeBonniKeystore,
  publicTrustExport,
  unlockBonniKeystore,
} from "./bonni-keystore.mjs";

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function parseArguments(argv) {
  const command = argv[0];
  if (!new Set(["init", "status", "export-public"]).has(command)) {
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
      if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(value)) fail("BONNI_KEYSTORE_APP_INVALID", value);
      apps.push(value);
    } else {
      if (values.has(flag)) fail("BONNI_KEYSTORE_ARGUMENT_DUPLICATE", flag);
      values.set(flag, value);
    }
    index += 1;
  }
  if (!values.has("--file")) fail("BONNI_KEYSTORE_FILE_REQUIRED");
  if (command === "export-public" && !values.has("--output")) fail("BONNI_KEYSTORE_OUTPUT_REQUIRED");
  if (command !== "export-public" && values.has("--output")) fail("BONNI_KEYSTORE_ARGUMENT_INVALID", "--output");
  if (command !== "init" && apps.length) fail("BONNI_KEYSTORE_ARGUMENT_INVALID", "--app");
  return {
    command,
    file: path.resolve(values.get("--file")),
    output: values.has("--output") ? path.resolve(values.get("--output")) : null,
    apps: [...new Set(apps)].sort(),
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

export async function runKeystoreCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const password = await readPasswordFromStdin();
  if (options.command === "init") {
    const keyDefinitions = [
      ...DEFAULT_KEY_DEFINITIONS,
      ...options.apps.map((app) => ({ keyId: `bonni-app-${app}-01`, scope: `app:${app}` })),
    ];
    const initialized = await initializeBonniKeystore({
      file: options.file,
      password,
      keyDefinitions,
    });
    return { command: options.command, file: initialized.file, keyCount: keyDefinitions.length };
  }

  const unlocked = await unlockBonniKeystore(await fs.readFile(options.file), password);
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
