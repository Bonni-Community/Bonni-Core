import path from "node:path";
import { mkdir, open, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_LOCATOR_SIGNATURE = 0x07064b50;

const GENERAL_PURPOSE_ENCRYPTED = 0x0001;
const GENERAL_PURPOSE_DATA_DESCRIPTOR = 0x0008;
const GENERAL_PURPOSE_UTF8 = 0x0800;
const GENERAL_PURPOSE_DEFLATE_OPTIONS = 0x0006;

const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMLINK = 0o120000;
const UNIX_SPECIAL_PERMISSIONS = 0o7000;
const UNIX_HOSTS = new Set([3, 19]);

const ZIP64_EXTRA_FIELD = 0x0001;
const UNICODE_PATH_EXTRA_FIELD = 0x7075;
const UNSAFE_LINK_EXTRA_FIELDS = new Set([0x000d, 0x756e]);
const ENCRYPTION_EXTRA_FIELDS = new Set([0x0017, 0x0019, 0x9901]);
const WINDOWS_DIRECTORY_OPEN_UNSUPPORTED_CODES = new Set([
  "EACCES",
  "EISDIR",
  "EPERM",
]);
const WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED_CODES = new Set([
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
  "EPERM",
]);

const TEXT_DECODER_UTF8 = new TextDecoder("utf-8", { fatal: true });
const CP437_HIGH_CHARACTERS = Array.from(
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ"
  + "áíóúñÑªº¿⌐¬½¼¡«»"
  + "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐"
  + "└┴┬├─┼╞╟╚╔╩╦╠═╬╧"
  + "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀"
  + "αßΓπΣσµτΦΘΩδ∞φε∩"
  + "≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ",
);

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  CRC32_TABLE[index] = value >>> 0;
}

export const DEFAULT_UPDATE_ZIP_LIMITS = Object.freeze({
  // Conservative native/offline profile. Large OCI payloads need an explicit profile.
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 10_000,
  maxCentralDirectoryBytes: 64 * 1024 * 1024,
  maxEntryCompressedBytes: 256 * 1024 * 1024,
  maxEntryUncompressedBytes: 512 * 1024 * 1024,
  maxTotalCompressedBytes: 512 * 1024 * 1024,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxNameBytes: 4_096,
  maxPathCharacters: 4_096,
  maxSegmentCharacters: 255,
});

export class SafeUpdateZipError extends Error {
  constructor(code, message, options = {}) {
    super(`${code}: ${message}`, options.cause ? { cause: options.cause } : undefined);
    this.name = "SafeUpdateZipError";
    this.code = code;
    if (options.entryName) this.entryName = options.entryName;
  }
}

function zipError(code, message, options) {
  return new SafeUpdateZipError(code, message, options);
}

function assertSafeIntegerLimit(name, value, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw zipError("ZIP_OPTIONS_INVALID", `${name} must be a safe integer >= ${minimum}`);
  }
}

function resolveLimits(options) {
  if (options === undefined) return DEFAULT_UPDATE_ZIP_LIMITS;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw zipError("ZIP_OPTIONS_INVALID", "options must be an object");
  }
  const provided = Object.hasOwn(options, "limits") ? options.limits : options;
  if (!provided || typeof provided !== "object" || Array.isArray(provided)) {
    throw zipError("ZIP_OPTIONS_INVALID", "limits must be an object");
  }
  for (const name of Object.keys(provided)) {
    if (!Object.hasOwn(DEFAULT_UPDATE_ZIP_LIMITS, name)) {
      throw zipError("ZIP_OPTIONS_INVALID", `unknown limit: ${name}`);
    }
  }
  const limits = Object.freeze({ ...DEFAULT_UPDATE_ZIP_LIMITS, ...provided });
  assertSafeIntegerLimit("maxArchiveBytes", limits.maxArchiveBytes);
  assertSafeIntegerLimit("maxEntries", limits.maxEntries, { allowZero: true });
  assertSafeIntegerLimit("maxCentralDirectoryBytes", limits.maxCentralDirectoryBytes);
  assertSafeIntegerLimit("maxEntryCompressedBytes", limits.maxEntryCompressedBytes, { allowZero: true });
  assertSafeIntegerLimit("maxEntryUncompressedBytes", limits.maxEntryUncompressedBytes, { allowZero: true });
  assertSafeIntegerLimit("maxTotalCompressedBytes", limits.maxTotalCompressedBytes, { allowZero: true });
  assertSafeIntegerLimit("maxTotalUncompressedBytes", limits.maxTotalUncompressedBytes, { allowZero: true });
  assertSafeIntegerLimit("maxNameBytes", limits.maxNameBytes);
  assertSafeIntegerLimit("maxPathCharacters", limits.maxPathCharacters);
  assertSafeIntegerLimit("maxSegmentCharacters", limits.maxSegmentCharacters);
  if (!Number.isFinite(limits.maxCompressionRatio) || limits.maxCompressionRatio <= 0) {
    throw zipError("ZIP_OPTIONS_INVALID", "maxCompressionRatio must be a finite number > 0");
  }
  return limits;
}

