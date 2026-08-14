import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { createBase64UrlToken } from "./random.js";
import { deriveSha256Key, sha256 } from "./hash.js";

export const PERSONAL_DATA_MASTER_KEY_ENV = "PERSONAL_DATA_MASTER_KEY";
export const PERSONAL_DATA_MASTER_KEY_FILE_ENV = "PERSONAL_DATA_MASTER_KEY_FILE";
export const PERSONAL_DATA_MASTER_KEY_REQUIRED_ENV = "PERSONAL_DATA_MASTER_KEY_REQUIRED";
export const PERSONAL_DATA_MASTER_KEY_STARTUP_MODE_ENV = "PERSONAL_DATA_MASTER_KEY_STARTUP_MODE";
export const PERSONAL_DATA_MASTER_KEY_ALLOWED_ROOTS_ENV = "PERSONAL_DATA_MASTER_KEY_ALLOWED_ROOTS";

const MASTER_KEY_BYTES = 32;
const RAW_TEXT_MIN_CHARS = 32;
const DEFAULT_KEY_FILE_NAME = "bonni-core-personal-data.key";

type MasterKeySource = "env" | "file" | "runtime-file" | "generated-file";
export type PersonalDataMasterKeyStartupMode = "fail" | "locked" | "optional";

export type PersonalDataMasterKeyStatus = {
  loaded: boolean;
  required: boolean;
  startupMode: PersonalDataMasterKeyStartupMode;
  state: "LOADED" | "LOCKED" | "OPTIONAL_MISSING" | "UNCONFIGURED";
  source: MasterKeySource | null;
  sourceHint: string | null;
  fingerprint: string | null;
  loginBlocked: boolean;
  platformLoginBlocked: boolean;
  memberLoginBlocked: boolean;
  bootStickRequired: boolean;
  developerBootAllowed: boolean;
  developerBootEnabled: boolean;
  developerBootActive: boolean;
  adminLoginAllowedWithoutMasterKey: boolean;
  nonMemberLoginAllowedWithoutMasterKey: boolean;
  continueWithoutBootStickAcknowledged: boolean;
  continueWithoutBootStickDecisionRequired: boolean;
  lastError: string | null;
};

export type MasterKeyStorageLocation = {
  id: string;
  path: string;
  label: string;
  exists: boolean;
  writable: boolean;
  allowed: boolean;
  configured: boolean;
  recommendedFilePath: string;
};

export type InitializeMasterKeyStorageInput = {
  directoryPath: string;
  fileName?: string;
  overwrite?: boolean;
  loadAfterCreate?: boolean;
  confirmationPhrase?: string;
};

let cachedPersonalDataMasterKey: Buffer | null = null;
let cachedSource: MasterKeySource | null = null;
let cachedSourceHint: string | null = null;
let cachedFingerprint: string | null = null;
let continueWithoutBootStickAcknowledged = false;
let developerBootWithoutMasterKeyEnabled = false;
let lastError: string | null = null;

export function createPersonalDataMasterKey(): string {
  return `base64url:${createBase64UrlToken(MASTER_KEY_BYTES)}`;
}

export function preloadPersonalDataMasterKeyIfConfigured(): PersonalDataMasterKeyStatus {
  const filePath = readEnv(PERSONAL_DATA_MASTER_KEY_FILE_ENV);
  const envKey = readEnv(PERSONAL_DATA_MASTER_KEY_ENV);
  const required = isPersonalDataMasterKeyRequired();
  const startupMode = getPersonalDataMasterKeyStartupMode();

  if (!required && !filePath && !envKey) {
    return getPersonalDataMasterKeyStatus();
  }

  try {
    getPersonalDataMasterKey({ required: required || Boolean(filePath || envKey) });
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);

    if (required && startupMode === "fail") {
      throw error;
    }
  }

  return getPersonalDataMasterKeyStatus();
}

