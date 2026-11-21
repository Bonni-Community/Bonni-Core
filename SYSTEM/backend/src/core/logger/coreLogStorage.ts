import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getDiagnosticRuntime } from "./diagnostic-context.js";
import { sanitizeDiagnosticExport } from "./diagnostic-serialization.js";
import { privateValue } from "../../../scripts/runtime/log-privacy.mjs";
import { cleanPrivateLogFile } from "../../../scripts/runtime/log-privacy-files.mjs";

export const CORE_LOG_FILE_NAME = "bonni-core.log";
export const CORE_ERROR_FILE_NAME = "bonni-core-error.txt";
export const CORE_LOG_RETENTION_COUNT = 3;
export const CORE_LOG_ROTATION_INTERVAL_MS = 3 * 60 * 60 * 1000;

const MAX_READ_BYTES = 8 * 1024 * 1024;
const RUN_ROOT_NAME = /^RUN(?:_[A-Z0-9-]+)?$/u;

export type CoreLogSlot = "system" | "install" | "dev" | "candidate" | "emergency" | "custom";

export type CoreLogPaths = {
  slot: CoreLogSlot;
  root: string;
  displayRoot: string;
  logFile: string;
  errorFile: string;
};

type Environment = Record<string, string | undefined>;

function nonEmpty(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function safeAbsolute(value: string | null, fallback: string): string {
  const selected = value || fallback;
  if (selected.includes("\u0000")) {
    throw new Error("CORE_LOG_ROOT_INVALID");
  }
  return path.resolve(selected);
}

function productRoot(environment: Environment, currentDirectory: string): string {
  return safeAbsolute(
    nonEmpty(environment.BONNI_PRODUCT_ROOT)
      || nonEmpty(environment.BONNI_PROJECT_ROOT),
    path.resolve(currentDirectory, "../.."),
  );
}

function roleOf(environment: Environment): string {
  return String(
    environment.SYSTEM_SLOT_ROLE
      || environment.BONNI_PROGRAM_SLOT_ROLE
      || "active",
  ).trim().toLowerCase();
}

function configuredRunRoot(environment: Environment, names: string[], fallback: string): string {
  for (const name of names) {
    const value = nonEmpty(environment[name]);
    if (value) return safeAbsolute(value, fallback);
  }
  return safeAbsolute(null, fallback);
}

function derivedRunSystemRoot(environment: Environment, root: string): string {
  const configured = nonEmpty(environment.BONNI_RUN_SYSTEM_ROOT);
  if (configured) return safeAbsolute(configured, root);

  const runtimeState = nonEmpty(environment.BONNI_RUNTIME_STATE_ROOT)
    || nonEmpty(environment.RUN_SYSTEM_ROOT);
  if (runtimeState) {
    const resolved = safeAbsolute(runtimeState, root);
    const base = path.basename(resolved).toLowerCase();
    if (["runtime", "system", "storage", "archiv"].includes(base)) {
      const parent = path.dirname(resolved);
      if (RUN_ROOT_NAME.test(path.basename(parent).toUpperCase())) return parent;
    }
    return resolved;
  }

  return root;
}

function displayRoot(root: string, product: string): string {
  const relative = path.relative(product, root).split(path.sep).join("/");
  if (relative && !relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative)) {
    return relative;
  }
  return "custom";
}

/**
 * Core diagnostics never defaults into SYSTEM or into Bonni-Windows paths.
 * A launcher may still provide BONNI_LOG_ROOT for a deliberately isolated
 * runtime, but the normal locations are RUN_SYSTEM, RUN_INSTALL and RUN_DEV.
 */