async function readExactly(fileHandle, length, position, label) {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(position) || position < 0) {
    throw zipError("ZIP_INVALID", `invalid ${label} range`);
  }
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await fileHandle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw zipError("ZIP_TRUNCATED", `${label} is truncated`);
    offset += bytesRead;
  }
  return buffer;
}

function crc32Start() {
  return 0xffffffff;
}

function crc32Update(crc, buffer) {
  let value = crc;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function crc32Finish(crc) {
  return (crc ^ 0xffffffff) >>> 0;
}

function crc32(buffer) {
  return crc32Finish(crc32Update(crc32Start(), buffer));
}

function decodeUtf8(buffer, label) {
  try {
    return TEXT_DECODER_UTF8.decode(buffer);
  } catch (cause) {
    throw zipError("ZIP_NAME_ENCODING_INVALID", `${label} is not valid UTF-8`, { cause });
  }
}

function decodeCp437(buffer) {
  let result = "";
  for (const byte of buffer) {
    result += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH_CHARACTERS[byte - 0x80];
  }
  return result;
}

function parseExtraFields(buffer, label) {
  const fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw zipError("ZIP_EXTRA_FIELD_INVALID", `${label} has trailing bytes`);
    const identifier = buffer.readUInt16LE(offset);
    const size = buffer.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > buffer.length) throw zipError("ZIP_EXTRA_FIELD_INVALID", `${label} is truncated`);
    if (fields.has(identifier)) throw zipError("ZIP_EXTRA_FIELD_INVALID", `${label} repeats field 0x${identifier.toString(16)}`);
    const data = buffer.subarray(offset, offset + size);
    fields.set(identifier, data);
    offset += size;
    if (identifier === ZIP64_EXTRA_FIELD) {
      throw zipError("ZIP64_UNSUPPORTED", `${label} contains ZIP64 metadata`);
    }
    if (UNSAFE_LINK_EXTRA_FIELDS.has(identifier)) {
      throw zipError("ZIP_UNSAFE_FILE_TYPE", `${label} contains Unix link metadata`);
    }
    if (ENCRYPTION_EXTRA_FIELDS.has(identifier)) {
      throw zipError("ZIP_ENCRYPTION_UNSUPPORTED", `${label} contains encryption metadata`);
    }
  }
  return fields;
}

function decodeEntryName(rawName, flags, extraFields, label) {
  let decoded = flags & GENERAL_PURPOSE_UTF8 ? decodeUtf8(rawName, label) : decodeCp437(rawName);
  const unicodePath = extraFields.get(UNICODE_PATH_EXTRA_FIELD);
  if (!unicodePath) return decoded;
  if (unicodePath.length < 5 || unicodePath[0] !== 1) {
    throw zipError("ZIP_NAME_ENCODING_INVALID", `${label} has an invalid Unicode path field`);
  }
  if (unicodePath.readUInt32LE(1) !== crc32(rawName)) {
    throw zipError("ZIP_NAME_ENCODING_INVALID", `${label} Unicode path CRC does not match`);
  }
  const unicodeName = decodeUtf8(unicodePath.subarray(5), `${label} Unicode path`);
  if ((flags & GENERAL_PURPOSE_UTF8) && unicodeName !== decoded) {
    throw zipError("ZIP_NAME_ENCODING_INVALID", `${label} has conflicting UTF-8 names`);
  }
  decoded = unicodeName;
  return decoded;
}

const WINDOWS_RESERVED_BASENAMES = new Set([
  "CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$",
]);

function isWindowsReservedSegment(segment) {
  const basename = segment.split(".", 1)[0].replace(/[ .]+$/gu, "").toUpperCase();
  return WINDOWS_RESERVED_BASENAMES.has(basename)
    || /^COM[1-9¹²³]$/u.test(basename)
    || /^LPT[1-9¹²³]$/u.test(basename);
}

