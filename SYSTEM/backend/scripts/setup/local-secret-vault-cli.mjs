import fs from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  LocalSecretVaultError,
  changeLocalSecretVaultPassword,
  enrollCommunityDeveloperVault,
  enrollExistingCommunityDeveloperProfile,
  getLocalSecretVaultStatus,
  importEncryptedLocalSecretVault,
  initializeLocalSecretVault,
  listLocalSecretVaultEntries,
  putLocalSecretVaultEntry,
  recoverLocalSecretVaultStaleLock,
  removeLocalSecretVaultEntry,
  restoreLocalSecretVaultBackup,
  rotateLocalSecretVaultEntry,
  verifyLocalSecretVaultPurpose,
} from "./local-secret-vault.mjs";
import {
  assertDeveloperGitHubRequestAuthorized,
} from "./developer-build-capability.mjs";

const COMMANDS = new Set([
  "change-password",
  "enroll",
  "enroll-profile",
  "github-run",
  "import-encrypted",
  "init",
  "list",
  "put",
  "recover",
  "recover-lock",
  "remove",
  "rotate",
  "status",
  "verify",
]);
const VALUE_FLAGS = new Set(["--entry-id", "--product-root", "--purpose", "--request", "--source"]);
const MAX_STDIN_BYTES = 16 * 1024;

function fail(code) {
  throw new LocalSecretVaultError(code);
}

