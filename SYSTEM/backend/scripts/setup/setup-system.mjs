import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPrebuiltFrontendMarker,
  resolveFrontendSetupMode,
  verifyPrebuiltFrontend,
} from "./prebuilt-frontend.mjs";
import {
  assertNoPendingLocalSourceUpdate,
  assertPendingLocalSourceUpdate,
} from "./local-source-update.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDirectory, "../..");
const systemRoot = path.resolve(backendRoot, "..");
const frontendRoot = path.join(systemRoot, "frontend");
const frontendBuildRoot = path.join(frontendRoot, "dist");
const publishedFrontendRoot = path.join(backendRoot, "public", "system");
const configuredProductRoot = String(process.env.BONNI_PRODUCT_ROOT || "").trim();
if (configuredProductRoot && (configuredProductRoot.includes("\u0000") || !path.isAbsolute(configuredProductRoot))) {
  throw new Error("BONNI_PRODUCT_ROOT_INVALID");
}
const productRoot = configuredProductRoot || path.resolve(systemRoot, "..");
const setupMode = process.env.BONNI_SETUP_MODE === "update" ? "update" : "setup";
const MAX_SETUP_ENV_BYTES = 1024 * 1024;
const setupProgressPath = path.join(
  productRoot,
  "SYSTEM",
  ".bonni-source-update",
  "control-center",
  "setup-progress.json",
);
const updateFrontendWorkspaceRoot = path.join(
  systemRoot,
  ".bonni-source-update",
  "f",
);
const TRANSIENT_WINDOWS_FS_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const TELEMETRY_RETRY_DELAYS_MS = [20, 50, 100];
const FRONTEND_STAGING_EXCLUDES = new Set(["node_modules", "dist"]);

function setupReadinessError(code, message) {
  return new Error(
    `${code}: ${message} `
    + "Die bestehende Backend-Laufzeit wurde nicht verändert oder gelöscht.",
  );
}

function parseEnvironmentValue(rawValue, lineNumber) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  if (!value.startsWith('"') && !value.startsWith("'")) {
    const commentIndex = value.indexOf("#");
    return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trim();
  }

  const quote = value[0];
  let closingIndex = -1;
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== quote) continue;
    if (quote === '"') {
      let slashCount = 0;
      for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
        slashCount += 1;
      }
      if (slashCount % 2 === 1) continue;
    }
    closingIndex = index;
    break;
  }
  if (closingIndex < 0) {
    throw setupReadinessError(
      "SETUP_READINESS_ENV_PARSE_INVALID",
      `System/backend/.env enthält in Zeile ${lineNumber} einen nicht geschlossenen Wert.`,
    );
  }
  const remainder = value.slice(closingIndex + 1).trim();
  if (remainder && !remainder.startsWith("#")) {
    throw setupReadinessError(
      "SETUP_READINESS_ENV_PARSE_INVALID",
      `System/backend/.env enthält in Zeile ${lineNumber} ungültige Zeichen hinter einem Wert.`,
    );
  }

  const quoted = value.slice(1, closingIndex);
  if (quote === "'") return quoted;
  return quoted
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t")
    .replaceAll('\\"', '"')
    .replaceAll("\\\\", "\\");
}

function parseSetupEnvironment(source) {
  if (source.includes("\0")) {
    throw setupReadinessError(
      "SETUP_READINESS_ENV_PARSE_INVALID",
      "System/backend/.env enthält unzulässige Nullbytes.",
    );
  }
  const definitions = new Map();
  const lines = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) {
      throw setupReadinessError(
        "SETUP_READINESS_ENV_PARSE_INVALID",
        `System/backend/.env enthält in Zeile ${index + 1} keine gültige KEY=WERT-Zuweisung.`,
      );
    }
    const key = match[1];
    if (definitions.has(key)) {
      throw setupReadinessError(
        "SETUP_READINESS_ENV_DUPLICATE",
        `System/backend/.env definiert ${key} mehrfach.`,
      );
    }
    definitions.set(key, parseEnvironmentValue(match[2], index + 1));
  }
  return definitions;
}

function assertDatabaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw setupReadinessError(
      "SETUP_READINESS_DATABASE_URL_MISSING",
      "Die Pflichtkonfiguration DATABASE_URL fehlt in System/backend/.env.",
    );
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw setupReadinessError(
      "SETUP_READINESS_DATABASE_URL_INVALID",
      "DATABASE_URL in System/backend/.env ist keine gültige Verbindungsadresse.",
    );
  }
  let databaseName = "";
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  } catch {
    throw setupReadinessError(
      "SETUP_READINESS_DATABASE_URL_INVALID",
      "DATABASE_URL enthält eine ungültige Zeichenkodierung.",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !parsed.hostname
    || !/^[A-Za-z][A-Za-z0-9_]{0,43}$/u.test(databaseName)
    || parsed.hash
    || /[<>]/u.test(raw)
    || /[\u0000-\u001F\u007F]/u.test(raw)
  ) {
    throw setupReadinessError(
      "SETUP_READINESS_DATABASE_URL_INVALID",
      "DATABASE_URL muss eine vollständige PostgreSQL-Adresse mit Host und gültigem Datenbanknamen ohne Platzhalter sein.",
    );
  }
}

export async function assertSetupReadiness({
  backendDirectory = backendRoot,
  inheritedEnvironment = process.env,
} = {}) {
  const resolvedBackend = path.resolve(backendDirectory);
  const environmentPath = path.join(resolvedBackend, ".env");
  const backendState = await fs.lstat(resolvedBackend).catch(() => null);
  if (!backendState?.isDirectory() || backendState.isSymbolicLink()) {
    throw setupReadinessError(
      "SETUP_READINESS_BACKEND_ROOT_UNSAFE",
      "Das Verzeichnis System/backend ist nicht sicher erreichbar.",
    );
  }
  const realBackend = await fs.realpath(resolvedBackend);
  const normalize = (value) => process.platform === "win32"
    ? path.resolve(value).toLocaleLowerCase("en-US")
    : path.resolve(value);
  if (normalize(realBackend) !== normalize(resolvedBackend)) {
    throw setupReadinessError(
      "SETUP_READINESS_BACKEND_ROOT_UNSAFE",
      "Das Verzeichnis System/backend darf keine Verzeichnisverknüpfung sein.",
    );
  }

  const environmentState = await fs.lstat(environmentPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!environmentState) {
    throw setupReadinessError(
      "SETUP_READINESS_ENV_MISSING",
      "System/backend/.env fehlt. Bitte zuerst .env.example kopieren und DATABASE_URL eintragen.",
    );
  }
  if (
    !environmentState.isFile()
    || environmentState.isSymbolicLink()
    || environmentState.nlink !== 1
    || environmentState.size > MAX_SETUP_ENV_BYTES
  ) {
    throw setupReadinessError(
      "SETUP_READINESS_ENV_UNSAFE",
      "System/backend/.env muss eine einzelne reguläre Datei mit höchstens 1 MiB sein.",
    );
  }
  const realEnvironment = await fs.realpath(environmentPath);
  if (normalize(realEnvironment) !== normalize(environmentPath)) {
    throw setupReadinessError(
      "SETUP_READINESS_ENV_UNSAFE",
      "System/backend/.env darf keine Datei- oder Pfadverknüpfung sein.",
    );
  }
  if (process.platform !== "win32" && (environmentState.mode & 0o077) !== 0) {
    throw setupReadinessError(
      "SETUP_READINESS_ENV_PERMISSIONS_UNSAFE",
      "System/backend/.env ist für Gruppe oder andere Benutzer lesbar; erwartet werden Dateirechte 600.",
    );
  }

  const definitions = parseSetupEnvironment(await fs.readFile(environmentPath, "utf8"));
  const configuredDatabaseUrl = definitions.get("DATABASE_URL");
  if (configuredDatabaseUrl === undefined || !String(configuredDatabaseUrl).trim()) {
    throw setupReadinessError(
      "SETUP_READINESS_DATABASE_URL_MISSING",
      "Die Pflichtkonfiguration DATABASE_URL fehlt in System/backend/.env.",
    );
  }
  assertDatabaseUrl(configuredDatabaseUrl);
  if (Object.hasOwn(inheritedEnvironment, "DATABASE_URL")) {
    assertDatabaseUrl(inheritedEnvironment.DATABASE_URL);
  }
  return { environmentPath };
}

function npmInvocation(args) {
  const npmCli = String(process.env.npm_execpath || "").trim();
  if (npmCli) {
    return {
      command: process.execPath,
      args: [npmCli, ...args],
    };
  }

  return {
    command: process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm",
    args: process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", ...args] : args,
  };
}

function runStage(label, cwd, args) {
  const invocation = npmInvocation(args);
  console.log(`\n[bonni-setup] ${label}`);

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `SETUP_STAGE_FAILED:${label}:${signal ? `signal-${signal}` : `exit-${code}`}`,
      ));
    });
  });
}

function shortDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function transientWindowsFilesystemError(error) {
  return TRANSIENT_WINDOWS_FS_CODES.has(String(error?.code || "").toUpperCase());
}

function internalPathSafetyError(error) {
  return /^(?:SETUP_UNSAFE_INTERNAL|SETUP_INTERNAL_DIRECTORY_ALIAS):/u.test(
    String(error?.message || ""),
  );
}

export async function writeSetupProgressBestEffort({
  progressPath,
  progress,
  fileSystem = fs,
  retryDelays = TELEMETRY_RETRY_DELAYS_MS,
  wait = shortDelay,
  warn = (message) => console.warn(message),
}) {
  const directory = path.dirname(progressPath);
  const source = `${JSON.stringify(progress, null, 2)}\n`;
  const attempts = Math.max(1, retryDelays.length + 1);
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const temporary = path.join(
      directory,
      `.bonni-setup-progress-${process.pid}-${Date.now()}-${attempt}.tmp`,
    );
    try {
      await fileSystem.mkdir(directory, { recursive: true });
      await fileSystem.writeFile(temporary, source, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fileSystem.rename(temporary, progressPath);
      return true;
    } catch (error) {
      lastError = error;
      const retry = transientWindowsFilesystemError(error) && attempt < attempts - 1;
      if (!retry) break;
      await wait(retryDelays[attempt]);
    } finally {
      try {
        await fileSystem.rm(temporary, { force: true });
      } catch {
        // Temporäre Telemetriedateien werden ebenfalls nur best effort entfernt.
      }
    }
  }

  try {
    await warn(`[bonni-setup] Fortschrittsstatus konnte nicht geschrieben werden; Einrichtung läuft weiter (${lastError?.code || lastError?.message || "unbekannter Fehler"}).`);
  } catch {
    // Fortschrittstelemetrie und ihre Warnung dürfen die Einrichtung nie abbrechen.
  }
  return false;
}