export function resolveCoreLogPaths({
  environment = process.env,
  currentDirectory = process.cwd(),
}: {
  environment?: Environment;
  currentDirectory?: string;
} = {}): CoreLogPaths {
  const product = productRoot(environment, currentDirectory);
  const explicit = nonEmpty(environment.BONNI_LOG_ROOT);
  const role = roleOf(environment);

  let slot: CoreLogSlot = "system";
  let root: string;

  if (explicit) {
    slot = "custom";
    // BONNI_LOG_ROOT is the complete directory for the two Core files. This
    // keeps explicit launcher/container paths usable without appending a
    // second LOGS/CORE segment.
    root = safeAbsolute(explicit, product);
  } else if (role === "installer" || role === "install") {
    slot = "install";
    const baseRoot = configuredRunRoot(
      environment,
      ["BONNI_RUN_INSTALL_ROOT", "RUN_INSTALL_ROOT"],
      path.join(product, "RUN_INSTALL"),
    );
    root = path.join(baseRoot, "LOGS", "CORE");
  } else if (
    role === "candidate"
    && environment.SYSTEM_UPDATE_PROBE_MODE === "true"
    && (nonEmpty(environment.BONNI_RUNTIME_STATE_ROOT) || nonEmpty(environment.RUN_SYSTEM_ROOT))
  ) {
    slot = "candidate";
    const baseRoot = safeAbsolute(
      nonEmpty(environment.BONNI_RUNTIME_STATE_ROOT)
        || nonEmpty(environment.RUN_SYSTEM_ROOT),
      path.join(product, "RUN_DEV"),
    );
    root = path.join(baseRoot, "LOGS", "CORE");
  } else if (
    role === "dev"
    || String(environment.NODE_ENV || "").toLowerCase() === "development"
    || String(environment.npm_lifecycle_event || "").toLowerCase() === "dev"
  ) {
    slot = "dev";
    const baseRoot = configuredRunRoot(
      environment,
      ["BONNI_RUN_DEV_ROOT", "RUN_DEV_ROOT"],
      path.join(product, "RUN_DEV"),
    );
    root = path.join(baseRoot, "LOGS", "CORE");
  } else if (role === "emergency") {
    slot = "emergency";
    const baseRoot = derivedRunSystemRoot(environment, path.join(product, "RUN_SYSTEM"));
    root = path.join(baseRoot, "LOGS", "CORE");
  } else {
    const baseRoot = derivedRunSystemRoot(environment, path.join(product, "RUN_SYSTEM"));
    root = path.join(baseRoot, "LOGS", "CORE");
  }

  return {
    slot,
    root,
    displayRoot: displayRoot(root, product),
    logFile: path.join(root, CORE_LOG_FILE_NAME),
    errorFile: path.join(root, CORE_ERROR_FILE_NAME),
  };
}

function assertNoSymlinkComponents(target: string) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let state: fs.Stats;
    try {
      state = fs.lstatSync(cursor);
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (state.isSymbolicLink()) throw new Error("CORE_LOG_ROOT_SYMLINK_FORBIDDEN");
  }
}

export function ensureCoreLogDirectory(paths: CoreLogPaths) {
  assertNoSymlinkComponents(path.dirname(paths.root));
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(paths.root);
  const state = fs.lstatSync(paths.root);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("CORE_LOG_ROOT_UNSAFE");
  if (process.platform !== "win32") fs.chmodSync(paths.root, 0o700);
}

export function cleanCoreLogFiles(paths: CoreLogPaths) {
  for (const file of [paths.logFile, paths.errorFile]) {
    for (let generation = 0; generation < CORE_LOG_RETENTION_COUNT; generation++) {
      cleanPrivateLogFile(file + (generation ? `.${generation}` : ""));
    }
  }
}