function validateEntryPath(name, limits) {
  if (!name || name.length > limits.maxPathCharacters) {
    throw zipError("ZIP_PATH_INVALID", "entry path is empty or too long", { entryName: name });
  }
  if (name.includes("\\")) {
    throw zipError("ZIP_PATH_INVALID", "backslashes are forbidden in entry paths", { entryName: name });
  }
  if (name.startsWith("/") || /^[A-Za-z]:/u.test(name)) {
    throw zipError("ZIP_PATH_INVALID", "absolute and drive-prefixed entry paths are forbidden", { entryName: name });
  }
  const directory = name.endsWith("/");
  const pathWithoutTrailingSlash = directory ? name.slice(0, -1) : name;
  const segments = pathWithoutTrailingSlash.split("/");
  if (!pathWithoutTrailingSlash || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw zipError("ZIP_PATH_INVALID", "empty, dot, and parent path segments are forbidden", { entryName: name });
  }
  for (const segment of segments) {
    if (segment.length > limits.maxSegmentCharacters) {
      throw zipError("ZIP_PATH_INVALID", "entry path segment is too long", { entryName: name });
    }
    if (/[<>:"|?*\u0000-\u001f\u007f]/u.test(segment) || /[ .]$/u.test(segment)) {
      throw zipError("ZIP_WINDOWS_NAME_INVALID", "entry path is not portable to Windows", { entryName: name });
    }
    if (isWindowsReservedSegment(segment)) {
      throw zipError("ZIP_WINDOWS_NAME_RESERVED", "entry path uses a Windows-reserved name", { entryName: name });
    }
  }
  return {
    directory,
    segments,
    plainName: pathWithoutTrailingSlash,
    collisionSegments: segments.map((segment) => segment.normalize("NFC").toLowerCase().normalize("NFC")),
  };
}

function registerPath(pathInfo, state, entryName) {
  const { directory, segments, collisionSegments } = pathInfo;
  for (let length = 1; length < segments.length; length += 1) {
    const key = collisionSegments.slice(0, length).join("/");
    const spelling = segments.slice(0, length).join("/");
    const existing = state.get(key);
    if (existing && (existing.kind === "file" || existing.spelling !== spelling)) {
      throw zipError("ZIP_PATH_COLLISION", `entry collides with ${existing.entryName}`, { entryName });
    }
    if (!existing) state.set(key, { kind: "implicit-directory", spelling, entryName });
  }

  const key = collisionSegments.join("/");
  const spelling = segments.join("/");
  const existing = state.get(key);
  if (existing) {
    const canPromoteImplicitDirectory = directory
      && existing.kind === "implicit-directory"
      && existing.spelling === spelling;
    if (!canPromoteImplicitDirectory) {
      throw zipError("ZIP_PATH_COLLISION", `entry collides with ${existing.entryName}`, { entryName });
    }
  }
  state.set(key, {
    kind: directory ? "directory" : "file",
    spelling,
    entryName,
  });
}

function validateFlags(flags, compressionMethod, entryName) {
  if (flags & GENERAL_PURPOSE_ENCRYPTED) {
    throw zipError("ZIP_ENCRYPTION_UNSUPPORTED", "encrypted entries are forbidden", { entryName });
  }
  const allowed = GENERAL_PURPOSE_DATA_DESCRIPTOR
    | GENERAL_PURPOSE_UTF8
    | (compressionMethod === 8 ? GENERAL_PURPOSE_DEFLATE_OPTIONS : 0);
  if (flags & ~allowed) {
    throw zipError("ZIP_FEATURE_UNSUPPORTED", `unsupported general-purpose flags 0x${flags.toString(16)}`, { entryName });
  }
}

function entryPermissions(versionMadeBy, unixMode, directory) {
  const host = versionMadeBy >>> 8;
  if (UNIX_HOSTS.has(host) && (unixMode & 0o777)) return unixMode & 0o777;
  return directory ? 0o755 : 0o644;
}

function validateEntryType(versionMadeBy, externalAttributes, directory, entryName) {
  const unixMode = externalAttributes >>> 16;
  const unixType = unixMode & UNIX_FILE_TYPE_MASK;
  if (unixType === UNIX_SYMLINK) {
    throw zipError("ZIP_SYMLINK_FORBIDDEN", "symbolic links are forbidden", { entryName });
  }
  if (unixType !== 0 && unixType !== UNIX_REGULAR_FILE && unixType !== UNIX_DIRECTORY) {
    throw zipError("ZIP_UNSAFE_FILE_TYPE", `unsupported Unix file type 0${unixType.toString(8)}`, { entryName });
  }
  if (unixMode & UNIX_SPECIAL_PERMISSIONS) {
    throw zipError("ZIP_UNSAFE_FILE_MODE", "setuid, setgid, and sticky modes are forbidden", { entryName });
  }
  const attributesSayDirectory = unixType === UNIX_DIRECTORY || Boolean(externalAttributes & 0x10);
  if ((directory && unixType === UNIX_REGULAR_FILE) || (!directory && attributesSayDirectory)) {
    throw zipError("ZIP_ENTRY_TYPE_MISMATCH", "path suffix and file attributes disagree", { entryName });
  }
  return {
    unixMode,
    permissions: entryPermissions(versionMadeBy, unixMode, directory),
  };
}

async function findEndOfCentralDirectory(fileHandle, archiveSize) {
  if (archiveSize < 22) throw zipError("ZIP_TRUNCATED", "archive is shorter than an EOCD record");
  const tailLength = Math.min(archiveSize, 22 + 0xffff);
  const tailOffset = archiveSize - tailLength;
  const tail = await readExactly(fileHandle, tailLength, tailOffset, "archive tail");
  const candidates = [];
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (tailOffset + offset + 22 + commentLength === archiveSize) candidates.push(offset);
  }
  if (candidates.length !== 1) {
    throw zipError("ZIP_EOCD_INVALID", candidates.length ? "archive has ambiguous EOCD records" : "EOCD record not found");
  }
  const relativeOffset = candidates[0];
  const absoluteOffset = tailOffset + relativeOffset;
  if (absoluteOffset >= 20) {
    const locatorSignature = relativeOffset >= 20
      ? tail.readUInt32LE(relativeOffset - 20)
      : (await readExactly(fileHandle, 4, absoluteOffset - 20, "possible ZIP64 locator")).readUInt32LE(0);
    if (locatorSignature === ZIP64_END_LOCATOR_SIGNATURE) {
      throw zipError("ZIP64_UNSUPPORTED", "ZIP64 locator is forbidden");
    }
  }
  return { record: tail.subarray(relativeOffset, relativeOffset + 22), offset: absoluteOffset };
}

