import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertContainerRuntimeActivationInactive,
  reconcileStaleLocalHostBackendRuntime,
  reconcileStaleUnboundLocalHostBackendRuntimeAfterRestart,
} from "./runtime-mode-exclusion.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDirectory, "../..");
const productRoot = path.resolve(backendRoot, "../..");
const RUNTIME_PORT_KEYS = new Set([
  "PORT",
  "LOCAL_AUTH_PORT",
  "MODULE_MANAGER_PORT",
  "BONNI_INSTALLATION_MONITOR_PORT",
  "BONNI_LOCAL_RUN_PUBLIC_PORT",
  "BONNI_ACTIVE_INTERNAL_PORT",
  "BONNI_ACTIVE_LOCAL_AUTH_PORT",
  "BONNI_CANDIDATE_INTERNAL_PORT",
  "BONNI_CANDIDATE_LOCAL_AUTH_PORT",
  "BONNI_PREVIOUS_INTERNAL_PORT",
  "BONNI_PREVIOUS_LOCAL_AUTH_PORT",
]);
const MAXIMUM_ENV_BYTES = 128 * 1024;
const execFileAsync = promisify(execFile);
const WINDOWS_BOOT_EVIDENCE_SCHEMA = "bonni.windows-boot-evidence/v1";
const WINDOWS_BOOT_EVIDENCE_MAX_SKEW_MS = 2 * 60 * 1_000;
const TRUSTED_WINDOWS_ROOT = "C:\\Windows";
const WINDOWS_KERNEL_GENERAL_PROVIDER_ID = "a68ca8b7-004f-d7b6-a698-07e2de0f1f5d";
const WINDOWS_KERNEL_BOOT_PROVIDER_ID = "15ca44ff-4d7a-4baa-bba5-0998955e531e";
const WINDOWS_BOOT_EVENT_CLUSTER_MS = 15 * 1_000;
const WINDOWS_BOOT_EVIDENCE_BLOCK_CODES = new Set([
  "LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_UNAVAILABLE",
  "LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_INVALID",
  "LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_MISMATCH",
  "LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_NOT_NEWER",
  "LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_ANCHOR_MISSING",
  "LOCAL_HOST_BACKEND_RESTART_RECOVERY_INVALID",
  "LOCAL_HOST_BACKEND_RESTART_RECOVERY_RECEIPT_MISMATCH",
]);
const WINDOWS_BOOT_EVIDENCE_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  "$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-General'; Id = 12 } -MaxEvents 16 -ErrorAction Stop)",
  "$event = $events[0]",
  "$bootEvent = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Boot'; Id = 27 } -MaxEvents 1 -ErrorAction Stop",
  "if ($null -eq $event -or $null -eq $event.RecordId -or $null -eq $event.TimeCreated -or $null -eq $event.ProviderId -or [string]::IsNullOrWhiteSpace([string]$event.MachineName)) { throw 'Windows boot event unavailable' }",
  "if ($null -eq $bootEvent -or $null -eq $bootEvent.RecordId -or $null -eq $bootEvent.TimeCreated -or $null -eq $bootEvent.ProviderId -or [string]::IsNullOrWhiteSpace([string]$bootEvent.MachineName)) { throw 'Windows boot type event unavailable' }",
  "[xml]$bootXml = $bootEvent.ToXml()",
  "$namespace = New-Object System.Xml.XmlNamespaceManager($bootXml.NameTable)",
  "$namespace.AddNamespace('e', 'http://schemas.microsoft.com/win/2004/08/events/event')",
  "$bootTypeNodes = $bootXml.SelectNodes('/e:Event/e:EventData/e:Data[@Name=\"BootType\"]', $namespace)",
  "if ($null -eq $bootTypeNodes -or $bootTypeNodes.Count -ne 1) { throw 'Windows boot type unavailable' }",
  "$bootType = ([string]$bootTypeNodes[0].InnerText).Trim()",
  "$culture = [Globalization.CultureInfo]::InvariantCulture",
  "$format = \"yyyy-MM-dd'T'HH:mm:ss.fff'Z'\"",
  "$recent = @($events | ForEach-Object {",
  "  if ($null -eq $_.RecordId -or $null -eq $_.TimeCreated -or $null -eq $_.ProviderId -or [string]::IsNullOrWhiteSpace([string]$_.MachineName)) { throw 'Windows boot event incomplete' }",
  "  [ordered]@{ recordId = [string]$_.RecordId; timeCreated = $_.TimeCreated.ToUniversalTime().ToString($format, $culture); providerId = $_.ProviderId.ToString('D').ToLowerInvariant(); machineName = [string]$_.MachineName }",
  "})",
  "$payload = [ordered]@{",
  `  schemaVersion = '${WINDOWS_BOOT_EVIDENCE_SCHEMA}'`,
  "  providerName = [string]$event.ProviderName",
  "  eventId = [string]$event.Id",
  "  logName = [string]$event.LogName",
  "  recordId = [string]$event.RecordId",
  "  timeCreated = $event.TimeCreated.ToUniversalTime().ToString($format, $culture)",
  "  providerId = $event.ProviderId.ToString('D').ToLowerInvariant()",
  "  machineName = [string]$event.MachineName",
  "  recentEvents = $recent",
  "  bootProviderName = [string]$bootEvent.ProviderName",
  "  bootEventId = [string]$bootEvent.Id",
  "  bootLogName = [string]$bootEvent.LogName",
  "  bootType = $bootType",
  "  bootEvent = [ordered]@{ recordId = [string]$bootEvent.RecordId; timeCreated = $bootEvent.TimeCreated.ToUniversalTime().ToString($format, $culture); providerId = $bootEvent.ProviderId.ToString('D').ToLowerInvariant(); machineName = [string]$bootEvent.MachineName }",
  "}",
  "$payload | ConvertTo-Json -Depth 4 -Compress",
].join("\n");

