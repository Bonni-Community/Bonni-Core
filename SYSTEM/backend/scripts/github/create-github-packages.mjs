#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SYSTEM_ROOT = path.resolve(SCRIPT_DIRECTORY, "../../..");
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
const SIGNATURE_DIRECTORY_NAME = "signatur";

const COMPONENTS = Object.freeze({
  core: Object.freeze({
    key: "core",
    label: "Bonni Core",
    directory: ".",
    requiredDirectories: ["backend", "frontend"],
    include: ["backend", "frontend"],
    archiveBase: "core",
  }),
  kontor: Object.freeze({
    key: "kontor",
    label: "KontorApp",
    directory: "app/kontorapp",
    requiredDirectories: ["backend", "frontend"],
    include: ["."],
    archiveBase: "kontor",
  }),
  stueberl: Object.freeze({
    key: "stueberl",
    label: "StueberlApp",
    directory: "app/stueberlapp",
    requiredDirectories: ["backend", "frontend"],
    include: ["."],
    archiveBase: "stueberl",
  }),
  hocket: Object.freeze({
    key: "hocket",
    label: "HocketApp",
    directory: "app/hocketapp",
    requiredDirectories: ["backend", "frontend"],
    include: ["."],
    archiveBase: "hocket",
  }),
});

const ALIASES = new Map([
  ["core", "core"],
  ["bonni", "core"],
  ["bonni-core", "core"],
  ["kontor", "kontor"],
  ["kontorapp", "kontor"],
  ["stueberl", "stueberl"],
  ["stüberl", "stueberl"],
  ["stueberlapp", "stueberl"],
  ["stüberlapp", "stueberl"],
  ["hocket", "hocket"],
  ["hocketapp", "hocket"],
]);

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".cache",
  ".idea",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".svelte-kit",
  ".turbo",
  ".vite",
  ".vscode",
  "build",
  "cache",
  "coverage",
  "dist",
  "node_modules",
]);

const PROTECTED_RUNTIME_ROOTS = [
  "archives",
  "backups",
  "data",
  "keys",
  "logs",
  "run_system",
  "runtime-data",
  "secrets",
  "storage",
  "temp",
  "tmp",
  "uploads",
  "backend/archives",
  "backend/backups",
  "backend/data",
  "backend/keys",
  "backend/logs",
  "backend/run_system",
  "backend/runtime-data",
  "backend/secrets",
  "backend/storage",
  "backend/temp",
  "backend/tmp",
  "backend/uploads",
  "backend/updates",
  "backend/config/keys",
  "backend/config/secrets",
  "backend/config/update/keys",
  "backend/config/update/trusted-keys",
  "frontend/uploads",
  "frontend/public/uploads",
];

const SECRET_FILE_PATTERN = /(?:^|[._-])private[._-]?key(?:[._-]|$)|\.(?:key|jwk|p12|pfx)$/iu;
const DATABASE_FILE_PATTERN = /\.(?:db|sqlite|sqlite3)(?:-(?:journal|wal|shm))?$/iu;
const SENSITIVE_ARTIFACT_EXTENSION_PATTERN = /\.(?:jwk|key|kdbx|keystore|p12|pem|pfx|pkcs8)$/iu;
const PRIVATE_KEY_PEM_MARKER_PATTERN = /(?:^|\r?\n)[\t ]*-----BEGIN (?:(?:[A-Z0-9]+ )*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\t ]*(?:\r?\n|$)/mu;

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function windowsPathKey(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function posixPath(value) {
  return value.split(path.sep).join("/");
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function visibleArtifactVersion(value) {
  return String(value).replace(/^(\d+\.\d+\.\d+)\+([A-Za-z])$/u, "$1$2");
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertSafeArchivePath(value) {
  if (
    typeof value !== "string"
    || !value
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || value.includes("\\")
    || value.includes(":")
    || /[<>"|?*\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Unsicherer Archivpfad: ${String(value)}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => (
    !segment
    || segment === "."
    || segment === ".."
    || /[. ]$/u.test(segment)
    || WINDOWS_RESERVED_NAME.test(segment)
  ))) {
    throw new Error(`Nicht unter Windows nutzbarer Archivpfad: ${value}`);
  }
  if (Buffer.byteLength(value, "utf8") > 65_535) {
    throw new Error(`Archivpfad ist zu lang: ${value}`);
  }
  return value;
}

function shouldExclude(relativePath, isDirectory) {
  const normalized = posixPath(relativePath);
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) || "";
  const lowerSegments = segments.map((segment) => windowsPathKey(segment));
  const lowerBasename = lowerSegments.at(-1) || "";

  if (lowerBasename.startsWith(".env") && lowerBasename !== ".env.example") return true;
  if (DATABASE_FILE_PATTERN.test(lowerBasename) || SECRET_FILE_PATTERN.test(lowerBasename)) return true;
  if (["credentials.json", "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa", "npm-debug.log", "secret.json", "secrets.json"].includes(lowerBasename)) return true;
  if (lowerBasename.endsWith(".log") || lowerBasename.endsWith(".tmp")) return true;
  if (lowerSegments.includes(SIGNATURE_DIRECTORY_NAME)) return true;
  if (lowerSegments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return true;
  if (lowerSegments.join("/").includes("prisma/domains/assembled")) return true;
  const lowerPath = lowerSegments.join("/");
  if (PROTECTED_RUNTIME_ROOTS.some((root) => lowerPath === root || lowerPath.startsWith(`${root}/`))) return true;
  if (isDirectory && ["github", "update", "repair"].includes(lowerBasename) && segments.length === 1) return true;
  return false;
}

async function readPackageVersion(packageFile, label) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(packageFile, "utf8"));
  } catch (error) {
    throw new Error(`${label}: package.json fehlt oder ist ungueltig (${error.message}).`);
  }
  if (!VERSION_PATTERN.test(String(parsed?.version || ""))) {
    throw new Error(`${label}: ungueltige Version in ${packageFile}.`);
  }
  return parsed.version;
}