function checkedAdd(total, value, maximum, label) {
  const result = total + value;
  if (!Number.isSafeInteger(result) || result > maximum) throw zipError("ZIP_LIMIT_EXCEEDED", `${label} exceeds its limit`);
  return result;
}

function parseCentralDirectory(buffer, entryCount, centralOffset, limits) {
  const entries = [];
  const pathState = new Map();
  let offset = 0;
  let totalCompressedSize = 0;
  let totalUncompressedSize = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw zipError("ZIP_CENTRAL_DIRECTORY_INVALID", `entry ${index} has no valid central header`);
    }
    const versionMadeBy = buffer.readUInt16LE(offset + 4);
    const versionNeeded = buffer.readUInt16LE(offset + 6);
    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const expectedCrc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const diskStart = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const variableEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (variableEnd > buffer.length) throw zipError("ZIP_CENTRAL_DIRECTORY_INVALID", `entry ${index} is truncated`);
    if (!nameLength || nameLength > limits.maxNameBytes) {
      throw zipError("ZIP_LIMIT_EXCEEDED", `entry ${index} name exceeds its limit`);
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff || diskStart === 0xffff) {
      throw zipError("ZIP64_UNSUPPORTED", `entry ${index} uses a ZIP64 sentinel`);
    }
    if (diskStart !== 0) throw zipError("ZIP_MULTIDISK_UNSUPPORTED", `entry ${index} starts on another disk`);
    if (versionNeeded > 20) throw zipError("ZIP_FEATURE_UNSUPPORTED", `entry ${index} needs ZIP version ${versionNeeded}`);
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw zipError("ZIP_COMPRESSION_UNSUPPORTED", `entry ${index} uses compression method ${compressionMethod}`);
    }

    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const rawExtra = buffer.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    const extraFields = parseExtraFields(rawExtra, `central entry ${index}`);
    const name = decodeEntryName(rawName, flags, extraFields, `central entry ${index} name`);
    validateFlags(flags, compressionMethod, name);
    const pathInfo = validateEntryPath(name, limits);
    registerPath(pathInfo, pathState, name);
    const type = validateEntryType(versionMadeBy, externalAttributes, pathInfo.directory, name);

    if (pathInfo.directory && (compressedSize !== 0 || uncompressedSize !== 0 || expectedCrc32 !== 0)) {
      throw zipError("ZIP_DIRECTORY_DATA_FORBIDDEN", "directory entries must be empty", { entryName: name });
    }
    if (pathInfo.directory && compressionMethod !== 0) {
      throw zipError("ZIP_DIRECTORY_DATA_FORBIDDEN", "directory entries must use stored mode", { entryName: name });
    }
    if (compressionMethod === 8 && compressedSize === 0) {
      throw zipError("ZIP_DECOMPRESSION_FAILED", "deflated entries must contain a complete deflate stream", { entryName: name });
    }
    if (compressionMethod === 0 && compressedSize !== uncompressedSize) {
      throw zipError("ZIP_SIZE_MISMATCH", "stored entry sizes differ", { entryName: name });
    }
    if (compressedSize > limits.maxEntryCompressedBytes || uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw zipError("ZIP_LIMIT_EXCEEDED", "entry size exceeds its limit", { entryName: name });
    }
    const compressionRatio = uncompressedSize / Math.max(compressedSize, 1);
    if (compressionRatio > limits.maxCompressionRatio) {
      throw zipError("ZIP_COMPRESSION_RATIO_EXCEEDED", `entry compression ratio ${compressionRatio.toFixed(2)} is too high`, { entryName: name });
    }
    totalCompressedSize = checkedAdd(totalCompressedSize, compressedSize, limits.maxTotalCompressedBytes, "total compressed size");
    totalUncompressedSize = checkedAdd(totalUncompressedSize, uncompressedSize, limits.maxTotalUncompressedBytes, "total uncompressed size");
    if (localHeaderOffset >= centralOffset) {
      throw zipError("ZIP_LOCAL_HEADER_INVALID", "local header points into the central directory", { entryName: name });
    }

    entries.push({
      name,
      directory: pathInfo.directory,
      segments: pathInfo.segments,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      expectedCrc32,
      crc32: expectedCrc32.toString(16).padStart(8, "0"),
      flags,
      versionNeeded,
      rawName: Buffer.from(rawName),
      localHeaderOffset,
      permissions: type.permissions,
    });
    offset = variableEnd;
  }
  if (offset !== buffer.length) {
    throw zipError("ZIP_CENTRAL_DIRECTORY_INVALID", "central directory contains unparsed records or trailing bytes");
  }
  return { entries, totalCompressedSize, totalUncompressedSize };
}