export async function loadHostRuntimeEnvironment({
  backendRoot: selectedBackendRoot = backendRoot,
  environment = process.env,
} = {}) {
  const merged = { ...environment };
  const envFile = path.join(path.resolve(selectedBackendRoot), ".env");
  const handle = await fs.open(envFile, "r").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return merged;
  let source;
  try {
    const [opened, named] = await Promise.all([handle.stat(), fs.lstat(envFile)]);
    if (
      !opened.isFile()
      || named.isSymbolicLink()
      || opened.dev !== named.dev
      || opened.ino !== named.ino
      || opened.nlink !== 1
      || opened.size > MAXIMUM_ENV_BYTES
    ) throw new Error("LOCAL_HOST_BACKEND_ENV_UNSAFE");
    source = (await handle.readFile("utf8")).replace(/^\uFEFF/u, "");
  } finally {
    await handle.close().catch(() => undefined);
  }

  const seen = new Set();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!assignment) {
      if ([...RUNTIME_PORT_KEYS].some((key) => new RegExp(`^(?:export\\s+)?${key}\\b`, "u").test(line))) {
        throw new Error("LOCAL_HOST_BACKEND_ENV_PORT_INVALID");
      }
      continue;
    }
    const [, key] = assignment;
    if (!RUNTIME_PORT_KEYS.has(key)) continue;
    if (seen.has(key)) throw new Error(`LOCAL_HOST_BACKEND_ENV_PORT_DUPLICATE:${key}`);
    seen.add(key);
    let value = assignment[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const port = Number(value);
    if (!/^[0-9]{1,5}$/u.test(value) || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`LOCAL_HOST_BACKEND_ENV_PORT_INVALID:${key}`);
    }
    if (merged[key] === undefined) merged[key] = String(port);
  }
  return merged;
}

async function isHostProductTree() {
  const expected = path.join(productRoot, "SYSTEM", "backend");
  const state = await fs.lstat(expected).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return false;
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error("LOCAL_HOST_BACKEND_PRODUCT_TREE_INVALID");
  }
  return await fs.realpath(expected) === await fs.realpath(backendRoot);
}