export function getPersonalDataMasterKey(options: { required?: boolean } = {}): Buffer {
  if (cachedPersonalDataMasterKey) {
    return Buffer.from(cachedPersonalDataMasterKey);
  }

  const required = options.required ?? isPersonalDataMasterKeyRequired();
  const filePath = readEnv(PERSONAL_DATA_MASTER_KEY_FILE_ENV);
  const envKey = readEnv(PERSONAL_DATA_MASTER_KEY_ENV);

  if (filePath) {
    return loadPersonalDataMasterKeyFromFile(filePath);
  }

  if (envKey) {
    cachePersonalDataMasterKey(parseMasterKeyValue(envKey), "env", PERSONAL_DATA_MASTER_KEY_ENV);
    return cloneCachedPersonalDataMasterKey();
  }

  if (required) {
    throw Object.assign(new Error("PERSONAL_DATA_MASTER_KEY_MISSING"), {
      statusCode: 500,
      details: {
        expected: `${PERSONAL_DATA_MASTER_KEY_FILE_ENV} or ${PERSONAL_DATA_MASTER_KEY_ENV}`,
      },
    });
  }

  throw Object.assign(new Error("PERSONAL_DATA_MASTER_KEY_NOT_CONFIGURED"), { statusCode: 500 });
}

export function loadPersonalDataMasterKeyFromFile(filePath: string): Buffer {
  const resolvedPath = resolveAllowedPath(filePath, { mustExist: true, mustBeFile: true });
  const fileContent = readFileSync(resolvedPath, "utf8");
  cachePersonalDataMasterKey(readMasterKeyFromText(fileContent), "runtime-file", resolvedPath);
  lastError = null;
  return cloneCachedPersonalDataMasterKey();
}

export function initializePersonalDataMasterKeyStorage(input: InitializeMasterKeyStorageInput) {
  if (input.confirmationPhrase !== "MASTER KEY USB INITIALISIEREN") {
    throw Object.assign(new Error("CONFIRMATION_PHRASE_REQUIRED"), {
      statusCode: 400,
      details: { expected: "MASTER KEY USB INITIALISIEREN" },
    });
  }

  const directoryPath = resolveAllowedPath(input.directoryPath, { mustExist: true, mustBeDirectory: true });
  const fileName = sanitizeKeyFileName(input.fileName || DEFAULT_KEY_FILE_NAME);
  const keyFilePath = resolveAllowedPath(join(directoryPath, fileName), { mustBeInsideAllowedRoot: true });

  if (existsSync(keyFilePath) && !input.overwrite) {
    throw Object.assign(new Error("MASTER_KEY_FILE_ALREADY_EXISTS"), {
      statusCode: 409,
      details: { filePath: keyFilePath },
    });
  }

  const keyValue = createPersonalDataMasterKey();
  writeFileSync(keyFilePath, `${keyValue}\n`, { encoding: "utf8", mode: 0o600, flag: input.overwrite ? "w" : "wx" });

  if (input.loadAfterCreate ?? true) {
    cachePersonalDataMasterKey(parseMasterKeyValue(keyValue), "generated-file", keyFilePath);
    lastError = null;
  }

  return {
    ok: true,
    filePath: keyFilePath,
    loadedIntoMemory: Boolean(input.loadAfterCreate ?? true),
    fingerprint: sha256(parseMasterKeyValue(keyValue)).slice(0, 16),
    note: "Der USB-/Speicherort wurde vorbereitet. Der Schlüssel liegt im Arbeitsspeicher; der Stick kann nach erfolgreicher Prüfung abgezogen werden.",
  };
}

export function getPersonalDataMasterKeyStatus(): PersonalDataMasterKeyStatus {
  const loaded = Boolean(cachedPersonalDataMasterKey);
  const required = isPersonalDataMasterKeyRequired();
  const startupMode = getPersonalDataMasterKeyStartupMode();
  const platformLoginBlocked = isPersonalDataAccessLocked();
  const developerBootActive = isPersonalDataDeveloperBootActive();
  const configuredFilePath = readEnv(PERSONAL_DATA_MASTER_KEY_FILE_ENV);

  return {
    loaded,
    required,
    startupMode,
    state: loaded
      ? "LOADED"
      : required
        ? "LOCKED"
        : configuredFilePath
          ? "OPTIONAL_MISSING"
          : "UNCONFIGURED",
    source: cachedSource,
    sourceHint: cachedSourceHint,
    fingerprint: cachedFingerprint,
    loginBlocked: platformLoginBlocked && !developerBootActive,
    platformLoginBlocked,
    memberLoginBlocked: platformLoginBlocked,
    bootStickRequired: required && !loaded,
    developerBootAllowed: required && !loaded,
    developerBootEnabled: developerBootWithoutMasterKeyEnabled,
    developerBootActive,
    adminLoginAllowedWithoutMasterKey: platformLoginBlocked,
    nonMemberLoginAllowedWithoutMasterKey: developerBootActive,
    continueWithoutBootStickAcknowledged,
    continueWithoutBootStickDecisionRequired: required && !loaded && !continueWithoutBootStickAcknowledged,
    lastError,
  };
}