async function parseDataDescriptor(fileHandle, entry, dataEnd, centralOffset) {
  if (!(entry.flags & GENERAL_PURPOSE_DATA_DESCRIPTOR)) return dataEnd;
  if (dataEnd + 12 > centralOffset) {
    throw zipError("ZIP_DATA_DESCRIPTOR_INVALID", "data descriptor is truncated", { entryName: entry.name });
  }
  const firstTwelve = await readExactly(fileHandle, 12, dataEnd, `data descriptor for ${entry.name}`);
  let crcOffset = 0;
  let descriptorSize = 12;
  let descriptor = firstTwelve;
  if (firstTwelve.readUInt32LE(0) === DATA_DESCRIPTOR_SIGNATURE) {
    if (dataEnd + 16 > centralOffset) {
      throw zipError("ZIP_DATA_DESCRIPTOR_INVALID", "signed data descriptor is truncated", { entryName: entry.name });
    }
    descriptor = await readExactly(fileHandle, 16, dataEnd, `signed data descriptor for ${entry.name}`);
    crcOffset = 4;
    descriptorSize = 16;
  }
  const descriptorCrc32 = descriptor.readUInt32LE(crcOffset);
  const descriptorCompressedSize = descriptor.readUInt32LE(crcOffset + 4);
  const descriptorUncompressedSize = descriptor.readUInt32LE(crcOffset + 8);
  if (descriptorCrc32 !== entry.expectedCrc32
    || descriptorCompressedSize !== entry.compressedSize
    || descriptorUncompressedSize !== entry.uncompressedSize) {
    throw zipError("ZIP_DATA_DESCRIPTOR_INVALID", "data descriptor disagrees with the central directory", { entryName: entry.name });
  }
  return dataEnd + descriptorSize;
}