async function writeUpdateSetupProgress({
  updateId,
  status,
  stage,
  stageIndex,
  stageCount,
  message,
}) {
  if (setupMode !== "update" || !updateId) return;
  try {
    await writeSetupProgressBestEffort({
      progressPath: setupProgressPath,
      progress: {
        schemaVersion: "bonni.local-source-update-setup-progress/v1",
        updateId,
        status,
        stage,
        stageIndex,
        stageCount,
        message,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    try {
      console.warn(
        `[bonni-setup] Fortschrittsstatus ist nicht verfügbar; Einrichtung läuft weiter (${error?.code || error?.message || "unbekannter Fehler"}).`,
      );
    } catch {
      // Fortschrittstelemetrie bleibt vollständig best effort.
    }
  }
}

function publicSetupStageLabel(label) {
  const known = new Map([
    ["Backend-Abhängigkeiten installieren/aktualisieren", "Bonni-Core-Programmbasis wird vorbereitet"],
    ["Frontend-Abhängigkeiten installieren/aktualisieren", "Bonni-Core-Oberfläche wird vorbereitet"],
    ["Systemschlüssel sicherstellen", "Systemschlüssel werden geprüft"],
    ["Datenbanken, Schemas, Rollen und Rechte aktualisieren", "Datenbanken, Rollen und Rechte werden aktualisiert"],
    ["Alte technische Dateien vor dem Neubau bereinigen", "Alte technische Arbeitsdaten werden bereinigt"],
    ["Prisma Client aktualisieren", "Datenzugriff wird aktualisiert"],
    ["Technische Systemdaten und Administrator anlegen/reparieren", "Technische Systemdaten werden geprüft"],
    ["Backend erzeugen und prüfen", "Bonni-Core-Backend wird erzeugt und geprüft"],
    ["Bonni-Core-Lizenzkatalog zentral und unveränderlich ablegen", "Bonni-Core-Lizenzdaten werden geprüft und abgelegt"],
    ["Frontend erzeugen", "Bonni-Core-Oberfläche wird erzeugt"],
  ]);
  return known.get(label) || String(label || "Bonni Core wird eingerichtet");
}

async function optionalInternalDirectory(rootDirectory, targetDirectory, fileSystem = fs) {
  await assertSafeInternalDirectoryChain(rootDirectory, targetDirectory, { allowMissingTarget: true });
  const state = await fileSystem.lstat(targetDirectory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!state) return null;
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error(`SETUP_UNSAFE_INTERNAL_DIRECTORY:${targetDirectory}`);
  }
  return state;
}

async function removeInternalDirectory(rootDirectory, targetDirectory) {
  if (!await optionalInternalDirectory(rootDirectory, targetDirectory)) return;
  await fs.rm(targetDirectory, { recursive: true, force: true });
}

async function removeEmptyDirectory(directory) {
  await fs.rmdir(directory).catch((error) => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
  });
}

async function ensureFrontendPublicationRoot(systemDirectory, transactionRoot) {
  await assertSafeInternalDirectoryChain(systemDirectory, transactionRoot, { allowMissingTarget: true });
  await fs.mkdir(transactionRoot, { recursive: true });
  await assertSafeInternalDirectoryChain(systemDirectory, transactionRoot);
}

async function recoverFrontendPublication({
  systemDirectory,
  backendDirectory,
  publishedDirectory,
  transactionRoot,
  stagedDirectory,
  previousDirectory,
}) {
  await ensureFrontendPublicationRoot(systemDirectory, transactionRoot);
  const previous = await optionalInternalDirectory(systemDirectory, previousDirectory);
  const published = await optionalInternalDirectory(backendDirectory, publishedDirectory);

  if (previous && !published) {
    await fs.mkdir(path.dirname(publishedDirectory), { recursive: true });
    await assertSafeInternalDirectoryChain(backendDirectory, publishedDirectory, { allowMissingTarget: true });
    await fs.rename(previousDirectory, publishedDirectory);
  } else if (previous && published) {
    try {
      await verifyPrebuiltFrontend(publishedDirectory);
      await removeInternalDirectory(systemDirectory, previousDirectory);
    } catch {
      await removeInternalDirectory(backendDirectory, publishedDirectory);
      await fs.rename(previousDirectory, publishedDirectory);
    }
  }

  await removeInternalDirectory(systemDirectory, stagedDirectory);
}

export async function publishFrontend(options = {}) {
  const systemDirectory = path.resolve(options.systemDirectory || systemRoot);
  const backendDirectory = path.resolve(options.backendDirectory || backendRoot);
  const buildDirectory = path.resolve(options.buildDirectory || frontendBuildRoot);
  const publishedDirectory = path.resolve(options.publishedDirectory || publishedFrontendRoot);
  const transactionRoot = path.join(systemDirectory, ".bonni-frontend-publish");
  const stagedDirectory = path.join(transactionRoot, "staged");
  const previousDirectory = path.join(transactionRoot, "previous");

  await assertSafeInternalDirectoryChain(systemDirectory, buildDirectory);
  await assertSafeInternalDirectoryChain(backendDirectory, publishedDirectory, { allowMissingTarget: true });
  await assertRegularFrontendTree(buildDirectory);
  const sourceIndex = path.join(buildDirectory, "index.html");
  const sourceIndexState = await fs.stat(sourceIndex).catch(() => null);
  if (!sourceIndexState?.isFile()) {
    throw new Error("SETUP_FRONTEND_BUILD_MISSING");
  }

  console.log("\n[bonni-setup] Gebautes Frontend für den gemeinsamen Systemstart bereitstellen");
  await recoverFrontendPublication({
    systemDirectory,
    backendDirectory,
    publishedDirectory,
    transactionRoot,
    stagedDirectory,
    previousDirectory,
  });

  let movedPrevious = false;
  let installedStaged = false;
  let publicationCommitted = false;
  try {
    await fs.cp(buildDirectory, stagedDirectory, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await assertSafeInternalDirectoryChain(systemDirectory, stagedDirectory);
    await assertRegularFrontendTree(stagedDirectory);
    await createPrebuiltFrontendMarker(stagedDirectory);
    await verifyPrebuiltFrontend(stagedDirectory);

    if (await optionalInternalDirectory(backendDirectory, publishedDirectory)) {
      await fs.rename(publishedDirectory, previousDirectory);
      movedPrevious = true;
    }
    await fs.mkdir(path.dirname(publishedDirectory), { recursive: true });
    await assertSafeInternalDirectoryChain(backendDirectory, publishedDirectory, { allowMissingTarget: true });
    await fs.rename(stagedDirectory, publishedDirectory);
    installedStaged = true;
    await verifyPrebuiltFrontend(publishedDirectory);
    publicationCommitted = true;
    if (movedPrevious) await removeInternalDirectory(systemDirectory, previousDirectory);
    await removeEmptyDirectory(transactionRoot);
  } catch (error) {
    if (publicationCommitted) throw error;
    try {
      if (movedPrevious) {
        if (installedStaged) await removeInternalDirectory(backendDirectory, publishedDirectory);
        if (!await optionalInternalDirectory(backendDirectory, publishedDirectory)) {
          await fs.mkdir(path.dirname(publishedDirectory), { recursive: true });
          await assertSafeInternalDirectoryChain(backendDirectory, publishedDirectory, { allowMissingTarget: true });
          await fs.rename(previousDirectory, publishedDirectory);
        }
      } else if (installedStaged) {
        await removeInternalDirectory(backendDirectory, publishedDirectory);
      }
      await removeInternalDirectory(systemDirectory, stagedDirectory);
      await removeEmptyDirectory(transactionRoot);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "SETUP_FRONTEND_PUBLISH_ROLLBACK_FAILED",
      );
    }
    throw error;
  }
}

async function assertSafeInternalDirectoryChain(rootDirectory, targetDirectory, options = {}) {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(targetDirectory);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`SETUP_UNSAFE_INTERNAL_PATH:${target}`);
  }
  const rootState = await fs.lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw new Error(`SETUP_UNSAFE_INTERNAL_ROOT:${root}`);
  }
  const realRoot = await fs.realpath(root);
  let cursor = root;
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const state = await fs.lstat(cursor).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!state) {
      if (options.allowMissingTarget) return;
      throw new Error(`SETUP_INTERNAL_DIRECTORY_MISSING:${cursor}`);
    }
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error(`SETUP_UNSAFE_INTERNAL_DIRECTORY:${cursor}`);
    }
    const realCursor = await fs.realpath(cursor);
    const expected = path.join(realRoot, ...segments.slice(0, index + 1));
    const normalize = (value) => process.platform === "win32"
      ? path.resolve(value).toLocaleLowerCase("en-US")
      : path.resolve(value);
    if (normalize(realCursor) !== normalize(expected)) {
      throw new Error(`SETUP_INTERNAL_DIRECTORY_ALIAS:${cursor}`);
    }
  }
}

