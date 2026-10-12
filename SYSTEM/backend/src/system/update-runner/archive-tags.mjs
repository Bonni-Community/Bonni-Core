import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_LIST_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TAR_BLOCK_BYTES = 512;
const MAX_TAR_METADATA_BYTES = 1024 * 1024;
const MAX_CORE_JSON_BYTES = 4 * 1024 * 1024;
const MAX_OUTER_TAR_ENTRIES = 20_000;
const CORE_EMPTY_RUNTIME_ROOTS = Object.freeze([
  "app/app",
  "app/apps",
  "app/addons",
  "app/plugins",
  "app/bridges",
]);
const CORE_FORBIDDEN_ROOTS = Object.freeze([
  ...CORE_EMPTY_RUNTIME_ROOTS,
  "app/add-on",
  "app/addon",
  "app/plug-in",
  "app/plugin",
  "app/bridge",
]);
const CORE_ALLOWED_APP_ROOTS = new Set([
  "addons",
  "app",
  "apps",
  "backend",
  "bridges",
  "licenses",
  "license-predecessors",
  "node_modules",
  "plugins",
  "public",
  "run_system",
]);
const PRIVATE_KEY_FILE_PATTERN = /^(?:id_(?:dsa|ecdsa|ed25519|ed25519_sk|rsa)(?:\.pem)?)$|(?:^|[._-])(?:private[._-]?key|privkey|release[._-]?private)(?:[._-]|$)|\.(?:jks|jwk|key|kdbx|keystore|p12|pfx|pk8|pkcs8)$/iu;
const PRIVATE_KEY_MARKER_PATTERN = /(?:^|\r?\n)[\t ]*-----BEGIN (?:(?:[A-Z0-9]+ )*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\t ]*(?:\r?\n)/mu;
const SAFE_CORE_LICENSE_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u;
const REQUIRED_CORE_LICENSE_PREDECESSORS = new Map([
  ["0.1.20+a", "0.1.20"],
  ["0.1.20+c", "0.1.20"],
  ["0.1.20+d", "0.1.20"],
  ["0.1.20+e", "0.1.20"],
]);

function runBounded(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let settled = false;
    const terminate = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > Number(options.maxStdoutBytes || MAX_LIST_BYTES)) {
        overflow = true;
        terminate();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > Number(options.maxStderrBytes || MAX_STDERR_BYTES)) {
        overflow = true;
        terminate();
        return;
      }
      stderr.push(chunk);
    });
    const timer = setTimeout(terminate, Number(options.timeoutMs || 60_000));
    timer.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (overflow) {
        reject(new Error("RELEASE_ARCHIVE_TAR_OUTPUT_LIMIT"));
        return;
      }
      const outputBuffer = Buffer.concat(stdout);
      const output = options.binary ? outputBuffer : outputBuffer.toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(errorOutput || `Tar-Prüfung endete mit Status ${code}.`));
        return;
      }
      resolve(output);
    });
  });
}

export function parseDockerArchiveManifestEntry(input) {
  const text = typeof input === "string" ? input : String(input || "");
  if (!text || Buffer.byteLength(text) > MAX_MANIFEST_BYTES) {
    throw new Error("RELEASE_ARCHIVE_MANIFEST_INVALID");
  }
  let manifest;
  try { manifest = JSON.parse(text); } catch { throw new Error("RELEASE_ARCHIVE_MANIFEST_INVALID"); }
  if (!Array.isArray(manifest) || manifest.length !== 1) {
    throw new Error("RELEASE_ARCHIVE_MUST_CONTAIN_ONE_IMAGE");
  }
  const entry = manifest[0];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("RELEASE_ARCHIVE_MANIFEST_INVALID");
  }
  const tags = entry.RepoTags;
  const normalizedTags = tags === null || tags === undefined ? [] : tags;
  if (!Array.isArray(normalizedTags) || normalizedTags.length > 32) throw new Error("RELEASE_ARCHIVE_TAGS_INVALID");
  const validatedTags = normalizedTags.map((tag) => {
    if (typeof tag !== "string" || tag.length < 3 || tag.length > 255) {
      throw new Error("RELEASE_ARCHIVE_TAGS_INVALID");
    }
    return tag;
  });
  const configPath = String(entry.Config || "").replace(/^\.\//u, "");
  const configMatch = /^([a-f0-9]{64})\.json$/u.exec(configPath);
  if (!configMatch) throw new Error("RELEASE_ARCHIVE_CONFIG_PATH_INVALID");
  if (!Array.isArray(entry.Layers) || entry.Layers.length < 1 || entry.Layers.length > 256) {
    throw new Error("RELEASE_ARCHIVE_LAYERS_INVALID");
  }
  const layers = entry.Layers.map((layer) => normalizeSafeTarPath(layer, "RELEASE_ARCHIVE_LAYER_PATH_INVALID"));
  if (new Set(layers).size !== layers.length || layers.some((layer) => !/(?:^|\/)layer\.tar$/u.test(layer))) {
    throw new Error("RELEASE_ARCHIVE_LAYERS_INVALID");
  }
  return {
    tags: validatedTags,
    configPath,
    configDigest: `sha256:${configMatch[1]}`,
    layers,
  };
}

export function parseDockerArchiveManifest(input) {
  return parseDockerArchiveManifestEntry(input).tags;
}

export function assertReleaseArchiveTags(identity, actualTags, options = {}) {
  if (!identity || typeof identity.repository !== "string" || typeof identity.version !== "string") {
    throw new Error("RELEASE_ARCHIVE_TAG_IDENTITY_INVALID");
  }
  if (!Array.isArray(actualTags) || actualTags.length > 32) throw new Error("RELEASE_ARCHIVE_TAGS_INVALID");
  const expectedTag = `${identity.repository}:${identity.imageTag || identity.version}`;
  if (actualTags.length !== 1) throw new Error("RELEASE_ARCHIVE_VERSION_TAG_REQUIRED");
  const forbiddenTags = new Set(options.forbiddenTags || []);
  const seen = new Set();
  for (const tag of actualTags) {
    if (typeof tag !== "string" || tag.length < 3 || tag.length > 255 || seen.has(tag)) {
      throw new Error("RELEASE_ARCHIVE_TAGS_INVALID");
    }
    seen.add(tag);
    if (forbiddenTags.has(tag)) throw new Error("RELEASE_ARCHIVE_FORBIDDEN_RUNTIME_TAG");
    if (tag !== expectedTag) throw new Error("RELEASE_ARCHIVE_UNEXPECTED_TAG");
  }
  return true;
}