export async function assertNoWindowsStartRepairTransaction({
  selectedProductRoot = productRoot,
} = {}) {
  const backupRoot = path.join(path.resolve(selectedProductRoot), "BACKUP");
  const transactionRoot = path.join(backupRoot, ".bonni-windows-start-repair");
  const activeJournal = path.join(transactionRoot, "active.json");
  for (const directory of [backupRoot, transactionRoot]) {
    const state = await fs.lstat(directory).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!state) return;
    if (!state.isDirectory() || state.isSymbolicLink()) {
      const error = new Error("WINDOWS_START_REPAIR_TRANSACTION_ROOT_UNSAFE");
      error.code = "WINDOWS_START_REPAIR_TRANSACTION_ROOT_UNSAFE";
      throw error;
    }
  }
  const active = await fs.lstat(activeJournal).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (active) {
    const error = new Error("WINDOWS_START_REPAIR_TRANSACTION_ACTIVE");
    error.code = "WINDOWS_START_REPAIR_TRANSACTION_ACTIVE";
    throw error;
  }
}

export async function readWindowsBootEvidence({
  platform = process.platform,
  environment = process.env,
  execFileImpl = execFileAsync,
  lstatImpl = fs.lstat,
  uptimeImpl = os.uptime,
  nowImpl = Date.now,
} = {}) {
  if (platform !== "win32") return null;
  // This repair targets the standard Windows installation used by Bonni's
  // offline workstation image. Do not derive the evidence reader from an
  // inherited SystemRoot/WINDIR: a crafted launcher could redirect those
  // variables to a user-controlled fake powershell.exe.
  const systemRoot = TRUSTED_WINDOWS_ROOT;
  const powershell = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const powershellEnvironment = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: path.win32.join(systemRoot, "System32", "cmd.exe"),
    PATH: path.win32.join(systemRoot, "System32"),
    PSModulePath: path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "Modules",
    ),
  };
  const powershellState = await lstatImpl(powershell).catch((error) => {
    const wrapped = new Error(`LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_UNAVAILABLE:${error?.code || "powershell"}`);
    wrapped.code = "LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_UNAVAILABLE";
    throw wrapped;
  });
  if (!powershellState.isFile() || powershellState.isSymbolicLink()) {
    const error = new Error("LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_UNAVAILABLE:powershell-unsafe");
    error.code = "LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_UNAVAILABLE";
    throw error;
  }
  let stdout;
  try {
    ({ stdout } = await execFileImpl(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_BOOT_EVIDENCE_COMMAND,
    ], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      env: powershellEnvironment,
    }));
  } catch (error) {
    const wrapped = new Error(`LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_UNAVAILABLE:${error?.code || "query"}`);
    wrapped.code = "LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_UNAVAILABLE";
    throw wrapped;
  }
  const unavailable = (detail) => {
    const error = new Error(`LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_UNAVAILABLE:${detail}`);
    error.code = "LOCAL_HOST_BACKEND_WINDOWS_BOOT_EVIDENCE_UNAVAILABLE";
    return error;
  };
  let value;
  try {
    value = JSON.parse(String(stdout || "").trim());
  } catch {
    throw unavailable("invalid-json");
  }
  const keys = [
    "schemaVersion", "providerName", "eventId", "logName", "recordId",
    "timeCreated", "providerId", "machineName", "recentEvents",
    "bootProviderName", "bootEventId", "bootLogName", "bootType", "bootEvent",
  ];
  const exact = value
    && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
  const canonicalTimestamp = (candidate) => typeof candidate === "string"
    && Number.isFinite(Date.parse(candidate))
    && new Date(Date.parse(candidate)).toISOString() === candidate;
  const validEvent = (candidate, expectedProviderId) => candidate
    && typeof candidate === "object" && !Array.isArray(candidate)
    && Object.keys(candidate).length === 4
    && Object.hasOwn(candidate, "recordId")
    && Object.hasOwn(candidate, "timeCreated")
    && Object.hasOwn(candidate, "providerId")
    && Object.hasOwn(candidate, "machineName")
    && typeof candidate.recordId === "string"
    && /^[1-9][0-9]{0,19}$/u.test(candidate.recordId)
    && canonicalTimestamp(candidate.timeCreated)
    && candidate.providerId === expectedProviderId
    && typeof candidate.machineName === "string"
    && /^[^\u0000-\u001f\u007f]{1,255}$/u.test(candidate.machineName);
  if (!exact
    || value.schemaVersion !== WINDOWS_BOOT_EVIDENCE_SCHEMA
    || value.providerName !== "Microsoft-Windows-Kernel-General"
    || value.eventId !== "12"
    || value.logName !== "System"
    || typeof value.recordId !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value.recordId)
    || value.providerId !== WINDOWS_KERNEL_GENERAL_PROVIDER_ID
    || typeof value.machineName !== "string"
    || !/^[^\u0000-\u001f\u007f]{1,255}$/u.test(value.machineName)
    || !canonicalTimestamp(value.timeCreated)
    || !Array.isArray(value.recentEvents)
    || value.recentEvents.length < 1 || value.recentEvents.length > 16
    || !value.recentEvents.every((event) => validEvent(event, WINDOWS_KERNEL_GENERAL_PROVIDER_ID))
    || value.recentEvents[0].recordId !== value.recordId
    || value.recentEvents[0].timeCreated !== value.timeCreated
    || value.recentEvents[0].providerId !== value.providerId
    || value.recentEvents[0].machineName !== value.machineName
    || new Set(value.recentEvents.map((event) => `${event.recordId}\0${event.timeCreated}\0${event.providerId}\0${event.machineName}`)).size
      !== value.recentEvents.length
    || value.bootProviderName !== "Microsoft-Windows-Kernel-Boot"
    || value.bootEventId !== "27"
    || value.bootLogName !== "System"
    || typeof value.bootType !== "string" || !/^(?:0|[1-9][0-9]{0,9})$/u.test(value.bootType)
    || !validEvent(value.bootEvent, WINDOWS_KERNEL_BOOT_PROVIDER_ID)
    || value.bootEvent.machineName !== value.machineName
    || Math.abs(Date.parse(value.bootEvent.timeCreated) - Date.parse(value.timeCreated))
      > WINDOWS_BOOT_EVENT_CLUSTER_MS) {
    throw unavailable("invalid");
  }
  const sampledNow = Number(nowImpl());
  const sampledUptimeSeconds = Number(uptimeImpl());
  if (!Number.isFinite(sampledNow) || !Number.isFinite(sampledUptimeSeconds)
    || sampledUptimeSeconds < 0 || sampledUptimeSeconds > Number.MAX_SAFE_INTEGER / 1_000) {
    throw unavailable("invalid-uptime");
  }
  const eventAgeMs = BigInt(Math.trunc(sampledNow - Date.parse(value.timeCreated)));
  const uptimeMs = BigInt(Math.round(sampledUptimeSeconds * 1_000));
  const difference = eventAgeMs >= uptimeMs ? eventAgeMs - uptimeMs : uptimeMs - eventAgeMs;
  const uptimeConsistent = eventAgeMs >= 0n
    && difference <= BigInt(WINDOWS_BOOT_EVIDENCE_MAX_SKEW_MS);
  return Object.freeze({
    recordId: value.recordId,
    timeCreated: value.timeCreated,
    providerId: value.providerId,
    machineName: value.machineName,
    bootType: value.bootType,
    bootEvent: Object.freeze({
      recordId: value.bootEvent.recordId,
      timeCreated: value.bootEvent.timeCreated,
      providerId: value.bootEvent.providerId,
      machineName: value.bootEvent.machineName,
    }),
    uptimeConsistent,
    recentEvents: Object.freeze(value.recentEvents.map((event) => Object.freeze({
      recordId: event.recordId,
      timeCreated: event.timeCreated,
      providerId: event.providerId,
      machineName: event.machineName,
    }))),
  });
}