async function assertRegularFrontendTree(rootDirectory, relative = "") {
  const directory = path.join(rootDirectory, ...relative.split("/").filter(Boolean));
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = path.join(rootDirectory, ...childRelative.split("/"));
    const state = await fs.lstat(child);
    if (state.isSymbolicLink() || (!state.isDirectory() && !state.isFile())) {
      throw new Error(`SETUP_FRONTEND_TREE_UNSAFE:${childRelative}`);
    }
    if (state.isFile() && state.nlink > 1) {
      throw new Error(`SETUP_FRONTEND_TREE_HARDLINK:${childRelative}`);
    }
    if (state.isDirectory()) await assertRegularFrontendTree(rootDirectory, childRelative);
  }
}

async function copyFrontendSourceTree(sourceRoot, targetRoot, relative = "") {
  const sourceDirectory = relative
    ? path.join(sourceRoot, ...relative.split("/"))
    : sourceRoot;
  const targetDirectory = relative
    ? path.join(targetRoot, ...relative.split("/"))
    : targetRoot;
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

  for (const entry of entries) {
    if (
      !relative
      && FRONTEND_STAGING_EXCLUDES.has(entry.name.toLocaleLowerCase("en-US"))
    ) continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const source = path.join(sourceRoot, ...childRelative.split("/"));
    const target = path.join(targetRoot, ...childRelative.split("/"));
    const state = await fs.lstat(source);
    if (state.isSymbolicLink() || (!state.isDirectory() && !state.isFile())) {
      throw new Error(`SETUP_FRONTEND_SOURCE_TREE_UNSAFE:${childRelative}`);
    }
    if (state.isFile() && state.nlink > 1) {
      throw new Error(`SETUP_FRONTEND_SOURCE_TREE_HARDLINK:${childRelative}`);
    }
    if (state.isDirectory()) {
      await fs.mkdir(target, { recursive: false, mode: state.mode & 0o777 });
      await copyFrontendSourceTree(sourceRoot, targetRoot, childRelative);
    } else {
      await fs.copyFile(source, target);
      await fs.chmod(target, state.mode & 0o777);
    }
  }

  return targetDirectory;
}

function resolveUpdateFrontendWorkspace(systemDirectory, workspaceDirectory) {
  const system = path.resolve(systemDirectory);
  const workspace = path.resolve(
    workspaceDirectory || path.join(system, ".bonni-source-update", "f"),
  );
  if (workspace === system || !workspace.startsWith(`${system}${path.sep}`)) {
    throw new Error(`SETUP_FRONTEND_STAGING_OUTSIDE_STATE:${workspace}`);
  }
  const relative = path.relative(system, workspace).split(path.sep).filter(Boolean);
  if (relative[0] !== ".bonni-source-update") {
    throw new Error(`SETUP_FRONTEND_STAGING_OUTSIDE_STATE:${workspace}`);
  }
  return workspace;
}