/** Lists and reads only manifest.json on stdout; it never extracts archive files. */
export async function inspectDockerArchiveTags(archivePath, options = {}) {
  const resolved = path.resolve(archivePath);
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error("RELEASE_ARCHIVE_FILE_INVALID");
  }
  const tarBinary = options.tarBinary || "/bin/tar";
  const listing = await (options.execute || runBounded)(tarBinary, ["-tf", resolved], {
    maxStdoutBytes: MAX_LIST_BYTES,
    maxStderrBytes: MAX_STDERR_BYTES,
    timeoutMs: 60_000,
  });
  const entries = String(listing).split("\n").map((entry) => entry.replace(/\r$/, "")).filter(Boolean);
  const manifests = entries.filter((entry) => entry === "manifest.json" || entry === "./manifest.json");
  if (manifests.length !== 1) throw new Error("RELEASE_ARCHIVE_MANIFEST_MISSING_OR_DUPLICATE");
  const manifest = await (options.execute || runBounded)(tarBinary, ["-xOf", resolved, manifests[0]], {
    maxStdoutBytes: MAX_MANIFEST_BYTES,
    maxStderrBytes: MAX_STDERR_BYTES,
    timeoutMs: 60_000,
  });
  return parseDockerArchiveManifest(manifest);
}

function normalizeArchiveEntry(entry) {
  return String(entry || "").replace(/\r$/u, "").replace(/^\.\//u, "");
}

function normalizeSafeTarPath(value, errorCode = "RELEASE_ARCHIVE_ENTRY_PATH_INVALID") {
  const normalized = normalizeArchiveEntry(value).replace(/\/$/u, "");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized.includes("\\")
    || normalized.includes(":")
    || /[\u0000-\u001f\u007f]/u.test(normalized)
    || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || Buffer.byteLength(normalized, "utf8") > 65_535
  ) {
    throw new Error(errorCode);
  }
  return normalized;
}

function parseTarString(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul < 0 ? field.length : nul).toString("utf8");
}

function parseTarNumber(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  if ((field[0] & 0x80) !== 0) {
    if ((field[0] & 0x40) !== 0) throw new Error("RELEASE_ARCHIVE_TAR_NUMBER_INVALID");
    let result = BigInt(field[0] & 0x7f);
    for (let index = 1; index < field.length; index += 1) result = (result << 8n) | BigInt(field[index]);
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("RELEASE_ARCHIVE_TAR_NUMBER_INVALID");
    return Number(result);
  }
  const value = field.toString("ascii").replace(/\0.*$/su, "").trim();
  if (!value) return 0;
  if (!/^[0-7]+$/u.test(value)) throw new Error("RELEASE_ARCHIVE_TAR_NUMBER_INVALID");
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("RELEASE_ARCHIVE_TAR_NUMBER_INVALID");
  return result;
}

function tarChecksum(header) {
  let result = 0;
  for (let index = 0; index < header.length; index += 1) {
    result += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return result;
}

async function readExact(handle, buffer, offset, length, position, errorCode) {
  let completed = 0;
  while (completed < length) {
    const { bytesRead } = await handle.read(buffer, offset + completed, length - completed, position + completed);
    if (bytesRead <= 0) throw new Error(errorCode);
    completed += bytesRead;
  }
  return buffer;
}

async function readRegion(handle, offset, size, maximumBytes, errorCode) {
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) throw new Error(errorCode);
  const result = Buffer.alloc(size);
  await readExact(handle, result, 0, size, offset, errorCode);
  return result;
}

function parsePax(contents) {
  const result = Object.create(null);
  let cursor = 0;
  while (cursor < contents.length) {
    const space = contents.indexOf(0x20, cursor);
    if (space < 0) throw new Error("RELEASE_ARCHIVE_TAR_PAX_INVALID");
    const lengthText = contents.subarray(cursor, space).toString("ascii");
    if (!/^[1-9]\d*$/u.test(lengthText)) throw new Error("RELEASE_ARCHIVE_TAR_PAX_INVALID");
    const recordLength = Number(lengthText);
    if (!Number.isSafeInteger(recordLength) || recordLength < 3 || cursor + recordLength > contents.length) {
      throw new Error("RELEASE_ARCHIVE_TAR_PAX_INVALID");
    }
    const record = contents.subarray(space + 1, cursor + recordLength);
    if (record.at(-1) !== 0x0a) throw new Error("RELEASE_ARCHIVE_TAR_PAX_INVALID");
    const separator = record.indexOf(0x3d);
    if (separator > 0) {
      const key = record.subarray(0, separator).toString("utf8");
      if (["path", "size", "linkpath"].includes(key)) {
        if (Object.hasOwn(result, key)) throw new Error("RELEASE_ARCHIVE_TAR_PAX_INVALID");
        result[key] = record.subarray(separator + 1, -1).toString("utf8");
      }
    }
    cursor += recordLength;
  }
  return result;
}

async function assertZeroTail(handle, start, end) {
  const chunk = Buffer.alloc(64 * 1024);
  for (let cursor = start; cursor < end;) {
    const length = Math.min(chunk.length, end - cursor);
    await readExact(handle, chunk, 0, length, cursor, "RELEASE_ARCHIVE_TAR_TRUNCATED");
    for (let index = 0; index < length; index += 1) {
      if (chunk[index] !== 0) throw new Error("RELEASE_ARCHIVE_TAR_TRAILING_DATA");
    }
    cursor += length;
  }
}