async function validateLocalHeaders(fileHandle, entries, centralOffset) {
  const spans = [];
  for (const entry of entries) {
    const header = await readExactly(fileHandle, 30, entry.localHeaderOffset, `local header for ${entry.name}`);
    if (header.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw zipError("ZIP_LOCAL_HEADER_INVALID", "local header signature is invalid", { entryName: entry.name });
    }
    const versionNeeded = header.readUInt16LE(4);
    const flags = header.readUInt16LE(6);
    const compressionMethod = header.readUInt16LE(8);
    const localCrc32 = header.readUInt32LE(14);
    const localCompressedSize = header.readUInt32LE(18);
    const localUncompressedSize = header.readUInt32LE(22);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    if (localCompressedSize === 0xffffffff || localUncompressedSize === 0xffffffff) {
      throw zipError("ZIP64_UNSUPPORTED", "local header uses a ZIP64 sentinel", { entryName: entry.name });
    }
    if (versionNeeded !== entry.versionNeeded || flags !== entry.flags || compressionMethod !== entry.compressionMethod) {
      throw zipError("ZIP_LOCAL_HEADER_MISMATCH", "local and central header metadata differ", { entryName: entry.name });
    }
    const variableLength = nameLength + extraLength;
    const variable = await readExactly(fileHandle, variableLength, entry.localHeaderOffset + 30, `local metadata for ${entry.name}`);
    const localRawName = variable.subarray(0, nameLength);
    if (!localRawName.equals(entry.rawName)) {
      throw zipError("ZIP_LOCAL_HEADER_MISMATCH", "local and central entry names differ", { entryName: entry.name });
    }
    const localExtra = parseExtraFields(variable.subarray(nameLength), `local entry ${entry.name}`);
    if (localExtra.has(UNICODE_PATH_EXTRA_FIELD)) {
      const localName = decodeEntryName(localRawName, flags, localExtra, `local entry ${entry.name} name`);
      if (localName !== entry.name) {
        throw zipError("ZIP_LOCAL_HEADER_MISMATCH", "local and central Unicode entry names differ", { entryName: entry.name });
      }
    }

    const usesDescriptor = Boolean(flags & GENERAL_PURPOSE_DATA_DESCRIPTOR);
    if (usesDescriptor) {
      const crcMatches = localCrc32 === 0 || localCrc32 === entry.expectedCrc32;
      const compressedMatches = localCompressedSize === 0 || localCompressedSize === entry.compressedSize;
      const uncompressedMatches = localUncompressedSize === 0 || localUncompressedSize === entry.uncompressedSize;
      if (!crcMatches || !compressedMatches || !uncompressedMatches) {
        throw zipError("ZIP_LOCAL_HEADER_MISMATCH", "local descriptor placeholders are inconsistent", { entryName: entry.name });
      }
    } else if (localCrc32 !== entry.expectedCrc32
      || localCompressedSize !== entry.compressedSize
      || localUncompressedSize !== entry.uncompressedSize) {
      throw zipError("ZIP_LOCAL_HEADER_MISMATCH", "local sizes or CRC differ from the central directory", { entryName: entry.name });
    }

    const dataOffset = entry.localHeaderOffset + 30 + variableLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > centralOffset) {
      throw zipError("ZIP_LOCAL_HEADER_INVALID", "compressed data crosses into the central directory", { entryName: entry.name });
    }
    const recordEnd = await parseDataDescriptor(fileHandle, entry, dataEnd, centralOffset);
    entry.dataOffset = dataOffset;
    spans.push({ start: entry.localHeaderOffset, end: recordEnd, entryName: entry.name });
  }

  spans.sort((left, right) => left.start - right.start);
  let expectedOffset = 0;
  for (const span of spans) {
    if (span.start !== expectedOffset || span.end <= span.start) {
      throw zipError("ZIP_LOCAL_LAYOUT_INVALID", "local records overlap or contain unsupported gaps", { entryName: span.entryName });
    }
    expectedOffset = span.end;
  }
  if (expectedOffset !== centralOffset) {
    throw zipError("ZIP_LOCAL_LAYOUT_INVALID", "local records do not end at the central directory");
  }
}

async function parseArchive(fileHandle, archiveSize, limits) {
  if (archiveSize > limits.maxArchiveBytes) throw zipError("ZIP_LIMIT_EXCEEDED", "archive size exceeds its limit");
  const { record: eocd, offset: eocdOffset } = await findEndOfCentralDirectory(fileHandle, archiveSize);
  const diskNumber = eocd.readUInt16LE(4);
  const centralDirectoryDisk = eocd.readUInt16LE(6);
  const entriesOnDisk = eocd.readUInt16LE(8);
  const entryCount = eocd.readUInt16LE(10);
  const centralSize = eocd.readUInt32LE(12);
  const centralOffset = eocd.readUInt32LE(16);
  if (entriesOnDisk === 0xffff || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw zipError("ZIP64_UNSUPPORTED", "EOCD contains a ZIP64 sentinel");
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw zipError("ZIP_MULTIDISK_UNSUPPORTED", "multi-disk archives are forbidden");
  }
  if (entryCount > limits.maxEntries) throw zipError("ZIP_LIMIT_EXCEEDED", "entry count exceeds its limit");
  if (centralSize > limits.maxCentralDirectoryBytes) {
    throw zipError("ZIP_LIMIT_EXCEEDED", "central directory size exceeds its limit");
  }
  if (centralOffset + centralSize !== eocdOffset) {
    throw zipError("ZIP_CENTRAL_DIRECTORY_INVALID", "central directory bounds do not match the EOCD");
  }
  const central = await readExactly(fileHandle, centralSize, centralOffset, "central directory");
  const parsed = parseCentralDirectory(central, entryCount, centralOffset, limits);
  await validateLocalHeaders(fileHandle, parsed.entries, centralOffset);
  return { ...parsed, archiveSize };
}