export function shouldRunLocalSourceUpdateGate(environment = process.env) {
  return String(environment.NODE_ENV || "").trim().toLowerCase() !== "production";
}

export async function runLocalSourceUpdateStartGate({
  recoveryOnly = false,
  platform = process.platform,
} = {}) {
  // In a closed runtime image /app contains no host activation marker, while
  // every host-side entry sees the persistent product-root latch. This check
  // therefore rejects accidental host Core starts before cleanup/auth/DB work
  // without relying on a spoofable environment bypass.
  if (await isHostProductTree()) {
    // A power loss during the small Windows repair must never allow a mixed
    // source tree to start after reboot. The repair installer alone either
    // rolls this journal back or verifies its committed target hashes.
    await assertNoWindowsStartRepairTransaction();
    const runtimeEnvironment = await loadHostRuntimeEnvironment();
    let reconciliation;
    try {
      reconciliation = await reconcileStaleLocalHostBackendRuntime({
        productRoot,
        environment: runtimeEnvironment,
        deferUnboundToRestartRecovery: platform === "win32",
      });
    } catch (error) {
      if (platform !== "win32" || error?.code !== "LOCAL_HOST_BACKEND_RUNTIME_STALE_UNBOUND") {
        throw error;
      }
      // Native boot-session lookup is intentionally lazy: a healthy start has
      // no PowerShell or native-API dependency at all.
      const bootEvidence = await readWindowsBootEvidence({ platform });
      reconciliation = await reconcileStaleUnboundLocalHostBackendRuntimeAfterRestart({
        productRoot,
        bootEvidence,
        environment: runtimeEnvironment,
      });
      if (reconciliation.reconciled) {
        console.info(
          `[bonni-start] Unterbrochenen Windows-Start nach Neustart sicher archiviert: ${path.basename(reconciliation.archivedPath)}`,
        );
      }
    }
    if (reconciliation.reconciled && reconciliation.reason !== "restart-proven-stale-archived") {
      console.info(
        `[bonni-start] Veralteter Host-Backend-Beleg automatisch archiviert: ${path.basename(reconciliation.archivedPath)}`,
      );
    }
    if (platform === "win32" && reconciliation.reason === "absent") {
      await reconcileStaleUnboundLocalHostBackendRuntimeAfterRestart({
        productRoot,
        bootEvidence: null,
        environment: runtimeEnvironment,
      });
    }
    if (recoveryOnly) return;
    await assertContainerRuntimeActivationInactive({
      productRoot,
      environment: runtimeEnvironment,
    });
  }
  if (shouldRunLocalSourceUpdateGate()) {
    const localGate = path.join(backendRoot, "scripts", "setup", "local-source-update-gate.mjs");
    await import(pathToFileURL(localGate).href);
  } else {
    console.info("[bonni-start] Production verwendet ausschließlich den signierten OCI-Updatepfad.");
  }
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  try {
    await runLocalSourceUpdateStartGate({
      recoveryOnly: process.argv.includes("--windows-runtime-recovery-only"),
    });
  } catch (error) {
    if (error?.code === "LOCAL_HOST_BACKEND_RUNTIME_RESTART_REQUIRED") {
      console.error("");
      console.error("[bonni-start] Der vorherige Windows-Start wurde sehr frueh unterbrochen.");
      console.error("[bonni-start] Zum sicheren Entsperren Windows bitte einmal NEU STARTEN.");
      console.error("[bonni-start] Danach BONNI-CORE-STARTEN.cmd erneut doppelklicken.");
      console.error("[bonni-start] Es wurde nichts geloescht und kein Prozess beendet.");
      process.exitCode = 12;
    } else if (WINDOWS_BOOT_EVIDENCE_BLOCK_CODES.has(error?.code)) {
      console.error("");
      console.error("[bonni-start] Die Windows-Neustartpruefung konnte nicht sicher gelesen werden.");
      console.error("[bonni-start] Zum Schutz der Daten wurde nichts entsperrt oder geloescht.");
      console.error("[bonni-start] Bitte keinen Laufzeitbeleg von Hand veraendern.");
      process.exitCode = 13;
    } else {
      throw error;
    }
  }
}
