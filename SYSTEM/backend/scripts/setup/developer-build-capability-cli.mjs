#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DeveloperBuildCapabilityError,
  assertDeveloperBuildAuthorized,
  getDeveloperBuildCapabilityStatus,
  importDeveloperBuildCapability,
} from "./developer-build-capability.mjs";

const COMMANDS = new Set(["import-file", "status", "verify-build"]);
const VALUE_FLAGS = new Set([
  "--component",
  "--developer-profile-sha256",
  "--expected-sha256",
  "--product-root",
  "--source",
  "--vault-id",
]);

function fail(code) {
  throw new DeveloperBuildCapabilityError(code);
}

export function parseDeveloperBuildCapabilityArguments(argv) {
  const command = argv[0];
  if (!COMMANDS.has(command)) fail("DEVELOPER_BUILD_CAPABILITY_ARGUMENT_INVALID");
  const values = new Map();
  const components = [];
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!VALUE_FLAGS.has(flag) || !value || value.startsWith("--")) {
      fail("DEVELOPER_BUILD_CAPABILITY_ARGUMENT_INVALID");
    }
    if (flag === "--component") {
      components.push(value);
    } else {
      if (values.has(flag)) fail("DEVELOPER_BUILD_CAPABILITY_ARGUMENT_INVALID");
      values.set(flag, value);
    }
    index += 1;
  }
  const productRoot = values.get("--product-root") || "";
  if (!path.isAbsolute(productRoot)) {
    fail("DEVELOPER_BUILD_CAPABILITY_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  }
  const vaultId = values.get("--vault-id") || "";
  if (!vaultId) fail("DEVELOPER_BUILD_CAPABILITY_VAULT_ID_INVALID");
  const developerProfileSha256 = values.get("--developer-profile-sha256") || "";
  if (!/^[a-f0-9]{64}$/u.test(developerProfileSha256)) {
    fail("DEVELOPER_BUILD_CAPABILITY_DEVELOPER_PROFILE_SHA256_INVALID");
  }
  if (command === "import-file") {
    const source = values.get("--source") || "";
    if (!path.isAbsolute(source)) fail("DEVELOPER_BUILD_CAPABILITY_SOURCE_ABSOLUTE_REQUIRED");
    if (!values.has("--expected-sha256") || components.length > 0) {
      fail("DEVELOPER_BUILD_CAPABILITY_ARGUMENT_INVALID");
    }
  } else if (
    values.has("--source")
    || values.has("--expected-sha256")
    || (command === "status" && components.length > 0)
    || (command === "verify-build" && components.length < 1)
  ) {
    fail("DEVELOPER_BUILD_CAPABILITY_ARGUMENT_INVALID");
  }
  return Object.freeze({
    command,
    productRoot: path.resolve(productRoot),
    vaultId,
    developerProfileSha256,
    sourceFile: values.has("--source") ? path.resolve(values.get("--source")) : "",
    expectedSha256: values.get("--expected-sha256") || "",
    components: Object.freeze([...components]),
  });
}

export async function runDeveloperBuildCapabilityCli(argv = process.argv.slice(2)) {
  const options = parseDeveloperBuildCapabilityArguments(argv);
  if (options.command === "status") {
    return getDeveloperBuildCapabilityStatus({
      productRoot: options.productRoot,
      vaultId: options.vaultId,
      developerProfileSha256: options.developerProfileSha256,
    });
  }
  if (options.command === "import-file") {
    return importDeveloperBuildCapability({
      productRoot: options.productRoot,
      vaultId: options.vaultId,
      developerProfileSha256: options.developerProfileSha256,
      sourceFile: options.sourceFile,
      expectedSha256: options.expectedSha256,
    });
  }
  return assertDeveloperBuildAuthorized({
    productRoot: options.productRoot,
    vaultId: options.vaultId,
    developerProfileSha256: options.developerProfileSha256,
    components: options.components,
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runDeveloperBuildCapabilityCli().then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  }).catch((error) => {
    const code = typeof error?.code === "string"
      && /^DEVELOPER_BUILD_CAPABILITY_[A-Z0-9_]+$/u.test(error.code)
      ? error.code
      : "DEVELOPER_BUILD_CAPABILITY_FAILED";
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 43;
  });
}
