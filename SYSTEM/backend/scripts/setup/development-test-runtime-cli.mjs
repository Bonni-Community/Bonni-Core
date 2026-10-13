#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  cleanupDevelopmentTestRuntime,
  getDevelopmentTestRuntimeStatus,
  prepareDevelopmentTestRuntime,
  runDevelopmentTestRuntimeWorker,
  startDevelopmentTestRuntime,
  stopDevelopmentTestRuntime,
} from "./development-test-runtime.mjs";
import { loadStableBackendEnvironment } from "../runtime/start-backend.mjs";

const PUBLIC_ACTIONS = new Set(["prepare", "start", "status", "stop", "cleanup"]);
const ACTIONS = new Set([...PUBLIC_ACTIONS, "__worker"]);
const VALUE_OPTIONS = new Set([
  "--product-root",
  "--candidate-id",
  "--package-sha256",
  "--key-file",
  "--source-run-system-root",
  "--source-storage-root",
  "--server-port",
  "--local-auth-port",
  "--module-manager-port",
  "--start-timeout-ms",
  "--stop-timeout-ms",
]);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export class DevelopmentTestRuntimeCliError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}:${detail}` : code);
    this.name = "DevelopmentTestRuntimeCliError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = "") {
  throw new DevelopmentTestRuntimeCliError(code, detail);
}

function parsePositiveInteger(value, label, { minimum = 1, maximum = 600_000 } = {}) {
  if (value === undefined) return undefined;
  if (!/^[0-9]{1,7}$/u.test(value)) fail("DEVELOPMENT_TEST_RUNTIME_CLI_NUMBER_INVALID", label);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail("DEVELOPMENT_TEST_RUNTIME_CLI_NUMBER_INVALID", label);
  }
  return parsed;
}

function parseArguments(argv) {
  const [action, ...rest] = argv;
  if (!ACTIONS.has(action)) fail("DEVELOPMENT_TEST_RUNTIME_CLI_ACTION_INVALID", String(action || ""));
  const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (!VALUE_OPTIONS.has(option)) fail("DEVELOPMENT_TEST_RUNTIME_CLI_OPTION_UNKNOWN", option);
    const value = rest[++index];
    if (!value || value.startsWith("--")) {
      fail("DEVELOPMENT_TEST_RUNTIME_CLI_OPTION_VALUE_MISSING", option);
    }
    if (values.has(option)) fail("DEVELOPMENT_TEST_RUNTIME_CLI_OPTION_DUPLICATE", option);
    values.set(option, value);
  }
  for (const required of ["--product-root", "--candidate-id", "--package-sha256"]) {
    if (!values.has(required)) fail("DEVELOPMENT_TEST_RUNTIME_CLI_OPTION_REQUIRED", required);
  }
  const hash = values.get("--package-sha256").toLowerCase();
  if (!HASH_PATTERN.test(hash)) fail("DEVELOPMENT_TEST_RUNTIME_CLI_HASH_INVALID");
  const ports = {};
  for (const [option, field] of [
    ["--server-port", "server"],
    ["--local-auth-port", "localAuth"],
    ["--module-manager-port", "moduleManager"],
  ]) {
    const parsed = parsePositiveInteger(values.get(option), option, { minimum: 1024, maximum: 65535 });
    if (parsed !== undefined) ports[field] = parsed;
  }
  return {
    action,
    productRoot: path.resolve(values.get("--product-root")),
    candidateId: values.get("--candidate-id"),
    packageSha256: hash,
    ...(values.has("--key-file") ? { keyFile: path.resolve(values.get("--key-file")) } : {}),
    ...(values.has("--source-run-system-root")
      ? { sourceRunSystemRoot: path.resolve(values.get("--source-run-system-root")) }
      : {}),
    ...(values.has("--source-storage-root")
      ? { sourceStorageRoot: path.resolve(values.get("--source-storage-root")) }
      : {}),
    ...(Object.keys(ports).length ? { ports } : {}),
    ...(values.has("--start-timeout-ms")
      ? { startTimeoutMs: parsePositiveInteger(values.get("--start-timeout-ms"), "--start-timeout-ms") }
      : {}),
    ...(values.has("--stop-timeout-ms")
      ? { stopTimeoutMs: parsePositiveInteger(values.get("--stop-timeout-ms"), "--stop-timeout-ms") }
      : {}),
  };
}

export async function runDevelopmentTestRuntimeCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  switch (options.action) {
    case "prepare":
      return prepareDevelopmentTestRuntime(options, dependencies);
    case "start": {
      const environment = await loadStableBackendEnvironment({
        backendRoot: path.join(options.productRoot, "SYSTEM", "backend"),
        environment: process.env,
      });
      return startDevelopmentTestRuntime({ ...options, environment }, dependencies);
    }
    case "status":
      return getDevelopmentTestRuntimeStatus(options, dependencies);
    case "stop":
      return stopDevelopmentTestRuntime(options, dependencies);
    case "cleanup": {
      const environment = await loadStableBackendEnvironment({
        backendRoot: path.join(options.productRoot, "SYSTEM", "backend"),
        environment: process.env,
      });
      return cleanupDevelopmentTestRuntime({ ...options, environment }, dependencies);
    }
    case "__worker":
      return runDevelopmentTestRuntimeWorker({
        ...options,
        sourceDatabaseUrl: process.env.BONNI_DEVELOPMENT_TEST_SOURCE_DATABASE_URL,
        candidateDatabaseUrl: process.env.BONNI_DEVELOPMENT_TEST_DATABASE_URL,
      }, dependencies);
    default:
      fail("DEVELOPMENT_TEST_RUNTIME_CLI_ACTION_INVALID", options.action);
  }
}

async function main() {
  try {
    const result = await runDevelopmentTestRuntimeCli();
    if (process.argv[2] !== "__worker") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = String(error?.code || "DEVELOPMENT_TEST_RUNTIME_CLI_FAILED");
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