export async function stageFrontendSourceForUpdate(options = {}) {
  const systemDirectory = path.resolve(options.systemDirectory || systemRoot);
  const sourceDirectory = path.resolve(options.frontendDirectory || frontendRoot);
  const workspaceDirectory = resolveUpdateFrontendWorkspace(
    systemDirectory,
    options.workspaceDirectory
      || path.join(systemDirectory, ".bonni-source-update", "f"),
  );
  const stagingDirectory = path.join(
    workspaceDirectory,
    `${process.pid}-${randomBytes(4).toString("hex")}`,
  );

  await assertSafeInternalDirectoryChain(systemDirectory, sourceDirectory);
  await assertSafeInternalDirectoryChain(systemDirectory, workspaceDirectory, { allowMissingTarget: true });
  await fs.mkdir(workspaceDirectory, { recursive: true });
  await assertSafeInternalDirectoryChain(systemDirectory, workspaceDirectory);
  await cleanupOrphanedFrontendBuilds({
    systemDirectory,
    workspaceDirectory,
  });
  await fs.mkdir(workspaceDirectory, { recursive: true });
  await assertSafeInternalDirectoryChain(systemDirectory, workspaceDirectory);
  await fs.mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
  await assertSafeInternalDirectoryChain(systemDirectory, stagingDirectory);

  try {
    await copyFrontendSourceTree(sourceDirectory, stagingDirectory);
    const packageState = await fs.lstat(path.join(stagingDirectory, "package.json")).catch(() => null);
    if (!packageState?.isFile() || packageState.isSymbolicLink()) {
      throw new Error("SETUP_FRONTEND_STAGING_PACKAGE_MISSING");
    }
    return Object.freeze({
      workspaceDirectory,
      sourceDirectory: stagingDirectory,
      buildDirectory: path.join(stagingDirectory, "dist"),
    });
  } catch (error) {
    await cleanupStagedFrontendBuild({
      systemDirectory,
      workspaceDirectory,
      stagingDirectory,
    });
    throw error;
  }
}

export async function cleanupStagedFrontendBuild({
  systemDirectory = systemRoot,
  workspaceDirectory,
  stagingDirectory,
  fileSystem = fs,
  retryDelays = TELEMETRY_RETRY_DELAYS_MS,
  wait = shortDelay,
  warn = (message) => console.warn(message),
} = {}) {
  if (!stagingDirectory) return true;
  const system = path.resolve(systemDirectory);
  const workspace = resolveUpdateFrontendWorkspace(
    system,
    workspaceDirectory || path.join(system, ".bonni-source-update", "f"),
  );
  const staging = path.resolve(stagingDirectory);
  if (staging === workspace || !staging.startsWith(`${workspace}${path.sep}`)) {
    throw new Error(`SETUP_FRONTEND_STAGING_CLEANUP_UNSAFE:${staging}`);
  }

  const attempts = Math.max(1, retryDelays.length + 1);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertSafeInternalDirectoryChain(system, staging, { allowMissingTarget: true });
      await fileSystem.rm(staging, { recursive: true, force: true });
      try {
        await fileSystem.rmdir(workspace);
      } catch {
        // Ein weiterer Staging-Lauf oder ein nicht leerer Elternordner bleibt erhalten.
      }
      return true;
    } catch (error) {
      lastError = error;
      const retry = transientWindowsFilesystemError(error) && attempt < attempts - 1;
      if (!retry) break;
      await wait(retryDelays[attempt]);
    }
  }
  try {
    await warn(`[bonni-setup] Temporärer Frontend-Build konnte nicht vollständig bereinigt werden; Einrichtung bleibt gültig (${lastError?.code || lastError?.message || "unbekannter Fehler"}).`);
  } catch {
    // Best-effort-Aufräumen darf das eigentliche Installationsergebnis nicht ändern.
  }
  return false;
}