async function walkTarRegion(handle, { start = 0, size, onEntry }) {
  const end = start + size;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || size < TAR_BLOCK_BYTES || end < start) {
    throw new Error("RELEASE_ARCHIVE_TAR_INVALID");
  }
  let cursor = start;
  let pendingPax = {};
  let pendingLongName;
  let zeroBlocks = 0;
  while (cursor + TAR_BLOCK_BYTES <= end) {
    const header = await readExact(
      handle,
      Buffer.alloc(TAR_BLOCK_BYTES),
      0,
      TAR_BLOCK_BYTES,
      cursor,
      "RELEASE_ARCHIVE_TAR_TRUNCATED",
    );
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      cursor += TAR_BLOCK_BYTES;
      if (zeroBlocks >= 2) {
        if (Object.keys(pendingPax).length > 0 || pendingLongName !== undefined) {
          throw new Error("RELEASE_ARCHIVE_TAR_METADATA_DANGLING");
        }
        await assertZeroTail(handle, cursor, end);
        return;
      }
      continue;
    }
    if (zeroBlocks > 0) throw new Error("RELEASE_ARCHIVE_TAR_INVALID");
    const storedChecksum = parseTarNumber(header, 148, 8);
    if (storedChecksum !== tarChecksum(header)) throw new Error("RELEASE_ARCHIVE_TAR_CHECKSUM_INVALID");
    const rawSize = parseTarNumber(header, 124, 12);
    const dataOffset = cursor + TAR_BLOCK_BYTES;
    const paddedSize = Math.ceil(rawSize / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (!Number.isSafeInteger(paddedSize) || dataOffset + paddedSize > end) {
      throw new Error("RELEASE_ARCHIVE_TAR_TRUNCATED");
    }
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = parseTarString(header, 345, 155);
    const shortName = parseTarString(header, 0, 100);
    const headerName = prefix ? `${prefix}/${shortName}` : shortName;
    if (type === "g" || type === "K") throw new Error("RELEASE_ARCHIVE_TAR_EXTENSION_UNSUPPORTED");
    if (type === "x" || type === "L") {
      const metadata = await readRegion(
        handle,
        dataOffset,
        rawSize,
        MAX_TAR_METADATA_BYTES,
        "RELEASE_ARCHIVE_TAR_METADATA_TOO_LARGE",
      );
      if (type === "x") {
        const parsedPax = parsePax(metadata);
        if (Object.keys(parsedPax).some((key) => Object.hasOwn(pendingPax, key))) {
          throw new Error("RELEASE_ARCHIVE_TAR_PAX_INVALID");
        }
        pendingPax = { ...pendingPax, ...parsedPax };
      } else {
        if (pendingLongName !== undefined) throw new Error("RELEASE_ARCHIVE_TAR_METADATA_DANGLING");
        pendingLongName = metadata.toString("utf8").replace(/\0.*$/su, "");
      }
      await assertZeroTail(handle, dataOffset + rawSize, dataOffset + paddedSize);
      cursor = dataOffset + paddedSize;
      continue;
    }
    const name = normalizeSafeTarPath(pendingPax.path || pendingLongName || headerName);
    if (pendingPax.size !== undefined && !/^(?:0|[1-9]\d*)$/u.test(pendingPax.size)) {
      throw new Error("RELEASE_ARCHIVE_TAR_PAX_INVALID");
    }
    const entrySize = pendingPax.size === undefined ? rawSize : Number(pendingPax.size);
    if (!Number.isSafeInteger(entrySize) || entrySize !== rawSize) throw new Error("RELEASE_ARCHIVE_TAR_PAX_INVALID");
    await onEntry({
      name,
      type,
      size: rawSize,
      dataOffset,
      linkName: pendingPax.linkpath || parseTarString(header, 157, 100),
    });
    await assertZeroTail(handle, dataOffset + rawSize, dataOffset + paddedSize);
    pendingPax = {};
    pendingLongName = undefined;
    cursor = dataOffset + paddedSize;
  }
  throw new Error("RELEASE_ARCHIVE_TAR_END_MISSING");
}

function parseImageConfig(input) {
  let config;
  try {
    config = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : String(input || ""));
  } catch {
    throw new Error("RELEASE_ARCHIVE_CONFIG_INVALID");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("RELEASE_ARCHIVE_CONFIG_INVALID");
  }
  const architecture = String(config.architecture || "");
  const osName = String(config.os || "");
  const variant = config.variant === undefined ? undefined : String(config.variant);
  if (osName !== "linux" || !["amd64", "arm64"].includes(architecture)) {
    throw new Error("RELEASE_ARCHIVE_PLATFORM_INVALID");
  }
  if (variant !== undefined && !/^[A-Za-z0-9._-]{1,64}$/u.test(variant)) {
    throw new Error("RELEASE_ARCHIVE_PLATFORM_INVALID");
  }
  const labels = config.config?.Labels;
  if (labels !== undefined && (!labels || typeof labels !== "object" || Array.isArray(labels))) {
    throw new Error("RELEASE_ARCHIVE_LABELS_INVALID");
  }
  const diffIds = config.rootfs?.diff_ids;
  if (
    config.rootfs?.type !== "layers"
    || !Array.isArray(diffIds)
    || diffIds.length < 1
    || diffIds.length > 256
    || diffIds.some((digest) => !/^sha256:[a-f0-9]{64}$/u.test(String(digest)))
  ) {
    throw new Error("RELEASE_ARCHIVE_ROOTFS_INVALID");
  }
  return {
    platform: {
      os: osName,
      architecture,
      ...(variant ? { variant } : {}),
    },
    labels: labels || {},
    diffIds: diffIds.map(String),
  };
}

async function sha256Region(handle, offset, size) {
  const hash = crypto.createHash("sha256");
  const chunk = Buffer.alloc(1024 * 1024);
  for (let cursor = 0; cursor < size;) {
    const length = Math.min(chunk.length, size - cursor);
    await readExact(handle, chunk, 0, length, offset + cursor, "RELEASE_ARCHIVE_TAR_TRUNCATED");
    hash.update(chunk.subarray(0, length));
    cursor += length;
  }
  return `sha256:${hash.digest("hex")}`;
}