function sameArchiveStat(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

async function* readCompressedChunks(fileHandle, position, length) {
  let offset = 0;
  while (offset < length) {
    const requested = Math.min(64 * 1024, length - offset);
    const buffer = Buffer.allocUnsafe(requested);
    const { bytesRead } = await fileHandle.read(buffer, 0, requested, position + offset);
    if (bytesRead === 0) throw zipError("ZIP_TRUNCATED", "entry data is truncated");
    offset += bytesRead;
    yield bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
  }
}

async function consumeEntry(fileHandle, entry, onChunk) {
  if (entry.directory) return;
  let input;
  let inflater;
  let output;
  let actualSize = 0;
  let runningCrc32 = crc32Start();
  try {
    if (entry.compressedSize === 0) {
      output = [];
    } else {
      input = Readable.from(
        readCompressedChunks(fileHandle, entry.dataOffset, entry.compressedSize),
        { objectMode: false },
      );
      if (entry.compressionMethod === 8) {
        inflater = createInflateRaw();
        output = input.pipe(inflater);
      } else {
        output = input;
      }
    }
    for await (const chunk of output) {
      actualSize += chunk.length;
      if (actualSize > entry.uncompressedSize) {
        throw zipError("ZIP_SIZE_MISMATCH", "entry expands beyond its declared size", { entryName: entry.name });
      }
      runningCrc32 = crc32Update(runningCrc32, chunk);
      if (onChunk) await onChunk(chunk);
    }
  } catch (cause) {
    if (cause instanceof SafeUpdateZipError) throw cause;
    throw zipError("ZIP_DECOMPRESSION_FAILED", "entry data could not be decoded", { cause, entryName: entry.name });
  } finally {
    input?.destroy();
    inflater?.destroy();
  }
  if (inflater && inflater.bytesWritten !== entry.compressedSize) {
    throw zipError("ZIP_COMPRESSED_SIZE_MISMATCH", "deflate stream does not consume its declared size", { entryName: entry.name });
  }
  if (actualSize !== entry.uncompressedSize) {
    throw zipError("ZIP_SIZE_MISMATCH", "expanded size differs from the central directory", { entryName: entry.name });
  }
  const actualCrc32 = crc32Finish(runningCrc32);
  if (actualCrc32 !== entry.expectedCrc32) {
    throw zipError("ZIP_CRC_MISMATCH", "entry CRC-32 does not match", { entryName: entry.name });
  }
}

async function verifyPayloads(fileHandle, entries) {
  for (const entry of entries) await consumeEntry(fileHandle, entry);
}

function publicEntry(entry) {
  return Object.freeze({
    name: entry.name,
    directory: entry.directory,
    compressionMethod: entry.compressionMethod,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    crc32: entry.crc32,
  });
}

function archiveReport(archivePath, parsed) {
  return Object.freeze({
    archivePath,
    archiveSize: parsed.archiveSize,
    entries: Object.freeze(parsed.entries.map(publicEntry)),
    totalCompressedSize: parsed.totalCompressedSize,
    totalUncompressedSize: parsed.totalUncompressedSize,
  });
}

function resolveFilesystemPath(value, label, code) {
  if (typeof value !== "string" || !value) throw zipError(code, `${label} must be a non-empty path string`);
  return path.resolve(value);
}

async function openVerifiedArchive(zipPath, options, callback) {
  const limits = resolveLimits(options);
  const archivePath = resolveFilesystemPath(zipPath, "archive source", "ZIP_SOURCE_INVALID");
  let fileHandle;
  try {
    fileHandle = await open(archivePath, "r");
    const initialStat = await fileHandle.stat();
    if (!initialStat.isFile()) throw zipError("ZIP_SOURCE_INVALID", "archive source is not a regular file");
    const parsed = await parseArchive(fileHandle, initialStat.size, limits);
    await verifyPayloads(fileHandle, parsed.entries);
    const verifiedStat = await fileHandle.stat();
    if (!sameArchiveStat(initialStat, verifiedStat)) {
      throw zipError("ZIP_SOURCE_CHANGED", "archive changed while it was being verified");
    }
    return await callback({ archivePath, fileHandle, initialStat, parsed });
  } catch (cause) {
    if (cause instanceof SafeUpdateZipError) throw cause;
    throw zipError("ZIP_READ_FAILED", "archive could not be read", { cause });
  } finally {
    await fileHandle?.close();
  }
}

export async function inspectUpdateZip(zipPath, options) {
  return openVerifiedArchive(zipPath, options, async ({ archivePath, parsed }) => archiveReport(archivePath, parsed));
}

async function ensureOutputDirectory(targetRoot, segments, createdDirectories) {
  let current = targetRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (createdDirectories.has(current)) continue;
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (cause) {
      throw zipError("ZIP_TARGET_WRITE_FAILED", `cannot create output directory ${segments.join("/")}`, { cause });
    }
    createdDirectories.add(current);
  }
}