export function pruneCoreLogFiles(paths: CoreLogPaths, now = Date.now()) {
  for (const file of [paths.logFile, paths.errorFile]) {
    for (let generation = 0; generation < CORE_LOG_RETENTION_COUNT; generation++) {
      const target = file + (generation ? `.${generation}` : "");
      try {
        assertNoSymlinkComponents(target);
        const state = fs.lstatSync(target);
        if (!state.isFile() || state.nlink !== 1) throw new Error("CORE_LOG_FILE_UNSAFE");
        if (now - state.mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(target);
      } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
  }
}

function logFileAge(state: fs.Stats, now: number) {
  return now - Math.min(state.mtimeMs, state.birthtimeMs > 0 ? state.birthtimeMs : state.mtimeMs);
}

function archiveName(file: string, index: number): string {
  return `${file}.${index}`;
}

function removeIfPresent(file: string) {
  try {
    fs.unlinkSync(file);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function rotateOne(file: string) {
  let state: fs.Stats;
  try {
    state = fs.lstatSync(file);
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
    throw new Error("CORE_LOG_FILE_UNSAFE");
  }
  if (state.size === 0) return false;

  removeIfPresent(archiveName(file, CORE_LOG_RETENTION_COUNT - 1));
  for (let index = CORE_LOG_RETENTION_COUNT - 2; index >= 1; index -= 1) {
    const source = archiveName(file, index);
    const target = archiveName(file, index + 1);
    try {
      fs.renameSync(source, target);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  fs.renameSync(file, archiveName(file, 1));
  return true;
}

export function rotateCoreLogFiles(
  paths: CoreLogPaths,
  { force = false, now = Date.now() }: { force?: boolean; now?: number } = {},
) {
  ensureCoreLogDirectory(paths);
  const files = [paths.logFile, paths.errorFile];
  const due = force || files.some((file) => {
    try {
      return logFileAge(fs.statSync(file), now) >= CORE_LOG_ROTATION_INTERVAL_MS;
    } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  });
  if (!due) return false;
  return files.map((file) => rotateOne(file)).some(Boolean);
}

export function coreLogRotationDue(paths: CoreLogPaths, now = Date.now()) {
  return [paths.logFile, paths.errorFile].some((file) => {
    try {
      return logFileAge(fs.statSync(file), now) >= CORE_LOG_ROTATION_INTERVAL_MS;
    } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  });
}

async function readLimited(file: string, maxBytes = MAX_READ_BYTES): Promise<{ text: string; sizeBytes: number; truncated: boolean }> {
  let handle: fsp.FileHandle | undefined;
  try {
    assertNoSymlinkComponents(file);
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const state = await handle.stat();
    if (!state.isFile() || state.nlink !== 1) throw new Error("CORE_LOG_FILE_UNSAFE");
    const size = Math.min(state.size, maxBytes);
    const content = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const result = await handle.read(content, read, size - read, state.size - size + read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    const bytes = content.subarray(0, read);
    let text = bytes.toString("utf8");
    if (state.size > maxBytes) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
    }
    return { text, sizeBytes: state.size, truncated: state.size > maxBytes };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { text: "", sizeBytes: 0, truncated: false };
    throw error;
  } finally { await handle?.close(); }
}

export type CoreErrorBlock = {
  timestamp: string;
  contextLines: string[];
  errorLines: string[];
  afterContextLines: string[];
  raw: string;
  critical: boolean;
};

const ERROR_RULE = /^—{3,}-?$/u;
const ERROR_LINE = /^\[(CRITICAL )?ERROR\]/u;

export function parseCoreErrorBlocks(text: string): CoreErrorBlock[] {
  const lines = String(text || "").split(/\r?\n/u);
  const blocks: CoreErrorBlock[] = [];
  const byId = new Map<string, CoreErrorBlock>();
  let index = 0;

  while (index < lines.length) {
    const after = /^\[NACHLAUF:([a-f0-9-]{36})\] (.*)$/u.exec(lines[index]);
    if (after) {
      const block = byId.get(after[1]);
      if (block && block.afterContextLines.length < 5) {
        block.afterContextLines.push(after[2]);
        block.raw += "\n" + lines[index];
      }
      index++; continue;
    }
    if (!lines[index].startsWith("= ")) {
      index += 1;
      continue;
    }
    const start = index;
    const timestamp = lines[index].slice(2).trim();
    index += 1;
    if (!ERROR_RULE.test(lines[index] || "")) continue;
    index += 1;
    const contentStart = index;
    while (index < lines.length && !ERROR_RULE.test(lines[index])) index += 1;
    if (index >= lines.length) break;
    const content = lines.slice(contentStart, index);
    const errorIndex = content.findIndex((line) => ERROR_LINE.test(line));
    const contextLines = (errorIndex >= 0 ? content.slice(0, errorIndex) : content)
      .filter((line, lineIndex, values) => !(line === "" && lineIndex === values.length - 1));
    const errorLines = errorIndex >= 0 ? content.slice(errorIndex).filter(Boolean) : [];
    const raw = lines.slice(start, index + 1).join("\n");
    const block: CoreErrorBlock = {
      timestamp,
      contextLines,
      errorLines,
      afterContextLines: [],
      raw,
      critical: errorLines.some((line) => line.startsWith("[CRITICAL ERROR]")),
    };
    blocks.push(block);
    const id = errorLines.find(line => line.startsWith("[DIAGNOSE-ID] "))?.slice(14);
    if (id) byId.set(id, block);
    index += 1;
  }

  return blocks;
}

export async function readCoreLogSnapshot({
  paths = resolveCoreLogPaths(),
  limit = 500,
}: {
  paths?: CoreLogPaths;
  limit?: number;
} = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 500, 20), 2_000);
  cleanCoreLogFiles(paths);
  const [log, errors] = await Promise.all([
    readLimited(paths.logFile),
    readLimited(paths.errorFile),
  ]);
  const logLines = sanitizeDiagnosticExport(log.text).split(/\r?\n/u).filter((line) => line.length > 0).slice(-boundedLimit);
  const errorBlocks = parseCoreErrorBlocks(sanitizeDiagnosticExport(errors.text)).slice(-Math.min(boundedLimit, 200));

  return {
    ok: true,
    slot: paths.slot,
    root: paths.slot,
    files: {
      log: CORE_LOG_FILE_NAME,
      errors: CORE_ERROR_FILE_NAME,
    },
    logLines,
    errorBlocks,
    counts: {
      logLines: logLines.length,
      errors: errorBlocks.length,
    },
    sizes: {
      logBytes: log.sizeBytes,
      errorBytes: errors.sizeBytes,
    },
  };
}

export async function readCoreLiveLog(paths = resolveCoreLogPaths()) {
  const { text } = await readLimited(paths.logFile, 192 * 1024);
  const logLines = sanitizeDiagnosticExport(text)
    .split(/\r?\n/u)
    .filter(Boolean)
    .slice(-400);
  return { logLines };
}

const diagnosticRecordHeader = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (CRITICAL|ERROR|WARN|INFO|DEBUG) (.*)$/u;

function findDiagnosticRecord(text: string, id: string, field: "errorId" | "requestId") {
  if (!text.includes(id)) return undefined;
  const lines = text.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index--) {
    const raw = lines[index];
    if (!raw.includes(id)) continue;
    // An archived error block can carry the response as a follow-up line.
    const line = sanitizeDiagnosticExport(raw.replace(/^\[NACHLAUF:[a-f0-9-]{36}\] /u, ""));
    const metadataStart = line.indexOf(" {");
    if (metadataStart < 0) continue;
    const header = diagnosticRecordHeader.exec(line.slice(0, metadataStart));
    if (!header) continue;
    const [, level, message] = header;
    if (field === "errorId" && level !== "ERROR" && level !== "CRITICAL") continue;
    if (field === "requestId" && message !== "HTTP request") continue;
    try {
      const metadata = JSON.parse(line.slice(metadataStart + 1));
      if (metadata?.[field] !== id) continue;
      const requestId = typeof metadata.requestId === "string" ? metadata.requestId : undefined;
      return { line, requestId };
    } catch { /* An incomplete or foreign line is not a diagnostic record. */ }
  }
}

export async function readCoreDiagnosticError(errorId: string, paths = resolveCoreLogPaths()) {
  for (const file of [paths.logFile, paths.errorFile]) {
    for (let generation = 0; generation < CORE_LOG_RETENTION_COUNT; generation++) {
      const source = generation ? archiveName(file, generation) : file;
      const { text } = await readLimited(source);
      const error = findDiagnosticRecord(text, errorId, "errorId");
      if (!error) continue;
      const response = error.requestId ? findDiagnosticRecord(text, error.requestId, "requestId") : undefined;
      return { line: error.line, responseLine: response?.line };
    }
  }
  return null;
}

export async function readCoreLogFile(
  stream: "log" | "error",
  paths = resolveCoreLogPaths(),
) {
  const file = stream === "error" ? paths.errorFile : paths.logFile;
  cleanCoreLogFiles(paths);
  const sections = [];
  // Three bounded generations, oldest first. A startup rotation must not hide
  // the preceding failure; the current runtime header is explicitly labelled.
  for (let generation = CORE_LOG_RETENTION_COUNT - 1; generation >= 0; generation--) {
    const suffix = generation ? `.${generation}` : "";
    const entry = await readLimited(file + suffix, 2 * 1024 * 1024);
    if (entry.sizeBytes) sections.push(`# Datei: ${path.basename(file)}${suffix}; Bytes: ${entry.sizeBytes}; Ausschnitt: ${entry.truncated}\n${sanitizeDiagnosticExport(entry.text)}`);
  }
  return [
    "# Bonni Core Diagnoseexport v2",
    `# Exportiert: ${new Date().toISOString()}; Stream: ${stream}`,
    "# Aktueller Prozess (kann von archivierten Sitzungen abweichen):",
    "# " + JSON.stringify(privateValue(getDiagnosticRuntime())),
    "# Nur technische Fehlerdaten mit bis zu fünf Ausgaben davor und danach. Höchstens 24 Stunden, drei Generationen. Kein Rohprotokoll.",
    ...sections,
  ].join("\n\n") + "\n";
}