export function acknowledgeContinueWithoutBootStick(continueWithoutBootStick: boolean): PersonalDataMasterKeyStatus {
  if (!continueWithoutBootStick) {
    continueWithoutBootStickAcknowledged = false;
    return getPersonalDataMasterKeyStatus();
  }

  if (isPersonalDataMasterKeyLoaded()) {
    continueWithoutBootStickAcknowledged = true;
    return getPersonalDataMasterKeyStatus();
  }

  continueWithoutBootStickAcknowledged = true;
  return getPersonalDataMasterKeyStatus();
}

export function setPersonalDataDeveloperBootWithoutMasterKey(enabled: boolean): PersonalDataMasterKeyStatus {
  developerBootWithoutMasterKeyEnabled = Boolean(enabled) && isPersonalDataMasterKeyRequired() && !isPersonalDataMasterKeyLoaded();
  if (developerBootWithoutMasterKeyEnabled) {
    continueWithoutBootStickAcknowledged = true;
  }
  return getPersonalDataMasterKeyStatus();
}

export function isPersonalDataDeveloperBootActive(): boolean {
  return developerBootWithoutMasterKeyEnabled && isPersonalDataMasterKeyRequired() && !isPersonalDataMasterKeyLoaded();
}

export function isPersonalDataAccessLocked(): boolean {
  return isPersonalDataMasterKeyRequired() && !isPersonalDataMasterKeyLoaded();
}

export function assertPersonalDataAccessUnlocked(): void {
  if (!isPersonalDataAccessLocked()) {
    return;
  }

  throw Object.assign(new Error("PERSONAL_DATA_MASTER_KEY_LOCKED"), {
    statusCode: 423,
    code: "PERSONAL_DATA_MASTER_KEY_LOCKED",
    details: getPersonalDataMasterKeyStatus(),
  });
}

export type PersonalDataLoginGuardUser = {
  accountId?: string | null;
  loginName?: string | null;
  memberId?: string | null;
  roles?: string[] | null;
  isSandbox?: boolean | null;
};

export function assertPersonalDataLoginAllowed(user: PersonalDataLoginGuardUser): void {
  if (!isPersonalDataAccessLocked()) {
    return;
  }

  // Admins müssen sich auch ohne geladenen Master-Key anmelden können,
  // damit System, Boot-Stick-Nachladen und Sicherheitsverwaltung erreichbar bleiben.
  if (isAdminLoginAccount(user)) {
    return;
  }

  if (isPersonalDataDeveloperBootActive()) {
    if (!isMemberLoginAccount(user)) {
      return;
    }

    throw Object.assign(new Error("PERSONAL_DATA_MEMBER_LOGIN_LOCKED"), {
      statusCode: 423,
      code: "PERSONAL_DATA_MEMBER_LOGIN_LOCKED",
      details: {
        ...getPersonalDataMasterKeyStatus(),
        accountId: user.accountId || null,
        memberId: user.memberId || null,
        reason: "DEVELOPER_BOOT_WITHOUT_MASTER_KEY_BLOCKS_MEMBER_LOGIN",
      },
    });
  }

  throw Object.assign(new Error("PERSONAL_DATA_MASTER_KEY_LOCKED"), {
    statusCode: 423,
    code: "PERSONAL_DATA_MASTER_KEY_LOCKED",
    details: {
      ...getPersonalDataMasterKeyStatus(),
      accountId: user.accountId || null,
      memberId: user.memberId || null,
      reason: "MASTER_KEY_MISSING_NON_ADMIN_LOGIN_BLOCKED",
    },
  });
}

export function isPersonalDataMasterKeyLoaded(): boolean {
  return Boolean(cachedPersonalDataMasterKey);
}

export function forgetPersonalDataMasterKeyForShutdown(): void {
  if (cachedPersonalDataMasterKey) {
    cachedPersonalDataMasterKey.fill(0);
  }

  cachedPersonalDataMasterKey = null;
  cachedSource = null;
  cachedSourceHint = null;
  cachedFingerprint = null;
}