async function assertNoPrivateKeyContents(handle, entry) {
  if (entry.size <= 0) return;
  const chunk = Buffer.alloc(64 * 1024);
  let tail = "";
  for (let cursor = 0; cursor < entry.size;) {
    const length = Math.min(chunk.length, entry.size - cursor);
    await readExact(handle, chunk, 0, length, entry.dataOffset + cursor, "RELEASE_ARCHIVE_TAR_TRUNCATED");
    const text = `${tail}${chunk.subarray(0, length).toString("utf8")}`;
    if (PRIVATE_KEY_MARKER_PATTERN.test(text)) {
      throw new Error(`CORE_RELEASE_PRIVATE_KEY_MATERIAL_FOUND: ${entry.name}`);
    }
    tail = text.slice(-512);
    cursor += length;
  }
}

function assertNoPrivateKeyBuffer(buffer, pathName) {
  if (PRIVATE_KEY_MARKER_PATTERN.test(buffer.toString("utf8"))) {
    throw new Error(`CORE_RELEASE_PRIVATE_KEY_MATERIAL_FOUND: ${pathName}`);
  }
}

function assertExactObjectKeys(value, keys, errorCode) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(errorCode);
}

function isWhiteout(entryName) {
  const basename = entryName.split("/").at(-1) || "";
  return basename === ".wh..wh..opq" || basename.startsWith(".wh.");
}

function applyLayerEntries(finalEntries, entries) {
  for (const entry of entries) {
    const segments = entry.name.split("/");
    const basename = segments.at(-1) || "";
    if (basename === ".wh..wh..opq") {
      const parent = segments.slice(0, -1).join("/");
      for (const existing of [...finalEntries.keys()]) {
        if (existing.startsWith(`${parent}/`)) finalEntries.delete(existing);
      }
    } else if (basename.startsWith(".wh.")) {
      const target = [...segments.slice(0, -1), basename.slice(4)].join("/");
      for (const existing of [...finalEntries.keys()]) {
        if (existing === target || existing.startsWith(`${target}/`)) finalEntries.delete(existing);
      }
    }
  }
  for (const entry of entries) {
    if (!isWhiteout(entry.name)) finalEntries.set(entry.name, entry);
  }
}

async function readFinalJson(handle, entries, pathName, errorCode) {
  const entry = entries.get(pathName);
  if (!entry || !["0", "\0"].includes(entry.type)) throw new Error(errorCode);
  const contents = await readRegion(handle, entry.dataOffset, entry.size, MAX_CORE_JSON_BYTES, errorCode);
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error(errorCode);
  }
}

async function readFinalBuffer(handle, entries, pathName, errorCode) {
  const entry = entries.get(pathName);
  if (!entry || !["0", "\0"].includes(entry.type)) throw new Error(errorCode);
  return readRegion(handle, entry.dataOffset, entry.size, MAX_CORE_JSON_BYTES, errorCode);
}

function assertFinalRegularFile(entries, pathName, errorCode) {
  const entry = entries.get(pathName);
  if (!entry || !["0", "\0"].includes(entry.type)) throw new Error(errorCode);
}

function assertCoreOnlyLayerEntry(entry) {
  const lower = entry.name.toLocaleLowerCase("en-US");
  if (lower.startsWith("app/")) {
    const appRoot = lower.split("/")[1];
    if (!CORE_ALLOWED_APP_ROOTS.has(appRoot)) {
      throw new Error(`CORE_RELEASE_UNEXPECTED_APP_ROOT_FOUND: ${entry.name}`);
    }
  }
  if (lower === "app/license-predecessors" || lower.startsWith("app/license-predecessors/")) {
    const segments = entry.name.split("/");
    const relative = segments.slice(2);
    const lowerRelative = relative.map((segment) => segment.toLocaleLowerCase("en-US"));
    const exactDirectory = relative.length === 0
      || (relative.length === 1 && lowerRelative[0] === "platform")
      || (relative.length === 2 && lowerRelative[0] === "platform" && lowerRelative[1] === "bonni-core")
      || (relative.length === 3
        && lowerRelative[0] === "platform"
        && lowerRelative[1] === "bonni-core"
        && SAFE_CORE_LICENSE_VERSION_PATTERN.test(relative[2]));
    const catalog = relative.length === 1 && lowerRelative[0] === "catalog.json";
    const versionPayload = relative.length > 3
      && lowerRelative[0] === "platform"
      && lowerRelative[1] === "bonni-core"
      && SAFE_CORE_LICENSE_VERSION_PATTERN.test(relative[2]);
    if (!exactDirectory && !catalog && !versionPayload) {
      throw new Error(`CORE_RELEASE_PREDECESSOR_PATH_INVALID: ${entry.name}`);
    }
    if (exactDirectory && entry.type !== "5") {
      throw new Error(`CORE_RELEASE_PREDECESSOR_TYPE_INVALID: ${entry.name}`);
    }
    if (catalog && !["0", "\0"].includes(entry.type)) {
      throw new Error(`CORE_RELEASE_PREDECESSOR_TYPE_INVALID: ${entry.name}`);
    }
    if (versionPayload && !["0", "\0", "5"].includes(entry.type)) {
      throw new Error(`CORE_RELEASE_PREDECESSOR_TYPE_INVALID: ${entry.name}`);
    }
    if (lowerRelative.some((segment) => [
      "add-on", "addon", "addons", "app", "apps", "bridge", "bridges",
      "modules", "plug-in", "plugin", "plugins", "signatur",
    ].includes(segment))) {
      throw new Error(`CORE_RELEASE_PREDECESSOR_NON_CORE_PAYLOAD_FOUND: ${entry.name}`);
    }
  }
  for (const root of CORE_FORBIDDEN_ROOTS) {
    if (lower === root) {
      if (CORE_EMPTY_RUNTIME_ROOTS.includes(root) && entry.type === "5") return;
      throw new Error(`CORE_RELEASE_FORBIDDEN_PAYLOAD_FOUND: ${entry.name}`);
    }
    if (lower.startsWith(`${root}/`)) {
      throw new Error(`CORE_RELEASE_FORBIDDEN_PAYLOAD_FOUND: ${entry.name}`);
    }
  }
  if (lower === "app/licenses/modules" || lower.startsWith("app/licenses/modules/")) {
    throw new Error(`CORE_RELEASE_MODULE_LICENSES_FOUND: ${entry.name}`);
  }
  if (lower.split("/").includes("signatur")) {
    throw new Error(`CORE_RELEASE_SIGNATURE_STORE_FOUND: ${entry.name}`);
  }
  if (PRIVATE_KEY_FILE_PATTERN.test(entry.name.split("/").at(-1) || "")) {
    throw new Error(`CORE_RELEASE_PRIVATE_KEY_FILE_FOUND: ${entry.name}`);
  }
  if (lower.startsWith("app/") && entry.type === "1") {
    throw new Error(`CORE_RELEASE_APP_HARDLINK_FORBIDDEN: ${entry.name}`);
  }
  if (lower.startsWith("app/") && !["0", "\0", "2", "5"].includes(entry.type)) {
    throw new Error(`CORE_RELEASE_APP_ENTRY_TYPE_INVALID: ${entry.name}`);
  }
}