async function componentState(systemRoot, definition) {
  const componentRoot = path.resolve(systemRoot, definition.directory);
  const relative = path.relative(path.resolve(systemRoot), componentRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${definition.label}: Quellpfad liegt ausserhalb von SYSTEM.`);
  }
  const rootState = await lstatOrNull(componentRoot);
  if (!rootState) return { exists: false, componentRoot };
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw new Error(`${definition.label}: Quellordner ist kein sicherer realer Ordner.`);
  }
  for (const directory of definition.requiredDirectories) {
    const required = path.join(componentRoot, directory);
    const requiredState = await lstatOrNull(required);
    if (!requiredState?.isDirectory() || requiredState.isSymbolicLink()) {
      throw new Error(`${definition.label}: Pflichtordner fehlt oder ist unsicher: ${directory}`);
    }
  }

  let version;
  if (definition.key === "core") {
    const backendVersion = await readPackageVersion(path.join(componentRoot, "backend", "package.json"), "Bonni Core Backend");
    const frontendVersion = await readPackageVersion(path.join(componentRoot, "frontend", "package.json"), "Bonni Core Frontend");
    if (backendVersion !== frontendVersion) {
      throw new Error(`Bonni Core: Backend ${backendVersion} und Frontend ${frontendVersion} haben unterschiedliche Versionen.`);
    }
    version = backendVersion;
  } else {
    version = await readPackageVersion(path.join(componentRoot, "package.json"), definition.label);
  }
  return { exists: true, componentRoot, version };
}

async function collectComponentFiles(definition, componentRoot, version) {
  const files = [];
  const usedArchivePaths = new Map();
  let totalBytes = 0;
  const rootFolder = `${definition.archiveBase}-${version}`;

  async function addFile(absolutePath, relativePath) {
    if (shouldExclude(relativePath, false)) return;
    const state = await fs.lstat(absolutePath);
    if (state.isSymbolicLink()) throw new Error(`${definition.label}: symbolischer Link nicht erlaubt: ${relativePath}`);
    if (!state.isFile()) throw new Error(`${definition.label}: spezielle Datei nicht erlaubt: ${relativePath}`);
    if (state.nlink > 1) throw new Error(`${definition.label}: Hardlink nicht erlaubt: ${relativePath}`);
    if (state.size > MAX_FILE_BYTES) throw new Error(`${definition.label}: Datei ist groesser als 64 MB: ${relativePath}`);

    const normalizedRelativePath = assertSafeArchivePath(posixPath(relativePath));
    const archivePath = assertSafeArchivePath(`${rootFolder}/${normalizedRelativePath}`);
    const collisionKey = windowsPathKey(archivePath);
    if (usedArchivePaths.has(collisionKey)) {
      throw new Error(`${definition.label}: Pfadkollision zwischen ${usedArchivePaths.get(collisionKey)} und ${archivePath}.`);
    }
    usedArchivePaths.set(collisionKey, archivePath);
    totalBytes += state.size;
    if (files.length + 1 > MAX_FILES) throw new Error(`${definition.label}: mehr als ${MAX_FILES} Dateien.`);
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`${definition.label}: Quelldaten sind groesser als 512 MB.`);
    files.push({ absolutePath, archivePath, sizeBytes: state.size });
  }

  async function walk(absoluteDirectory, relativeDirectory) {
    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      if (shouldExclude(relativePath, entry.isDirectory())) continue;
      const state = await fs.lstat(absolutePath);
      if (state.isSymbolicLink()) throw new Error(`${definition.label}: symbolischer Link nicht erlaubt: ${relativePath}`);
      if (state.isDirectory()) await walk(absolutePath, relativePath);
      else await addFile(absolutePath, relativePath);
    }
  }

  for (const includePath of definition.include) {
    const absolutePath = path.resolve(componentRoot, includePath);
    const relativeToRoot = path.relative(componentRoot, absolutePath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw new Error(`${definition.label}: ungueltiger Include-Pfad: ${includePath}`);
    }
    const state = await lstatOrNull(absolutePath);
    if (!state) continue;
    if (state.isSymbolicLink()) throw new Error(`${definition.label}: symbolischer Link nicht erlaubt: ${includePath}`);
    if (state.isDirectory()) await walk(absolutePath, includePath === "." ? "" : includePath);
    else if (state.isFile()) await addFile(absolutePath, includePath);
    else throw new Error(`${definition.label}: spezieller Include-Pfad nicht erlaubt: ${includePath}`);
  }
  files.sort((left, right) => bytewiseCompare(left.archivePath, right.archivePath));
  if (!files.length) throw new Error(`${definition.label}: keine veroeffentlichbaren Quelldateien gefunden.`);
  return { files, rootFolder, totalBytes };
}

let crcTable;
function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader({ nameBytes, checksum, compressedSize, sizeBytes }) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(33, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(sizeBytes, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader({ nameBytes, checksum, compressedSize, sizeBytes, offset }) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(33, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(sizeBytes, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

function endRecord(entryCount, centralSize, centralOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

function assertSafeArtifactEntry(label, archivePath, data) {
  const basename = archivePath.split("/").at(-1) || "";
  if (SENSITIVE_ARTIFACT_EXTENSION_PATTERN.test(basename)) {
    throw new Error(`${label}: sensibles Schluesseldateiformat im fertigen ZIP: ${archivePath}`);
  }
  if (PRIVATE_KEY_PEM_MARKER_PATTERN.test(data.toString("utf8"))) {
    throw new Error(`${label}: privater Schluesselmarker im fertigen ZIP: ${archivePath}`);
  }
}

async function buildDeterministicZip(files, label) {
  if (files.length > 65_535) throw new Error("ZIP64 wird nicht unterstuetzt: zu viele Dateien.");
  const localParts = [];
  const centralEntries = [];
  let offset = 0;
  for (const file of files) {
    const data = await fs.readFile(file.absolutePath);
    if (data.length !== file.sizeBytes) throw new Error(`Quelldatei wurde waehrend des Packens veraendert: ${file.archivePath}`);
    // Diese Pruefung arbeitet auf den exakten Pfaden und Bytes, die direkt
    // danach in das fertige Artefakt geschrieben werden. Ein Schluesselfund
    // ist deshalb kein stiller Ausschluss, sondern bricht den gesamten Lauf ab.
    assertSafeArtifactEntry(label, file.archivePath, data);
    const compressed = deflateRawSync(data, { level: 9 });
    const nameBytes = Buffer.from(file.archivePath, "utf8");
    const entry = { nameBytes, checksum: crc32(data), compressedSize: compressed.length, sizeBytes: data.length, offset };
    const header = localHeader(entry);
    localParts.push(header, nameBytes, compressed);
    centralEntries.push(entry);
    offset += header.length + nameBytes.length + compressed.length;
    if (offset > MAX_ZIP_BYTES) throw new Error("Komprimiertes ZIP ist groesser als 1 GB.");
  }
  const centralOffset = offset;
  const centralParts = [];
  for (const entry of centralEntries) {
    const header = centralHeader(entry);
    centralParts.push(header, entry.nameBytes);
    offset += header.length + entry.nameBytes.length;
  }
  const centralSize = offset - centralOffset;
  const result = Buffer.concat([...localParts, ...centralParts, endRecord(files.length, centralSize, centralOffset)]);
  if (result.length > MAX_ZIP_BYTES) throw new Error("Komprimiertes ZIP ist groesser als 1 GB.");
  return result;
}

async function writeAtomic(file, data) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, data, { flag: "wx" });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
    const existing = await fs.readFile(file).catch(() => null);
    if (existing && Buffer.compare(existing, data) === 0) {
      await fs.rm(temporary, { force: true });
      return;
    }
    const backup = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.previous.tmp`);
    await fs.rename(file, backup);
    try {
      await fs.rename(temporary, file);
    } catch (replacementError) {
      await fs.rename(backup, file).catch(() => {});
      throw replacementError;
    }
    await fs.rm(backup, { force: true });
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readPreviouslyOwnedArchives(outputRoot) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(outputRoot, "github-packages.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return new Map();
    throw error;
  }
  if (
    manifest?.schemaVersion !== 1
    || manifest?.status !== "LOCAL_GITHUB_ARTIFACTS"
    || manifest?.published !== false
    || !Array.isArray(manifest.packages)
  ) {
    return new Map();
  }
  const owned = new Map();
  for (const entry of manifest.packages) {
    const definition = COMPONENTS[entry?.component];
    const version = String(entry?.version || "");
    const expectedArchives = definition && VERSION_PATTERN.test(version)
      ? new Set([
        `${definition.archiveBase}-${visibleArtifactVersion(version)}.zip`,
        `${definition.archiveBase}-${version}.zip`,
      ])
      : null;
    if (
      !expectedArchives
      || !expectedArchives.has(entry.archive)
      || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(entry.sha256)
      || owned.has(entry.archive)
    ) {
      return new Map();
    }
    owned.set(entry.archive, entry.sha256);
  }
  return owned;
}