export function listPersonalDataMasterKeyStorageLocations(): MasterKeyStorageLocation[] {
  const locations = new Map<string, MasterKeyStorageLocation>();
  const configuredFile = readEnv(PERSONAL_DATA_MASTER_KEY_FILE_ENV);

  for (const root of getAllowedStorageRoots()) {
    collectStorageLocation(locations, root, Boolean(configuredFile && dirname(resolve(configuredFile)) === resolve(root)));

    if (existsSync(root)) {
      for (const entry of safeReadDirectories(root)) {
        collectStorageLocation(locations, join(root, entry), Boolean(configuredFile && dirname(resolve(configuredFile)) === resolve(join(root, entry))));
      }
    }
  }

  if (configuredFile) {
    collectStorageLocation(locations, dirname(resolve(configuredFile)), true);
  }

  return Array.from(locations.values()).sort((a, b) => Number(b.configured) - Number(a.configured) || a.path.localeCompare(b.path));
}

function collectStorageLocation(map: Map<string, MasterKeyStorageLocation>, path: string, configured: boolean): void {
  const resolved = resolve(path);
  const exists = existsSync(resolved);
  const writable = exists && isWritableDirectory(resolved);
  const allowed = isInsideAllowedRoot(resolved);

  map.set(resolved, {
    id: sha256(resolved).slice(0, 16),
    path: resolved,
    label: basename(resolved) || resolved,
    exists,
    writable,
    allowed,
    configured,
    recommendedFilePath: join(resolved, DEFAULT_KEY_FILE_NAME),
  });
}

function safeReadDirectories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function cloneCachedPersonalDataMasterKey(): Buffer {
  if (!cachedPersonalDataMasterKey) {
    throw new Error("PERSONAL_DATA_MASTER_KEY_NOT_LOADED");
  }

  return Buffer.from(cachedPersonalDataMasterKey);
}

function cachePersonalDataMasterKey(key: Buffer, source: MasterKeySource, sourceHint: string): void {
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(`Personal-data master key must be ${MASTER_KEY_BYTES} bytes after normalization.`);
  }

  cachedPersonalDataMasterKey = Buffer.from(key);
  cachedSource = source;
  cachedSourceHint = source === "env" ? sourceHint : maskFilePath(sourceHint);
  cachedFingerprint = sha256(cachedPersonalDataMasterKey).slice(0, 16);
  developerBootWithoutMasterKeyEnabled = false;
}

function readMasterKeyFromText(text: string): Buffer {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const envLine = lines.find((line) => line.startsWith(`${PERSONAL_DATA_MASTER_KEY_ENV}=`));
  if (envLine) {
    return parseMasterKeyValue(envLine.slice(PERSONAL_DATA_MASTER_KEY_ENV.length + 1));
  }

  if (!lines[0]) {
    throw new Error("PERSONAL_DATA_MASTER_KEY_FILE_EMPTY");
  }

  return parseMasterKeyValue(lines[0]);
}

function parseMasterKeyValue(rawValue: string): Buffer {
  const value = stripQuotes(rawValue.trim());
  if (!value) {
    throw new Error("PERSONAL_DATA_MASTER_KEY_EMPTY");
  }

  if (value.startsWith("base64url:")) {
    return requireExactKeyLength(Buffer.from(value.slice("base64url:".length), "base64url"));
  }

  if (value.startsWith("base64:")) {
    return requireExactKeyLength(Buffer.from(value.slice("base64:".length), "base64"));
  }

  if (value.startsWith("hex:")) {
    return requireExactKeyLength(Buffer.from(value.slice("hex:".length), "hex"));
  }

  if (value.startsWith("raw:") || value.startsWith("text:")) {
    return deriveFromRawText(value.slice(value.indexOf(":") + 1));
  }

  if (/^[a-f0-9]{64}$/iu.test(value)) {
    return requireExactKeyLength(Buffer.from(value, "hex"));
  }

  try {
    return requireExactKeyLength(Buffer.from(value, "base64url"));
  } catch {
    return deriveFromRawText(value);
  }
}

function deriveFromRawText(value: string): Buffer {
  if (value.length < RAW_TEXT_MIN_CHARS) {
    throw new Error(`Raw master-key text must be at least ${RAW_TEXT_MIN_CHARS} characters.`);
  }

  return deriveSha256Key(value);
}

