#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CertifiedGitHubReleaseError,
  createCertifiedGitHubRelease,
  readCertifiedGitHubReleaseRequest,
} from "./certified-github-release.mjs";

function fail(code, detail = "") {
  throw new CertifiedGitHubReleaseError(code, detail);
}

export function parseCertifiedReleaseArguments(argv) {
  const values = new Map();
  let masterKeyStdin = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--master-key-stdin") {
      if (masterKeyStdin) fail("CERTIFIED_RELEASE_ARGUMENT_DUPLICATE", flag);
      masterKeyStdin = true;
      continue;
    }
    if (!new Set(["--request", "--product-root"]).has(flag)) {
      // Unbekannte Werte werden absichtlich nicht gespiegelt. So landet ein
      // versehentlich als Argument uebergebenes Masterpasswort nie im Fehlerlog.
      fail("CERTIFIED_RELEASE_ARGUMENT_INVALID");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || values.has(flag)) {
      fail("CERTIFIED_RELEASE_ARGUMENT_INVALID", flag);
    }
    values.set(flag, value);
    index += 1;
  }
  if (!masterKeyStdin) fail("CERTIFIED_RELEASE_MASTER_KEY_STDIN_REQUIRED");
  if (!values.has("--request")) fail("CERTIFIED_RELEASE_REQUEST_FILE_REQUIRED");
  if (!values.has("--product-root")) fail("CERTIFIED_RELEASE_PRODUCT_ROOT_REQUIRED");
  if (!path.isAbsolute(values.get("--request"))) fail("CERTIFIED_RELEASE_REQUEST_FILE_ABSOLUTE_REQUIRED");
  if (!path.isAbsolute(values.get("--product-root"))) fail("CERTIFIED_RELEASE_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  return Object.freeze({
    requestFile: path.resolve(values.get("--request")),
    productRoot: path.resolve(values.get("--product-root")),
  });
}

export async function readMasterKeyFromStdin(input = process.stdin) {
  if (input === process.stdin && process.stdin.isTTY) {
    fail("CERTIFIED_RELEASE_MASTER_KEY_STDIN_REQUIRED");
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of input) {
    totalBytes += chunk.length;
    if (totalBytes > 4096) fail("CERTIFIED_RELEASE_MASTER_KEY_INPUT_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  try {
    const password = bytes.toString("utf8").replace(/\r?\n$/u, "");
    if (!password || password.includes("\r") || password.includes("\n")) {
      fail("CERTIFIED_RELEASE_MASTER_KEY_INPUT_INVALID");
    }
    return password;
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function assertRequestLocation(requestFile, productRoot) {
  const allowedRoot = path.join(productRoot, "RUN_INSTALL", "github-release-requests");
  const relative = path.relative(allowedRoot, requestFile);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) fail("CERTIFIED_RELEASE_REQUEST_LOCATION_FORBIDDEN");
  for (const directory of [
    productRoot,
    path.join(productRoot, "RUN_INSTALL"),
    allowedRoot,
  ]) {
    const directoryState = await fs.lstat(directory).catch(() => null);
    if (!directoryState || !directoryState.isDirectory() || directoryState.isSymbolicLink()) {
      fail("CERTIFIED_RELEASE_REQUEST_LOCATION_FORBIDDEN");
    }
  }
  const state = await fs.lstat(requestFile).catch(() => null);
  if (!state || !state.isFile() || state.isSymbolicLink() || state.nlink > 1) {
    fail("CERTIFIED_RELEASE_REQUEST_FILE_INVALID");
  }
}

export async function runCertifiedReleaseCli(
  argv = process.argv.slice(2),
  input = process.stdin,
  output = process.stdout,
) {
  const options = parseCertifiedReleaseArguments(argv);
  await assertRequestLocation(options.requestFile, options.productRoot);
  const request = await readCertifiedGitHubReleaseRequest(options.requestFile, {
    productRoot: options.productRoot,
  });
  let masterPassword = await readMasterKeyFromStdin(input);
  try {
    const result = await createCertifiedGitHubRelease({
      request,
      masterPassword,
      onProgress(message) {
        output.write(`[bonni-release] ${message}\n`);
      },
    });
    output.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return result;
  } finally {
    masterPassword = null;
  }
}

if (
  process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  runCertifiedReleaseCli().catch((error) => {
    const code = typeof error?.code === "string" ? error.code : "CERTIFIED_RELEASE_FAILED";
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code,
      message: error?.message || code,
    })}\n`);
    process.exitCode = 1;
  });
}
