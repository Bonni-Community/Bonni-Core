#!/usr/bin/env node
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DockerCli,
  UpdateRunner,
  createUpdateRunnerConfig,
  discoverComposeProject,
} from "../../src/system/update-runner/index.mjs";
import { loadTrustedReleaseKeys } from "../../src/system/update-runner/trusted-keys.mjs";
import { bootGateTerminalIsSafe } from "./boot-gate-policy.mjs";

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function requestSecret(env, config) {
  const configured = env.BONNI_UPDATE_REQUEST_SECRET_FILE;
  if (!configured) throw new Error("BONNI_UPDATE_REQUEST_SECRET_FILE ist für lokale Request-Authentifizierung erforderlich.");
  const secretPath = path.resolve(configured);
  for (const forbidden of [config.storageRoot, config.ipcRoot, config.privateRoot, config.updateCenterRoot]) {
    const relative = path.relative(forbidden, secretPath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error("Request-HMAC-Secret darf nicht im gemeinsamen Update-/Storage-Bereich liegen.");
    }
  }
  const stat = await fs.stat(secretPath);
  if (!stat.isFile() || stat.size < 32 || stat.size > 4_096) throw new Error("Request-HMAC-Secretdatei ist ungültig.");
  if ((stat.mode & 0o077) !== 0) throw new Error("Request-HMAC-Secretdatei darf nur für ihren Besitzer lesbar sein.");
  return fs.readFile(secretPath);
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function runtimeEnvironmentFile(env, config) {
  if (!env.BONNI_RUNTIME_ENV_FILE) {
    throw new Error("BONNI_RUNTIME_ENV_FILE ist für sichere Docker-Compose-Aufrufe erforderlich.");
  }
  const configuredPath = path.resolve(env.BONNI_RUNTIME_ENV_FILE);
  const lstat = await fs.lstat(configuredPath);
  if (!lstat.isFile() || lstat.isSymbolicLink() || (lstat.mode & 0o022) !== 0) {
    throw new Error("Bonni-Runtime-Umgebungsdatei ist keine sichere reguläre Datei.");
  }
  const realPath = await fs.realpath(configuredPath);
  for (const forbidden of [config.storageRoot, config.ipcRoot, config.privateRoot, config.updateCenterRoot]) {
    const forbiddenReal = await fs.realpath(forbidden).catch(() => path.resolve(forbidden));
    if (isInside(realPath, forbiddenReal)) {
      throw new Error("Bonni-Runtime-Umgebungsdatei darf nicht im gemeinsamen Storage oder Runner-State liegen.");
    }
  }
  return realPath;
}

async function createRunner(env = process.env) {
  const config = createUpdateRunnerConfig(env);
  if (!existsSync(config.composeFile)) throw new Error(`Feste Compose-Datei fehlt: ${config.composeFile}`);
  const baseEnvironmentFile = await runtimeEnvironmentFile(env, config);

  const docker = new DockerCli({
    binary: env.BONNI_DOCKER_BIN || "docker",
    composeFile: config.composeFile,
    project: config.project || "bonni-discovery",
    baseEnvironmentFile,
    activeEnvironmentFile: config.activeEnvironmentPath,
    cwd: path.dirname(config.composeFile),
    commandTimeoutMs: positiveNumber(env.BONNI_UPDATE_DOCKER_TIMEOUT_MS, 30 * 60_000),
  });
  config.project = await discoverComposeProject({
    docker,
    hostname: env.HOSTNAME,
    configuredProject: config.project,
  });
  docker.project = config.project;
  return new UpdateRunner({
    config,
    docker,
    trustedKeys: await loadTrustedReleaseKeys(env, config.projectRoot),
    requestSecret: await requestSecret(env, config),
  });
}

async function transactionFenceExists(config) {
  try {
    await fs.lstat(config.transactionFencePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { stopping = true; });
}

try {
  const runner = await createRunner();
  const once = process.argv.includes("--once");
  const bootGate = process.argv.includes("--boot-gate");
  const transportGateArguments = process.argv
    .slice(2)
    .filter((value) => value.startsWith("--network-transport-gate="));
  if (transportGateArguments.length > 1) {
    throw new Error("--network-transport-gate darf nur einmal angegeben werden.");
  }
  const transportGate = transportGateArguments[0]?.slice("--network-transport-gate=".length) || null;
  if (transportGate && !["close", "open"].includes(transportGate)) {
    throw new Error("--network-transport-gate akzeptiert nur close oder open.");
  }
  if (transportGate && (once || bootGate)) {
    throw new Error("--network-transport-gate darf nicht mit --once oder --boot-gate kombiniert werden.");
  }
  if (bootGate && !once) throw new Error("--boot-gate erfordert --once.");
  if (bootGate && !runner.config.bootRecovery) {
    throw new Error("--boot-gate erfordert BONNI_UPDATE_BOOT_RECOVERY=true.");
  }
  const pollMs = positiveNumber(process.env.BONNI_UPDATE_RUNNER_POLL_MS, 2_000);
  if (transportGate) {
    await runner.initialize();
    if (transportGate === "close") {
      await runner.closeNetworkTransport("runtime-boot-preflight");
    } else {
      await runner.openNetworkTransport("runtime-boot-confirmed");
    }
  } else if (bootGate) {
    // No producer is running during boot. Drain every authenticated private
    // claim so a second interrupted journal cannot remain hidden behind the
    // first one. Any non-terminal result or remaining fence keeps boot closed.
    while (!stopping) {
      const result = await runner.processNext();
      if (!bootGateTerminalIsSafe(result)) {
        throw new Error(`Boot-Recovery ist nicht sicher abgeschlossen (${result?.result?.status || "busy"}).`);
      }
      if (result.processed === false) break;
    }
    if (stopping) throw new Error("Boot-Recovery wurde vor der Freigabe unterbrochen.");
    if (await transactionFenceExists(runner.config)) {
      throw new Error("Update-Transaktions-Fence ist noch vorhanden; Active und Proxy bleiben gesperrt.");
    }
  } else {
    do {
      await runner.processNext();
      if (!once && !stopping) await new Promise((resolve) => setTimeout(resolve, pollMs));
    } while (!once && !stopping);
  }
} catch (error) {
  console.error(`[bonni-update-runner] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