function requireExactKeyLength(buffer: Buffer): Buffer {
  if (buffer.length !== MASTER_KEY_BYTES) {
    throw new Error(`Personal-data master key must decode to exactly ${MASTER_KEY_BYTES} bytes.`);
  }

  return buffer;
}

function resolveAllowedPath(filePath: string, options: { mustExist?: boolean; mustBeFile?: boolean; mustBeDirectory?: boolean; mustBeInsideAllowedRoot?: boolean } = {}): string {
  const resolved = resolve(filePath);
  const existingPath = existsSync(resolved) ? realpathSync(resolved) : resolve(dirname(resolved));

  if (options.mustExist && !existsSync(resolved)) {
    throw Object.assign(new Error("PATH_NOT_FOUND"), { statusCode: 404, details: { path: resolved } });
  }

  if (options.mustBeInsideAllowedRoot !== false && !isInsideAllowedRoot(existingPath)) {
    throw Object.assign(new Error("PATH_NOT_IN_ALLOWED_MASTER_KEY_ROOT"), {
      statusCode: 400,
      details: { path: resolved, allowedRoots: getAllowedStorageRoots() },
    });
  }

  if (existsSync(resolved)) {
    const stat = statSync(resolved);
    if (options.mustBeFile && !stat.isFile()) {
      throw Object.assign(new Error("PATH_NOT_FILE"), { statusCode: 400, details: { path: resolved } });
    }
    if (options.mustBeDirectory && !stat.isDirectory()) {
      throw Object.assign(new Error("PATH_NOT_DIRECTORY"), { statusCode: 400, details: { path: resolved } });
    }
  }

  return resolved;
}

function isInsideAllowedRoot(path: string): boolean {
  const resolvedPath = resolve(path);
  return getAllowedStorageRoots().some((root) => {
    const resolvedRoot = resolve(root);
    return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
  });
}

function getAllowedStorageRoots(): string[] {
  const configured = readEnv(PERSONAL_DATA_MASTER_KEY_ALLOWED_ROOTS_ENV)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const roots = configured.length > 0 ? configured : ["/mnt", "/media", "/run/media", "/Volumes"];
  const configuredFile = readEnv(PERSONAL_DATA_MASTER_KEY_FILE_ENV);

  if (configuredFile) {
    roots.push(dirname(resolve(configuredFile)));
  }

  return [...new Set(roots.map((root) => resolve(root)))];
}

function isWritableDirectory(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    accessSync(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function sanitizeKeyFileName(fileName: string): string {
  const cleaned = basename(fileName.trim() || DEFAULT_KEY_FILE_NAME);
  if (!/^[a-zA-Z0-9._-]+$/u.test(cleaned)) {
    throw Object.assign(new Error("INVALID_MASTER_KEY_FILE_NAME"), { statusCode: 400 });
  }

  return cleaned;
}

function isMemberLoginAccount(user: PersonalDataLoginGuardUser): boolean {
  return Boolean(user.memberId?.trim());
}

export function isPersonalDataAdminLoginAccount(user: PersonalDataLoginGuardUser): boolean {
  const roles = Array.isArray(user.roles) ? user.roles : [];
  const hasAdminRole = roles.some((role) => {
    const normalized = String(role).trim().toUpperCase();
    return [
      "*",
      "ADMIN",
      "SYSTEM_ADMIN",
      "SYSTEM.ADMIN",
    ].includes(normalized);
  });

  return hasAdminRole;
}

function isAdminLoginAccount(user: PersonalDataLoginGuardUser): boolean {
  return isPersonalDataAdminLoginAccount(user);
}

function getPersonalDataMasterKeyStartupMode(): PersonalDataMasterKeyStartupMode {
  const value = readEnv(PERSONAL_DATA_MASTER_KEY_STARTUP_MODE_ENV).toLowerCase();
  if (value === "fail" || value === "optional" || value === "locked") {
    return value;
  }

  return "locked";
}

function isPersonalDataMasterKeyRequired(): boolean {
  return ["1", "true", "yes", "required"].includes(readEnv(PERSONAL_DATA_MASTER_KEY_REQUIRED_ENV).toLowerCase());
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

function readEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function maskFilePath(filePath: string): string {
  const resolved = resolve(filePath);
  return `.../${basename(dirname(resolved))}/${basename(resolved)}`;
}