async function removeStaleOwnedArchives(outputRoot, previouslyOwned, currentArchives) {
  const removed = [];
  const preserved = [];
  for (const [archive, expectedSha256] of previouslyOwned) {
    if (currentArchives.has(archive)) continue;
    const target = path.join(outputRoot, archive);
    const state = await lstatOrNull(target);
    if (!state) continue;
    if (!state.isFile() || state.isSymbolicLink() || state.nlink > 1) {
      preserved.push(archive);
      continue;
    }
    if (await sha256File(target) !== expectedSha256) {
      preserved.push(archive);
      continue;
    }
    await fs.rm(target);
    removed.push(archive);
  }
  return { removed, preserved };
}

export function parseArguments(argumentsList) {
  const requested = [];
  let dryRun = false;
  let help = false;
  for (const rawArgument of argumentsList) {
    const argument = String(rawArgument || "").trim();
    if (!argument) continue;
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unbekannte Option: ${argument}`);
    const normalized = argument.toLocaleLowerCase("de-DE");
    if (normalized === "all" || normalized === "alle") {
      requested.push(...Object.keys(COMPONENTS));
      continue;
    }
    const key = ALIASES.get(normalized);
    if (!key) throw new Error(`Unbekannte Komponente: ${argument}. Erlaubt sind core, kontor, stueberl und hocket.`);
    requested.push(key);
  }
  const selected = [...new Set(requested.length ? requested : Object.keys(COMPONENTS))];
  return { selected, dryRun, help };
}

export function helpText() {
  return [
    "Lokale GitHub-Pakete fuer Bonni erstellen",
    "",
    "Verwendung:",
    "  npm run github -- core kontor stueberl hocket",
    "  npm run github -- all",
    "  npm run github -- --dry-run core kontor",
    "",
    "Komponenten: core, kontor, stueberl, hocket",
    "Optionen:     --dry-run  Nur pruefen, nichts schreiben",
    "              --help     Diese Hilfe anzeigen",
    "",
    "Ausgabe: ../../GITHUB (direkt neben SYSTEM)",
    "Der Befehl erstellt nur lokale ZIP-Dateien und veroeffentlicht nichts.",
    "Hinweis: npm-Skripte verwenden die Form 'npm run github -- ...'.",
  ].join("\n");
}

export async function createGitHubPackages({
  systemRoot = DEFAULT_SYSTEM_ROOT,
  outputRoot = path.resolve(systemRoot, "../GITHUB"),
  selected = Object.keys(COMPONENTS),
  dryRun = false,
} = {}) {
  const resolvedSystemRoot = path.resolve(systemRoot);
  const systemState = await lstatOrNull(resolvedSystemRoot);
  if (!systemState?.isDirectory() || systemState.isSymbolicLink()) throw new Error("SYSTEM-Quellordner fehlt oder ist unsicher.");
  const resolvedOutputRoot = path.resolve(outputRoot);
  const outputRelative = path.relative(resolvedSystemRoot, resolvedOutputRoot);
  if (outputRelative === "" || (!outputRelative.startsWith("..") && !path.isAbsolute(outputRelative))) {
    throw new Error("GITHUB muss ausserhalb des SYSTEM-Quellordners liegen.");
  }

  const normalizedSelection = [];
  for (const key of selected) {
    if (!COMPONENTS[key]) throw new Error(`Unbekannte Komponente: ${key}`);
    if (!normalizedSelection.includes(key)) normalizedSelection.push(key);
  }
  if (!normalizedSelection.length) throw new Error("Keine Komponente ausgewaehlt.");

  const previouslyOwned = dryRun ? new Map() : await readPreviouslyOwnedArchives(resolvedOutputRoot);
  const packages = [];
  const missing = [];
  const pendingArtifacts = [];
  for (const key of normalizedSelection) {
    const definition = COMPONENTS[key];
    const state = await componentState(resolvedSystemRoot, definition);
    if (!state.exists) {
      missing.push({ component: key, label: definition.label, expectedPath: posixPath(path.relative(path.dirname(resolvedSystemRoot), state.componentRoot)) });
      continue;
    }
    const artifactVersion = visibleArtifactVersion(state.version);
    const collected = await collectComponentFiles(definition, state.componentRoot, artifactVersion);
    const archiveName = `${definition.archiveBase}-${artifactVersion}.zip`;
    const result = {
      component: key,
      label: definition.label,
      version: state.version,
      archive: archiveName,
      rootFolder: collected.rootFolder,
      fileCount: collected.files.length,
      uncompressedBytes: collected.totalBytes,
    };
    if (!dryRun) {
      const zip = await buildDeterministicZip(collected.files, definition.label);
      result.sizeBytes = zip.length;
      result.sha256 = sha256(zip);
      pendingArtifacts.push({ archiveName, zip });
    }
    packages.push(result);
  }
  if (!packages.length) throw new Error("Keine der ausgewaehlten Komponenten ist vorhanden.");

  const manifest = {
    schemaVersion: 1,
    status: "LOCAL_GITHUB_ARTIFACTS",
    published: false,
    packages,
    missing,
  };
  let cleanup = { removed: [], preserved: [] };
  if (!dryRun) {
    // Erst schreiben, nachdem alle ausgewaehlten Komponenten erfolgreich
    // gebaut und auf sensible Inhalte geprueft wurden. So bleibt bei einem
    // Schluesselfund kein Teilpaket aus demselben Lauf zurueck.
    for (const artifact of pendingArtifacts) {
      await writeAtomic(path.join(resolvedOutputRoot, artifact.archiveName), artifact.zip);
    }
    cleanup = await removeStaleOwnedArchives(
      resolvedOutputRoot,
      previouslyOwned,
      new Set(packages.map((entry) => entry.archive)),
    );
    await writeAtomic(path.join(resolvedOutputRoot, "github-packages.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  }
  return { outputRoot: resolvedOutputRoot, packages, missing, dryRun, manifest, cleanup };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    console.info(helpText());
    return;
  }
  const result = await createGitHubPackages(parsed);
  console.info(result.dryRun ? "[github] Pruefung erfolgreich; es wurden keine Dateien geschrieben." : `[github] Fertig: ${result.outputRoot}`);
  for (const entry of result.packages) {
    const details = result.dryRun
      ? `${entry.fileCount} Dateien, Version ${entry.version}`
      : `${entry.archive} | ${entry.fileCount} Dateien | SHA-256 ${entry.sha256}`;
    console.info(`[github] OK      ${entry.label}: ${details}`);
  }
  for (const entry of result.missing) console.warn(`[github] FEHLT   ${entry.label}: ${entry.expectedPath} (uebersprungen)`);
  for (const archive of result.cleanup.removed) console.info(`[github] ENTFERNT veraltetes Paket: ${archive}`);
  for (const archive of result.cleanup.preserved) console.warn(`[github] BEHALTEN veraendertes altes Paket: ${archive}`);
  console.info("[github] Es wurde nichts hochgeladen und kein Git-Tag erstellt.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[github] Erstellung fehlgeschlagen: ${error.message}`);
    process.exitCode = 1;
  });
}