export function parseLocalSecretVaultArguments(argv) {
  const command = argv[0];
  if (!COMMANDS.has(command)) fail("LOCAL_SECRET_VAULT_COMMAND_INVALID");
  const values = new Map();
  const purposes = [];
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!VALUE_FLAGS.has(flag) || !value || value.startsWith("--")) {
      fail("LOCAL_SECRET_VAULT_ARGUMENT_INVALID");
    }
    if (flag === "--purpose") {
      purposes.push(value);
    } else {
      if (values.has(flag)) fail("LOCAL_SECRET_VAULT_ARGUMENT_DUPLICATE");
      values.set(flag, value);
    }
    index += 1;
  }
  if (!values.has("--product-root") || !path.isAbsolute(values.get("--product-root"))) {
    fail("LOCAL_SECRET_VAULT_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  }
  const needsEntry = new Set(["github-run", "put", "remove", "rotate"]).has(command);
  const needsRequest = command === "github-run";
  const needsSource = command === "import-encrypted";
  const acceptsPurposes = command === "put";
  if (needsEntry !== values.has("--entry-id")) fail("LOCAL_SECRET_VAULT_ENTRY_ARGUMENT_INVALID");
  if (needsRequest !== values.has("--request")) fail("LOCAL_SECRET_VAULT_REQUEST_ARGUMENT_INVALID");
  if (needsRequest && !path.isAbsolute(values.get("--request"))) {
    fail("LOCAL_SECRET_VAULT_REQUEST_ABSOLUTE_REQUIRED");
  }
  if (needsSource !== values.has("--source")) fail("LOCAL_SECRET_VAULT_IMPORT_ARGUMENT_INVALID");
  if (needsSource && !path.isAbsolute(values.get("--source"))) {
    fail("LOCAL_SECRET_VAULT_IMPORT_SOURCE_ABSOLUTE_REQUIRED");
  }
  if (acceptsPurposes) {
    if (purposes.length < 1) fail("LOCAL_SECRET_VAULT_PURPOSE_INVALID");
  } else if (command === "verify") {
    if (purposes.length !== 1) fail("LOCAL_SECRET_VAULT_PURPOSE_INVALID");
  } else if (purposes.length) {
    fail("LOCAL_SECRET_VAULT_ARGUMENT_INVALID");
  }
  return Object.freeze({
    command,
    productRoot: path.resolve(values.get("--product-root")),
    entryId: values.get("--entry-id") || "",
    request: values.has("--request") ? path.resolve(values.get("--request")) : "",
    source: values.has("--source") ? path.resolve(values.get("--source")) : "",
    purposes: Object.freeze([...purposes]),
  });
}

async function readInputLines(input, expectedCount) {
  if (input === process.stdin && process.stdin.isTTY) fail("LOCAL_SECRET_VAULT_STDIN_REQUIRED");
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_STDIN_BYTES) {
        bytes.fill(0);
        fail("LOCAL_SECRET_VAULT_STDIN_TOO_LARGE");
      }
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    const lines = [];
    try {
      let end = bytes.length;
      if (end > 0 && bytes[end - 1] === 10) end -= 1;
      if (end > 0 && bytes[end - 1] === 13) end -= 1;
      let start = 0;
      for (let index = 0; index < end; index += 1) {
        if (bytes[index] === 10) {
          let lineEnd = index;
          if (lineEnd > start && bytes[lineEnd - 1] === 13) lineEnd -= 1;
          lines.push(Buffer.from(bytes.subarray(start, lineEnd)));
          start = index + 1;
        }
      }
      lines.push(Buffer.from(bytes.subarray(start, end)));
      if (lines.length !== expectedCount || lines.some((line) => line.includes(0) || line.includes(10) || line.includes(13))) {
        for (const line of lines) line.fill(0);
        fail("LOCAL_SECRET_VAULT_STDIN_INVALID");
      }
      return lines;
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function assertSafeGitHubRequest(requestFile, productRoot) {
  const allowedRoot = path.join(productRoot, "RUN_INSTALL", "github-release-requests");
  const relative = path.relative(allowedRoot, requestFile);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) fail("LOCAL_SECRET_VAULT_GITHUB_REQUEST_FORBIDDEN");
  for (const directory of [productRoot, path.join(productRoot, "RUN_INSTALL"), allowedRoot]) {
    const state = await fs.lstat(directory).catch(() => null);
    if (!state || !state.isDirectory() || state.isSymbolicLink()) {
      fail("LOCAL_SECRET_VAULT_GITHUB_REQUEST_FORBIDDEN");
    }
  }
  const state = await fs.lstat(requestFile).catch(() => null);
  if (!state || !state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size < 2 || state.size > 1024 * 1024) {
    fail("LOCAL_SECRET_VAULT_GITHUB_REQUEST_INVALID");
  }
  const requestBytes = await fs.readFile(requestFile);
  try {
    const text = requestBytes.toString("utf8");
    const request = JSON.parse(text);
    if (/"(?:master.?key|password|passphrase|secret)"\s*:/iu.test(text)
      || request?.schema !== "bonni.github-release-request/v1") {
      fail("LOCAL_SECRET_VAULT_GITHUB_REQUEST_INVALID");
    }
    return request;
  } catch (error) {
    if (error instanceof LocalSecretVaultError) throw error;
    fail("LOCAL_SECRET_VAULT_GITHUB_REQUEST_INVALID");
  } finally {
    requestBytes.fill(0);
  }
}

async function runGitHubRelease(options, password) {
  const request = await assertSafeGitHubRequest(options.request, options.productRoot);
  const vaultStatus = await getLocalSecretVaultStatus({ productRoot: options.productRoot });
  if (!vaultStatus.configured || typeof vaultStatus.vaultId !== "string") {
    fail("LOCAL_SECRET_VAULT_NOT_CONFIGURED");
  }
  // This lightweight preflight fails before loading the signer or decrypting
  // the vault. The authoritative gate repeats the check and binds the exact
  // developer profile inside certified-github-release.mjs.
  await assertDeveloperGitHubRequestAuthorized({
    productRoot: options.productRoot,
    vaultId: vaultStatus.vaultId,
    request,
  });
  const { createCertifiedGitHubRelease } = await import(
    "../signature-release/certified-github-release.mjs"
  );
  const result = await createCertifiedGitHubRelease({
    rawRequest: request,
    productRoot: options.productRoot,
    vaultEntryId: options.entryId,
    vaultPassword: password,
    onProgress(message) {
      process.stderr.write(`[bonni-release] ${message}\n`);
    },
  });
  return Object.freeze({ released: true, ...result });
}

export async function runLocalSecretVaultCli(
  argv = process.argv.slice(2),
  input = process.stdin,
  dependencies = Object.freeze({}),
) {
  const options = parseLocalSecretVaultArguments(argv);
  if (options.command === "status") {
    return getLocalSecretVaultStatus({ productRoot: options.productRoot });
  }
  const expectedLines = options.command === "change-password" || options.command === "enroll"
    ? 3
    : (options.command === "enroll-profile" || options.command === "init" || options.command === "put" || options.command === "rotate" ? 2 : 1);
  const lines = await readInputLines(input, expectedLines);
  try {
    const password = lines[0];
    switch (options.command) {
      case "enroll":
        if (lines[1].length !== lines[2].length || !timingSafeEqual(lines[1], lines[2])) {
          fail("LOCAL_SECRET_VAULT_PASSWORD_CONFIRMATION_MISMATCH");
        }
        return await enrollCommunityDeveloperVault({
          productRoot: options.productRoot,
          enrollmentCode: lines[0],
          password: lines[1],
          enrollmentVerifier: dependencies.enrollmentVerifier,
        });
      case "enroll-profile":
        return await enrollExistingCommunityDeveloperProfile({
          productRoot: options.productRoot,
          enrollmentCode: lines[0],
          password: lines[1],
          enrollmentVerifier: dependencies.enrollmentVerifier,
        });
      case "init":
        if (lines[0].length !== lines[1].length || !cryptoTimingSafeEqual(lines[0], lines[1])) {
          fail("LOCAL_SECRET_VAULT_PASSWORD_CONFIRMATION_MISMATCH");
        }
        return await initializeLocalSecretVault({ productRoot: options.productRoot, password });
      case "list":
        return await listLocalSecretVaultEntries({ productRoot: options.productRoot, password });
      case "import-encrypted":
        return await importEncryptedLocalSecretVault({
          productRoot: options.productRoot,
          password,
          sourceFile: options.source,
        });
      case "put":
        return await putLocalSecretVaultEntry({
          productRoot: options.productRoot,
          password,
          entryId: options.entryId,
          purposes: options.purposes,
          secret: lines[1],
        });
      case "rotate":
        return await rotateLocalSecretVaultEntry({
          productRoot: options.productRoot,
          password,
          entryId: options.entryId,
          secret: lines[1],
        });
      case "remove":
        return await removeLocalSecretVaultEntry({
          productRoot: options.productRoot,
          password,
          entryId: options.entryId,
        });
      case "change-password":
        if (lines[1].length !== lines[2].length || !timingSafeEqual(lines[1], lines[2])) {
          fail("LOCAL_SECRET_VAULT_PASSWORD_CONFIRMATION_MISMATCH");
        }
        return await changeLocalSecretVaultPassword({
          productRoot: options.productRoot,
          password,
          newPassword: lines[1],
        });
      case "verify":
        return await verifyLocalSecretVaultPurpose({
          productRoot: options.productRoot,
          password,
          purpose: options.purposes[0],
        });
      case "recover":
        return await restoreLocalSecretVaultBackup({ productRoot: options.productRoot, password });
      case "recover-lock":
        return await recoverLocalSecretVaultStaleLock({ productRoot: options.productRoot, password });
      case "github-run":
        return await runGitHubRelease(options, password);
      default:
        fail("LOCAL_SECRET_VAULT_COMMAND_INVALID");
    }
  } finally {
    for (const line of lines) line.fill(0);
  }
}

function cryptoTimingSafeEqual(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runLocalSecretVaultCli().then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  }).catch((error) => {
    const code = typeof error?.code === "string"
      && /^(?:LOCAL_SECRET_VAULT|DEVELOPER_BUILD_CAPABILITY)_[A-Z0-9_]+$/u.test(error.code)
      ? error.code
      : "LOCAL_SECRET_VAULT_FAILED";
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 41;
  });
}