function assertNoNonDirectoryAncestor(entries, pathName, errorCode) {
  const segments = pathName.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = entries.get(segments.slice(0, index).join("/"));
    if (ancestor && ancestor.type !== "5") throw new Error(errorCode);
  }
}

async function collectFinalTree(handle, entries, prefix, excluded = new Set()) {
  const result = [];
  for (const [entryPath, entry] of entries) {
    if (!entryPath.startsWith(`${prefix}/`)) continue;
    const relative = entryPath.slice(prefix.length + 1);
    if (!relative || excluded.has(relative) || entry.type === "5") continue;
    if (!["0", "\0"].includes(entry.type)) throw new Error(`CORE_RELEASE_TREE_ENTRY_INVALID: ${entryPath}`);
    const digest = await sha256Region(handle, entry.dataOffset, entry.size);
    result.push({ path: relative, bytes: entry.size, sha256: digest.slice("sha256:".length) });
  }
  result.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return result;
}

async function validateCoreLicenseVersionTree(handle, finalEntries, options) {
  const {
    prefix,
    version,
    catalogTreeSha256,
    receiptError,
    componentMissingError,
    componentError,
  } = options;
  assertNoNonDirectoryAncestor(finalEntries, `${prefix}/RECEIPT.json`, receiptError);
  const receipt = await readFinalJson(handle, finalEntries, `${prefix}/RECEIPT.json`, receiptError);
  const files = await collectFinalTree(handle, finalEntries, prefix, new Set(["RECEIPT.json"]));
  const treeSha256 = crypto.createHash("sha256")
    .update(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}`).join("\n"))
    .digest("hex");
  assertExactObjectKeys(
    receipt,
    ["schemaVersion", "product", "version", "projectLicense", "files", "treeSha256"],
    receiptError,
  );
  if (
    receipt.schemaVersion !== "bonni.platform-legal-receipt/v1"
    || receipt.product !== "bonni-core"
    || receipt.version !== version
    || typeof receipt.projectLicense !== "string"
    || JSON.stringify(receipt.files) !== JSON.stringify(files)
    || receipt.treeSha256 !== treeSha256
    || catalogTreeSha256 !== treeSha256
  ) {
    throw new Error(receiptError);
  }
  for (const required of [
    "BONNI_CORE_LICENSE_NOTICE.md",
    "backend/COMPONENT_RECEIPT.json",
    "backend/THIRD_PARTY_BUNDLES.json",
    "frontend/COMPONENT_RECEIPT.json",
    "frontend/THIRD_PARTY_BUNDLES.json",
  ]) {
    if (!files.some((entry) => entry.path === required)) {
      throw new Error(`${componentMissingError}: ${required}`);
    }
  }
  for (const component of ["backend", "frontend"]) {
    const componentReceipt = await readFinalJson(
      handle,
      finalEntries,
      `${prefix}/${component}/COMPONENT_RECEIPT.json`,
      componentError,
    );
    const inventoryBytes = await readFinalBuffer(
      handle,
      finalEntries,
      `${prefix}/${component}/THIRD_PARTY_BUNDLES.json`,
      componentError,
    );
    let inventory;
    try {
      inventory = JSON.parse(inventoryBytes.toString("utf8"));
    } catch {
      throw new Error(componentError);
    }
    assertExactObjectKeys(
      componentReceipt,
      ["schemaVersion", "product", "productVersion", "component", "dependencyCount", "inventorySha256"],
      componentError,
    );
    assertExactObjectKeys(
      inventory,
      ["schemaVersion", "product", "productVersion", "component", "dependencyCount", "dependencies"],
      componentError,
    );
    if (
      componentReceipt.schemaVersion !== "bonni.core-license-component/v1"
      || inventory.schemaVersion !== "bonni.core-third-party-inventory/v1"
      || componentReceipt.product !== "bonni-core"
      || inventory.product !== "bonni-core"
      || componentReceipt.productVersion !== version
      || inventory.productVersion !== version
      || componentReceipt.component !== component
      || inventory.component !== component
      || !Number.isSafeInteger(inventory.dependencyCount)
      || inventory.dependencyCount < 0
      || !Array.isArray(inventory.dependencies)
      || inventory.dependencyCount !== inventory.dependencies.length
      || componentReceipt.dependencyCount !== inventory.dependencyCount
      || componentReceipt.inventorySha256 !== crypto.createHash("sha256").update(inventoryBytes).digest("hex")
    ) {
      throw new Error(componentError);
    }
  }
  return { files, treeSha256 };
}

function expectedOuterRegularEntries(parsed) {
  const allowed = new Set(["manifest.json", "repositories", parsed.configPath, ...parsed.layers]);
  for (const layer of parsed.layers) {
    const parent = layer.split("/").slice(0, -1).join("/");
    if (parent) {
      allowed.add(`${parent}/VERSION`);
      allowed.add(`${parent}/json`);
    }
  }
  return allowed;
}

/**
 * Verifies the exact Docker-save payload before it may be signed. This parser
 * does not extract archive paths and therefore works on Windows without a
 * Docker daemon while remaining safe for untrusted prebuilt archives.
 */
export async function inspectCoreDockerArchivePayload(archivePath, options = {}) {
  const version = String(options.version || "");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("CORE_RELEASE_VERSION_INVALID");
  }
  const resolved = path.resolve(archivePath);
  const state = await fs.lstat(resolved);
  if (!state.isFile() || state.isSymbolicLink() || state.size <= 0) {
    throw new Error("RELEASE_ARCHIVE_FILE_INVALID");
  }
  const handle = await fs.open(resolved, "r");
  try {
    const openedState = await handle.stat();
    if (openedState.size !== state.size || openedState.mtimeMs !== state.mtimeMs) {
      throw new Error("RELEASE_ARCHIVE_CHANGED_DURING_INSPECTION");
    }
    const outerEntries = new Map();
    await walkTarRegion(handle, {
      size: state.size,
      onEntry: async (entry) => {
        if (outerEntries.size >= MAX_OUTER_TAR_ENTRIES || outerEntries.has(entry.name)) {
          throw new Error("RELEASE_ARCHIVE_ENTRY_DUPLICATE_OR_LIMIT");
        }
        if (!["0", "\0", "5"].includes(entry.type)) throw new Error("RELEASE_ARCHIVE_OUTER_TYPE_INVALID");
        outerEntries.set(entry.name, entry);
      },
    });
    const manifestEntry = outerEntries.get("manifest.json");
    if (!manifestEntry || !["0", "\0"].includes(manifestEntry.type)) {
      throw new Error("RELEASE_ARCHIVE_MANIFEST_MISSING_OR_DUPLICATE");
    }
    const manifestContents = await readRegion(
      handle,
      manifestEntry.dataOffset,
      manifestEntry.size,
      MAX_MANIFEST_BYTES,
      "RELEASE_ARCHIVE_MANIFEST_INVALID",
    );
    const parsed = parseDockerArchiveManifestEntry(manifestContents.toString("utf8"));
    const allowedOuter = expectedOuterRegularEntries(parsed);
    for (const entry of outerEntries.values()) {
      if (["0", "\0"].includes(entry.type) && !allowedOuter.has(entry.name)) {
        throw new Error(`RELEASE_ARCHIVE_UNEXPECTED_ENTRY: ${entry.name}`);
      }
      if (
        ["0", "\0"].includes(entry.type)
        && !parsed.layers.includes(entry.name)
      ) {
        if (PRIVATE_KEY_FILE_PATTERN.test(entry.name.split("/").at(-1) || "")) {
          throw new Error(`CORE_RELEASE_PRIVATE_KEY_FILE_FOUND: ${entry.name}`);
        }
        await assertNoPrivateKeyContents(handle, entry);
      }
    }
    const configEntry = outerEntries.get(parsed.configPath);
    if (!configEntry || !["0", "\0"].includes(configEntry.type)) {
      throw new Error("RELEASE_ARCHIVE_CONFIG_MISSING_OR_DUPLICATE");
    }
    const configBytes = await readRegion(
      handle,
      configEntry.dataOffset,
      configEntry.size,
      MAX_CONFIG_BYTES,
      "RELEASE_ARCHIVE_CONFIG_INVALID",
    );
    assertNoPrivateKeyBuffer(configBytes, parsed.configPath);
    const actualConfigDigest = `sha256:${crypto.createHash("sha256").update(configBytes).digest("hex")}`;
    if (actualConfigDigest !== parsed.configDigest) throw new Error("RELEASE_ARCHIVE_CONFIG_DIGEST_MISMATCH");
    const imageConfig = parseImageConfig(configBytes);
    if (imageConfig.diffIds.length !== parsed.layers.length) throw new Error("RELEASE_ARCHIVE_LAYER_COUNT_MISMATCH");
    for (const [label, expected] of [
      ["org.bonni.product", "bonni-core"],
      ["org.opencontainers.image.version", version],
      ["org.bonni.runtime.contract", "1"],
    ]) {
      if (imageConfig.labels[label] !== expected) {
        throw new Error(`CORE_RELEASE_ARCHIVE_LABEL_INVALID: ${label}`);
      }
    }

    const finalEntries = new Map();
    let totalLayerEntries = 0;
    for (let index = 0; index < parsed.layers.length; index += 1) {
      const layerName = parsed.layers[index];
      const layer = outerEntries.get(layerName);
      if (!layer || !["0", "\0"].includes(layer.type) || layer.size < TAR_BLOCK_BYTES) {
        throw new Error(`RELEASE_ARCHIVE_LAYER_MISSING: ${layerName}`);
      }
      if (await sha256Region(handle, layer.dataOffset, layer.size) !== imageConfig.diffIds[index]) {
        throw new Error(`RELEASE_ARCHIVE_LAYER_DIGEST_MISMATCH: ${layerName}`);
      }
      const entries = [];
      const layerPaths = new Set();
      await walkTarRegion(handle, {
        start: layer.dataOffset,
        size: layer.size,
        onEntry: async (entry) => {
          if (layerPaths.size >= 200_000 || totalLayerEntries >= 500_000 || layerPaths.has(entry.name)) {
            throw new Error("RELEASE_ARCHIVE_LAYER_ENTRY_INVALID");
          }
          layerPaths.add(entry.name);
          totalLayerEntries += 1;
          assertCoreOnlyLayerEntry(entry);
          if (isWhiteout(entry.name) && (!["0", "\0"].includes(entry.type) || entry.size !== 0)) {
            throw new Error(`RELEASE_ARCHIVE_WHITEOUT_INVALID: ${entry.name}`);
          }
          if (["0", "\0"].includes(entry.type)) {
            await assertNoPrivateKeyContents(handle, entry);
          }
          entries.push(entry);
        },
      });
      applyLayerEntries(finalEntries, entries);
    }

    for (const directory of CORE_EMPTY_RUNTIME_ROOTS) {
      if (finalEntries.get(directory)?.type !== "5") {
        throw new Error(`CORE_RELEASE_EMPTY_DIRECTORY_MISSING: ${directory}`);
      }
    }
    for (const required of [
      "app/backend/package.json",
      "app/backend/dist/system/server/run-server.js",
      "app/public/system/index.html",
      "app/public/system/.bonni-prebuilt-release.json",
      "app/licenses/catalog.json",
    ]) {
      assertNoNonDirectoryAncestor(finalEntries, required, "CORE_RELEASE_REQUIRED_PATH_ANCESTOR_INVALID");
    }
    assertFinalRegularFile(finalEntries, "app/backend/dist/system/server/run-server.js", "CORE_RELEASE_BACKEND_RUNTIME_MISSING");
    assertFinalRegularFile(finalEntries, "app/public/system/index.html", "CORE_RELEASE_FRONTEND_MISSING");
    const backendPackage = await readFinalJson(handle, finalEntries, "app/backend/package.json", "CORE_RELEASE_BACKEND_PACKAGE_INVALID");
    if (backendPackage?.name !== "bonni-core-backend" || backendPackage?.version !== version) {
      throw new Error("CORE_RELEASE_BACKEND_PACKAGE_INVALID");
    }
    const frontendMarker = await readFinalJson(
      handle,
      finalEntries,
      "app/public/system/.bonni-prebuilt-release.json",
      "CORE_RELEASE_FRONTEND_MARKER_INVALID",
    );
    assertExactObjectKeys(
      frontendMarker,
      ["schemaVersion", "coreVersion", "files", "treeSha256"],
      "CORE_RELEASE_FRONTEND_MARKER_INVALID",
    );
    if (frontendMarker?.schemaVersion !== "bonni.prebuilt-frontend/v1" || frontendMarker?.coreVersion !== version) {
      throw new Error("CORE_RELEASE_FRONTEND_MARKER_INVALID");
    }
    const frontendFiles = await collectFinalTree(
      handle,
      finalEntries,
      "app/public/system",
      new Set([".bonni-prebuilt-release.json"]),
    );
    const frontendTreeSha256 = crypto.createHash("sha256")
      .update(frontendFiles.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(""))
      .digest("hex");
    if (
      JSON.stringify(frontendMarker.files) !== JSON.stringify(frontendFiles)
      || frontendMarker.treeSha256 !== frontendTreeSha256
    ) {
      throw new Error("CORE_RELEASE_FRONTEND_EXACT_TREE_MISMATCH");
    }
    const receiptPath = `platform/bonni-core/${version}/RECEIPT.json`;
    const catalog = await readFinalJson(handle, finalEntries, "app/licenses/catalog.json", "CORE_RELEASE_LICENSE_CATALOG_INVALID");
    assertExactObjectKeys(catalog, ["schemaVersion", "generatedAt", "entries"], "CORE_RELEASE_LICENSE_CATALOG_INVALID");
    if (catalog.entries?.length === 1) {
      assertExactObjectKeys(
        catalog.entries[0],
        ["type", "key", "version", "receipt", "treeSha256"],
        "CORE_RELEASE_LICENSE_CATALOG_INVALID",
      );
    }
    if (
      catalog?.schemaVersion !== "bonni.license-catalog/v1"
      || typeof catalog.generatedAt !== "string"
      || !Array.isArray(catalog.entries)
      || catalog.entries.length !== 1
      || catalog.entries[0]?.type !== "platform"
      || catalog.entries[0]?.key !== "bonni-core"
      || catalog.entries[0]?.version !== version
      || catalog.entries[0]?.receipt !== receiptPath
    ) {
      throw new Error("CORE_RELEASE_LICENSE_CATALOG_INVALID");
    }
    const licensePrefix = `app/licenses/platform/bonni-core/${version}`;
    const allowedLicenseAncestors = new Set([
      "app/licenses",
      "app/licenses/catalog.json",
      "app/licenses/platform",
      "app/licenses/platform/bonni-core",
      licensePrefix,
    ]);
    for (const entryPath of finalEntries.keys()) {
      if (
        (entryPath === "app/licenses" || entryPath.startsWith("app/licenses/"))
        && !allowedLicenseAncestors.has(entryPath)
        && !entryPath.startsWith(`${licensePrefix}/`)
      ) {
        throw new Error(`CORE_RELEASE_LICENSE_PAYLOAD_UNEXPECTED: ${entryPath}`);
      }
    }
    await validateCoreLicenseVersionTree(handle, finalEntries, {
      prefix: licensePrefix,
      version,
      catalogTreeSha256: catalog.entries[0].treeSha256,
      receiptError: "CORE_RELEASE_LICENSE_RECEIPT_INVALID",
      componentMissingError: "CORE_RELEASE_LICENSE_COMPONENT_MISSING",
      componentError: "CORE_RELEASE_LICENSE_COMPONENT_INVALID",
    });

    const requiredPredecessor = REQUIRED_CORE_LICENSE_PREDECESSORS.get(version);
    const predecessorRoot = "app/license-predecessors";
    const predecessorPresent = [...finalEntries.keys()].some(
      (entryPath) => entryPath === predecessorRoot || entryPath.startsWith(`${predecessorRoot}/`),
    );
    let predecessorVersion;
    if (predecessorPresent || requiredPredecessor) {
      if (!predecessorPresent) throw new Error("CORE_RELEASE_REQUIRED_PREDECESSOR_MISSING");
      const predecessorCatalogPath = `${predecessorRoot}/catalog.json`;
      assertNoNonDirectoryAncestor(
        finalEntries,
        predecessorCatalogPath,
        "CORE_RELEASE_PREDECESSOR_PATH_ANCESTOR_INVALID",
      );
      const predecessorCatalog = await readFinalJson(
        handle,
        finalEntries,
        predecessorCatalogPath,
        "CORE_RELEASE_PREDECESSOR_CATALOG_INVALID",
      );
      assertExactObjectKeys(
        predecessorCatalog,
        ["schemaVersion", "generatedAt", "entries"],
        "CORE_RELEASE_PREDECESSOR_CATALOG_INVALID",
      );
      if (predecessorCatalog.entries?.length === 1) {
        assertExactObjectKeys(
          predecessorCatalog.entries[0],
          ["type", "key", "version", "receipt", "treeSha256"],
          "CORE_RELEASE_PREDECESSOR_CATALOG_INVALID",
        );
      }
      const predecessorEntry = predecessorCatalog.entries?.[0];
      predecessorVersion = predecessorEntry?.version;
      const predecessorReceipt = `platform/bonni-core/${predecessorVersion}/RECEIPT.json`;
      if (
        predecessorCatalog.schemaVersion !== "bonni.license-catalog/v1"
        || typeof predecessorCatalog.generatedAt !== "string"
        || !Array.isArray(predecessorCatalog.entries)
        || predecessorCatalog.entries.length !== 1
        || predecessorEntry?.type !== "platform"
        || predecessorEntry?.key !== "bonni-core"
        || !SAFE_CORE_LICENSE_VERSION_PATTERN.test(String(predecessorVersion || ""))
        || predecessorEntry?.receipt !== predecessorReceipt
        || (requiredPredecessor && predecessorVersion !== requiredPredecessor)
      ) {
        throw new Error("CORE_RELEASE_PREDECESSOR_CATALOG_INVALID");
      }
      const predecessorPrefix = `${predecessorRoot}/platform/bonni-core/${predecessorVersion}`;
      const allowedPredecessorAncestors = new Set([
        predecessorRoot,
        predecessorCatalogPath,
        `${predecessorRoot}/platform`,
        `${predecessorRoot}/platform/bonni-core`,
        predecessorPrefix,
      ]);
      for (const entryPath of finalEntries.keys()) {
        if (
          (entryPath === predecessorRoot || entryPath.startsWith(`${predecessorRoot}/`))
          && !allowedPredecessorAncestors.has(entryPath)
          && !entryPath.startsWith(`${predecessorPrefix}/`)
        ) {
          throw new Error(`CORE_RELEASE_PREDECESSOR_PAYLOAD_UNEXPECTED: ${entryPath}`);
        }
      }
      await validateCoreLicenseVersionTree(handle, finalEntries, {
        prefix: predecessorPrefix,
        version: predecessorVersion,
        catalogTreeSha256: predecessorEntry.treeSha256,
        receiptError: "CORE_RELEASE_PREDECESSOR_RECEIPT_INVALID",
        componentMissingError: "CORE_RELEASE_PREDECESSOR_COMPONENT_MISSING",
        componentError: "CORE_RELEASE_PREDECESSOR_COMPONENT_INVALID",
      });
    }
    const closedState = await handle.stat();
    if (closedState.size !== openedState.size || closedState.mtimeMs !== openedState.mtimeMs) {
      throw new Error("RELEASE_ARCHIVE_CHANGED_DURING_INSPECTION");
    }
    return {
      tags: parsed.tags,
      digest: parsed.configDigest,
      configPath: parsed.configPath,
      platform: imageConfig.platform,
      labels: imageConfig.labels,
      layers: parsed.layers,
      ...(predecessorVersion ? { licensePredecessorVersion: predecessorVersion } : {}),
      coreOnly: true,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Reads a Docker `image save` archive without loading it into a Docker daemon.
 * The image config digest is content-addressed by its archive filename, so it is
 * the same immutable image ID that Docker verifies while loading the archive.
 */
export async function inspectDockerArchiveIdentity(archivePath, options = {}) {
  const resolved = path.resolve(archivePath);
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error("RELEASE_ARCHIVE_FILE_INVALID");
  }
  const execute = options.execute || runBounded;
  const tarBinary = options.tarBinary || (process.platform === "win32" ? "tar.exe" : "tar");
  const listing = await execute(tarBinary, ["-tf", resolved], {
    maxStdoutBytes: MAX_LIST_BYTES,
    maxStderrBytes: MAX_STDERR_BYTES,
    timeoutMs: 60_000,
  });
  const entries = String(listing).split("\n").map(normalizeArchiveEntry).filter(Boolean);
  const manifestEntries = entries.filter((entry) => entry === "manifest.json");
  if (manifestEntries.length !== 1) throw new Error("RELEASE_ARCHIVE_MANIFEST_MISSING_OR_DUPLICATE");
  const manifest = await execute(tarBinary, ["-xOf", resolved, manifestEntries[0]], {
    maxStdoutBytes: MAX_MANIFEST_BYTES,
    maxStderrBytes: MAX_STDERR_BYTES,
    timeoutMs: 60_000,
  });
  const parsed = parseDockerArchiveManifestEntry(manifest);
  const configEntries = entries.filter((entry) => entry === parsed.configPath);
  if (configEntries.length !== 1) throw new Error("RELEASE_ARCHIVE_CONFIG_MISSING_OR_DUPLICATE");
  const configBytes = await execute(tarBinary, ["-xOf", resolved, configEntries[0]], {
    binary: true,
    maxStdoutBytes: MAX_CONFIG_BYTES,
    maxStderrBytes: MAX_STDERR_BYTES,
    timeoutMs: 60_000,
  });
  const configBuffer = Buffer.isBuffer(configBytes) ? configBytes : Buffer.from(configBytes);
  const actualDigest = `sha256:${crypto.createHash("sha256").update(configBuffer).digest("hex")}`;
  if (actualDigest !== parsed.configDigest) throw new Error("RELEASE_ARCHIVE_CONFIG_DIGEST_MISMATCH");
  const imageConfig = parseImageConfig(configBuffer);
  return {
    tags: parsed.tags,
    digest: parsed.configDigest,
    configPath: parsed.configPath,
    platform: imageConfig.platform,
    labels: imageConfig.labels,
  };
}