export async function cleanupOrphanedFrontendBuilds({
  systemDirectory = systemRoot,
  workspaceDirectory,
  fileSystem = fs,
  retryDelays = TELEMETRY_RETRY_DELAYS_MS,
  wait = shortDelay,
  warn = (message) => console.warn(message),
} = {}) {
  const system = path.resolve(systemDirectory);
  const workspace = resolveUpdateFrontendWorkspace(
    system,
    workspaceDirectory || path.join(system, ".bonni-source-update", "f"),
  );
  const attempts = Math.max(1, retryDelays.length + 1);
  let workspaceState = null;
  let workspaceChecked = false;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      workspaceState = await optionalInternalDirectory(system, workspace, fileSystem);
      workspaceChecked = true;
      break;
    } catch (error) {
      if (internalPathSafetyError(error)) throw error;
      lastError = error;
      const retry = transientWindowsFilesystemError(error) && attempt < attempts - 1;
      if (!retry) break;
      await wait(retryDelays[attempt]);
    }
  }
  if (!workspaceChecked) {
    try {
      await warn(`[bonni-setup] Alte Frontend-Stagingordner konnten nicht sicher geöffnet werden; der neue isolierte Build wird trotzdem versucht (${lastError?.code || lastError?.message || "unbekannter Fehler"}).`);
    } catch {
      // Verwaiste Arbeitsdaten werden ausschließlich best effort bereinigt.
    }
    return false;
  }
  if (!workspaceState) return true;

  let entries = null;
  lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      entries = await fileSystem.readdir(workspace, { withFileTypes: true });
      break;
    } catch (error) {
      lastError = error;
      const retry = transientWindowsFilesystemError(error) && attempt < attempts - 1;
      if (!retry) break;
      await wait(retryDelays[attempt]);
    }
  }
  if (!entries) {
    try {
      await warn(`[bonni-setup] Alte Frontend-Stagingordner konnten nicht geprüft werden; der neue isolierte Build wird trotzdem versucht (${lastError?.code || lastError?.message || "unbekannter Fehler"}).`);
    } catch {
      // Verwaiste Arbeitsdaten werden ausschließlich best effort bereinigt.
    }
    return false;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  let cleaned = true;
  for (const entry of entries) {
    const stagingDirectory = path.join(workspace, entry.name);
    const removed = await cleanupStagedFrontendBuild({
      systemDirectory: system,
      workspaceDirectory: workspace,
      stagingDirectory,
      fileSystem,
      retryDelays,
      wait,
      warn,
    });
    if (!removed) cleaned = false;
  }
  return cleaned;
}

const baseStages = [
  ["Backend-Abhängigkeiten installieren/aktualisieren", backendRoot, [
    "ci",
    "--include=dev",
    "--no-audit",
    "--no-fund",
  ]],
  ["Systemschlüssel sicherstellen", backendRoot, ["run", "auth:ensure-jwt"]],
  ["Datenbanken, Schemas, Rollen und Rechte aktualisieren", backendRoot, [
    "run",
    "database:bootstrap",
  ]],
  ["Alte technische Dateien vor dem Neubau bereinigen", backendRoot, [
    "run", "maintenance:cleanup", "--", "--before-build",
  ]],
  ["Prisma Client aktualisieren", backendRoot, ["run", "prisma:generate"]],
  ["Technische Systemdaten und Administrator anlegen/reparieren", backendRoot, [
    "run",
    "seed",
  ]],
  ["Backend erzeugen und prüfen", backendRoot, ["run", "build:code"]],
  ["Bonni-Core-Lizenzkatalog zentral und unveränderlich ablegen", backendRoot, ["run", "licenses:sync-core"]],
];

export function createSetupStages(frontendMode, options = {}) {
  const frontendDirectory = path.resolve(options.frontendDirectory || frontendRoot);
  const frontendStages = frontendMode === "source"
    ? [
        ["Frontend-Abhängigkeiten installieren/aktualisieren", frontendDirectory, [
          "ci", "--include=dev", "--no-audit", "--no-fund",
        ]],
        ["Frontend erzeugen", frontendDirectory, ["run", "build"]],
      ]
    : [];
  return [
    baseStages[0],
    ...frontendStages.slice(0, 1),
    ...baseStages.slice(1, -1),
    ...frontendStages.slice(1),
    ...baseStages.slice(-1),
  ];
}

export async function runSetupStages(stages, stageRunner = runStage, onProgress = async () => {}) {
  const reportProgress = async (event) => {
    try {
      await onProgress(event);
    } catch (error) {
      try {
        console.warn(
          `[bonni-setup] Fortschrittsstatus konnte nicht gemeldet werden; Einrichtung läuft weiter (${error?.code || error?.message || "unbekannter Fehler"}).`,
        );
      } catch {
        // Auch eine nicht verfügbare Warn-Ausgabe darf keine Stage stoppen.
      }
    }
  };

  for (let index = 0; index < stages.length; index += 1) {
    const [label, cwd, args] = stages[index];
    await reportProgress({
      status: "running",
      stage: `setup-${index + 1}`,
      stageIndex: index + 1,
      stageCount: stages.length,
      message: publicSetupStageLabel(label),
    });
    try {
      await stageRunner(label, cwd, args);
    } catch (error) {
      await reportProgress({
        status: "failed",
        stage: `setup-${index + 1}`,
        stageIndex: index + 1,
        stageCount: stages.length,
        message: `${publicSetupStageLabel(label)} – sicher abgebrochen`,
      });
      throw error;
    }
  }
}