async function writeAll(fileHandle, chunk, entryName) {
  let offset = 0;
  while (offset < chunk.length) {
    let result;
    try {
      result = await fileHandle.write(chunk, offset, chunk.length - offset, null);
    } catch (cause) {
      throw zipError("ZIP_TARGET_WRITE_FAILED", "cannot write extracted entry", { cause, entryName });
    }
    if (result.bytesWritten <= 0) {
      throw zipError("ZIP_TARGET_WRITE_FAILED", "zero-byte write while extracting entry", { entryName });
    }
    offset += result.bytesWritten;
  }
}

function windowsDirectoryOperationIsUnsupported(cause, allowedCodes) {
  return process.platform === "win32"
    && allowedCodes.has(cause?.code);
}

async function syncDirectory(directoryPath) {
  let directoryHandle;
  try {
    directoryHandle = await open(directoryPath, "r");
  } catch (cause) {
    if (windowsDirectoryOperationIsUnsupported(cause, WINDOWS_DIRECTORY_OPEN_UNSUPPORTED_CODES)) return;
    throw zipError("ZIP_TARGET_SYNC_FAILED", `cannot open output directory for fsync: ${directoryPath}`, { cause });
  }
  try {
    await directoryHandle.sync();
  } catch (cause) {
    if (!windowsDirectoryOperationIsUnsupported(cause, WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED_CODES)) {
      throw zipError("ZIP_TARGET_SYNC_FAILED", `cannot fsync output directory: ${directoryPath}`, { cause });
    }
  } finally {
    try {
      await directoryHandle.close();
    } catch (cause) {
      throw zipError("ZIP_TARGET_SYNC_FAILED", `cannot close synced output directory: ${directoryPath}`, { cause });
    }
  }
}

async function syncCreatedDirectories(targetRoot, createdDirectories) {
  const deepestFirst = [...createdDirectories].sort((left, right) => {
    const leftDepth = path.relative(targetRoot, left).split(path.sep).filter(Boolean).length;
    const rightDepth = path.relative(targetRoot, right).split(path.sep).filter(Boolean).length;
    return rightDepth - leftDepth;
  });
  for (const directoryPath of deepestFirst) await syncDirectory(directoryPath);
  await syncDirectory(path.dirname(targetRoot));
}

async function extractPayloads(fileHandle, entries, targetRoot) {
  const createdDirectories = new Set([targetRoot]);
  for (const entry of entries) {
    if (entry.directory) {
      await ensureOutputDirectory(targetRoot, entry.segments, createdDirectories);
      continue;
    }
    await ensureOutputDirectory(targetRoot, entry.segments.slice(0, -1), createdDirectories);
    const outputPath = path.join(targetRoot, ...entry.segments);
    let outputHandle;
    try {
      outputHandle = await open(outputPath, "wx", entry.permissions);
      await consumeEntry(fileHandle, entry, async (chunk) => writeAll(outputHandle, chunk, entry.name));
      try {
        await outputHandle.sync();
      } catch (cause) {
        throw zipError("ZIP_TARGET_SYNC_FAILED", "cannot fsync extracted entry", { cause, entryName: entry.name });
      }
    } catch (cause) {
      if (cause instanceof SafeUpdateZipError) throw cause;
      throw zipError("ZIP_TARGET_WRITE_FAILED", "cannot create extracted entry with wx", { cause, entryName: entry.name });
    } finally {
      await outputHandle?.close();
    }
  }
  await syncCreatedDirectories(targetRoot, createdDirectories);
}

export async function extractUpdateZip(zipPath, targetDirectory, options) {
  return openVerifiedArchive(zipPath, options, async ({ archivePath, fileHandle, initialStat, parsed }) => {
    const targetRoot = resolveFilesystemPath(targetDirectory, "target directory", "ZIP_TARGET_INVALID");
    let targetCreated = false;
    try {
      await mkdir(targetRoot, { mode: 0o700 });
      targetCreated = true;
      await extractPayloads(fileHandle, parsed.entries, targetRoot);
      const finalStat = await fileHandle.stat();
      if (!sameArchiveStat(initialStat, finalStat)) {
        throw zipError("ZIP_SOURCE_CHANGED", "archive changed while it was being extracted");
      }
      return Object.freeze({
        ...archiveReport(archivePath, parsed),
        targetDirectory: targetRoot,
      });
    } catch (cause) {
      if (targetCreated) await rm(targetRoot, { recursive: true, force: true }).catch(() => {});
      if (cause instanceof SafeUpdateZipError) throw cause;
      if (cause?.code === "EEXIST") {
        throw zipError("ZIP_TARGET_EXISTS", "target directory must not exist", { cause });
      }
      throw zipError("ZIP_TARGET_WRITE_FAILED", "target directory could not be created", { cause });
    }
  });
}