async function runSetup() {
  let stagedFrontend = null;
  try {
    await assertSetupReadiness({ backendDirectory: backendRoot });
    let updateId = "";
    if (setupMode === "update") {
      updateId = String(process.env.BONNI_LOCAL_SOURCE_UPDATE_ID || "").trim();
      const handoffToken = String(process.env.BONNI_LOCAL_SOURCE_UPDATE_HANDOFF || "").trim();
      await assertPendingLocalSourceUpdate({ productRoot, updateId, handoffToken });
      console.log(`[bonni-setup] Aktualisierung ${updateId} einrichten.`);
    } else {
      await assertNoPendingLocalSourceUpdate({ productRoot });
      console.log("[bonni-setup] Neuinstallation bzw. unterbrochene Neuinstallation einrichten.");
    }
    const frontendMode = await resolveFrontendSetupMode({ frontendRoot, publishedFrontendRoot });
    if (setupMode === "update" && frontendMode === "source") {
      stagedFrontend = await stageFrontendSourceForUpdate({
        systemDirectory: systemRoot,
        frontendDirectory: frontendRoot,
        workspaceDirectory: updateFrontendWorkspaceRoot,
      });
      console.log(
        "[bonni-setup] Bonni-Core-Oberfläche wird getrennt von der laufenden Installation vorbereitet.",
      );
    }
    const stages = createSetupStages(frontendMode, {
      frontendDirectory: stagedFrontend?.sourceDirectory || frontendRoot,
    });
    const totalStageCount = stages.length + (frontendMode === "source" ? 1 : 0);
    const reportProgress = (progress) => writeUpdateSetupProgress({ updateId, ...progress });
    await runSetupStages(stages, runStage, (progress) => reportProgress({
      ...progress,
      stageCount: totalStageCount,
    }));
    if (frontendMode === "source") {
      await reportProgress({
        status: "running",
        stage: "publish-frontend",
        stageIndex: totalStageCount,
        stageCount: totalStageCount,
        message: "Bonni-Core-Oberfläche wird sicher bereitgestellt",
      });
      if (stagedFrontend) {
        await publishFrontend({ buildDirectory: stagedFrontend.buildDirectory });
      } else {
        await publishFrontend();
      }
    } else {
      await verifyPrebuiltFrontend(publishedFrontendRoot);
      console.log("\n[bonni-setup] Versions- und hashgebundenes Prebuilt-Core-Frontend unverändert beibehalten.");
    }
    await reportProgress({
      status: "completed",
      stage: "setup-complete",
      stageIndex: totalStageCount,
      stageCount: totalStageCount,
      message: "Bonni Core ist vollständig eingerichtet",
    });
    console.log(setupMode === "update"
      ? "\n[bonni-setup] Aktualisierung vollständig eingerichtet."
      : "\n[bonni-setup] Neuinstallation vollständig eingerichtet.");
    console.log("[bonni-setup] Fach-Apps wurden nicht installiert, repariert oder aktiviert.");
    console.log("[bonni-setup] Standardzugang einer neuen Installation: admin / hamster");
    console.log("[bonni-setup] Systemstart: npm start");
  } catch (error) {
    console.error(setupMode === "update"
      ? "\n[bonni-setup] Einrichtung der Aktualisierung abgebrochen."
      : "\n[bonni-setup] Neuinstallation abgebrochen.");
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (stagedFrontend) {
      await cleanupStagedFrontendBuild({
        systemDirectory: systemRoot,
        workspaceDirectory: stagedFrontend.workspaceDirectory,
        stagingDirectory: stagedFrontend.sourceDirectory,
      }).catch((error) => {
        console.warn(
          `[bonni-setup] Temporärer Frontend-Build konnte nicht bereinigt werden; Einrichtung bleibt gültig (${error?.code || error?.message || "unbekannter Fehler"}).`,
        );
      });
    }
  }
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentFile = path.resolve(fileURLToPath(import.meta.url));
const comparableFile = (value) => process.platform === "win32"
  ? value.toLocaleLowerCase("en-US")
  : value;
if (comparableFile(invokedFile) === comparableFile(currentFile)) await runSetup();
