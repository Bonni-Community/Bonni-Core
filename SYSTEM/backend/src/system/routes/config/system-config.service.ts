import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

import { env } from "../../../core/config/env.js";
import {
  configureDatabaseRouting,
  getDatabaseRoutingStatus,
  getDatabaseTargetConnectionString,
  isDatabaseConnectionFailure,
  type DatabaseRoutingMode,
} from "../../../core/database/database-routing.js";
import { prisma, replayJsonEmergencyWrites } from "../../../core/database/prisma.js";
import {
  getJsonEmergencyStatus,
  markJsonEmergencyDatabaseRecovered,
} from "../../../core/database/json-emergency-store.js";
import { getRunSystemRoot, getRunSystemSystemRoot } from "../../boot/run-system/index.js";
import {
  getExternalTwoFactorProviderAdminStates,
  updateExternalTwoFactorProviderAdminState,
} from "../../../platform/security/two-factor/two-factor-provider-registry.js";

const { Client } = pg;

const CURRENT_JSON_FILE = "current.json";

const timecapsuleApi = {
  async storageStatus() {
    return {
      storageRoot: null,
      categories: [],
      sync: { enabled: false, reason: "TIMECAPSULE_ADDON_NOT_INSTALLED" },
    };
  },
  async recordSystemEvent(_event: string, _metadata?: unknown) {
    return { ok: false, skipped: true, reason: "TIMECAPSULE_ADDON_NOT_INSTALLED" };
  },
  async syncStorage(_input?: unknown) {
    return { ok: false, skipped: true, reason: "TIMECAPSULE_ADDON_NOT_INSTALLED" };
  },
};

const SETTING_KEYS = {
  authMode: "auth.mode",
  oidcEnabled: "auth.oidc.enabled",
  oidcIssuerUrl: "auth.oidc.issuerUrl",
  oidcClientId: "auth.oidc.clientId",
  oidcClientSecret: "auth.oidc.clientSecret",
  oidcRedirectUri: "auth.oidc.redirectUri",
  oidcPostLogoutRedirectUri: "auth.oidc.postLogoutRedirectUri",

  databaseOperationMode: "runtime.database.operationMode",
  databaseSyncMode: "runtime.database.syncMode",
  databaseProvider: "runtime.database.provider",
  databaseHost: "runtime.database.host",
  databasePort: "runtime.database.port",
  databaseUsername: "runtime.database.username",
  databasePassword: "runtime.database.password",
  databaseName: "runtime.database.name",
  databaseSchema: "runtime.database.schema",
  databaseSslMode: "runtime.database.sslMode",
  databaseAutoConnect: "runtime.database.autoConnect",
  redundantDatabaseAutoConnect: "runtime.database.redundant.autoConnect",
  databaseUrl: "runtime.database.databaseUrl",
  localDatabaseUrl: "runtime.database.localDatabaseUrl",
  serverDatabaseUrl: "runtime.database.serverDatabaseUrl",
  backupDatabaseUrl: "runtime.database.backupDatabaseUrl",

  jsonEnabled: "system.json.enabled",
  jsonBackupEnabled: "system.json.backup.enabled",
  jsonBackupPath: "system.json.backup.path",

  timecapsuleEmergencyMode: "timecapsule.emergencyMode",
  timecapsuleLastStartedAt: "timecapsule.lastStartedAt",
  timecapsuleLastEndedAt: "timecapsule.lastEndedAt",
  timecapsuleLastManualSyncAt: "timecapsule.lastManualSyncAt",
} as const;

const ALL_SETTING_KEYS = Object.values(SETTING_KEYS);

type SettingRow = {
  key: string;
  value: unknown;
  updatedAt?: Date | string | null;
};

type SystemSettingDelegate = {
  findMany(args: unknown): Promise<SettingRow[]>;
  upsert(args: unknown): Promise<SettingRow>;
};

type AuthProviderDelegate = {
  findUnique(args: unknown): Promise<{
    id: string;
    key: string;
    type: string;
    name: string;
    issuerUrl?: string | null;
    clientId?: string | null;
    active: boolean;
    updatedAt?: Date | string | null;
  } | null>;
  upsert(args: unknown): Promise<unknown>;
};

type SystemAuthModeDelegate = {
  updateMany(args: unknown): Promise<unknown>;
  create(args: unknown): Promise<unknown>;
};

type PrismaWithSystemConfig = typeof prisma & {
  systemSetting?: SystemSettingDelegate;
  authProvider?: AuthProviderDelegate;
  systemAuthMode?: SystemAuthModeDelegate;
};

type OidcSettings = {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
  clientSecretConfigured?: boolean;
  redirectUri: string;
  postLogoutRedirectUri: string;
  configured?: boolean;
  storage?: "database";
};

type TwoFactorSettings = {
  provider: string;
  configured: boolean;
  externalProviders: Awaited<ReturnType<typeof getExternalTwoFactorProviderAdminStates>>;
  storage?: "core" | "plugin";
};

type DatabaseProvider = "postgresql" | "mariadb" | "mysql";

type DatabaseSettings = {
  operationMode: "local-only" | "server-only" | "local-to-server";
  syncMode: "disabled" | "manual";
  provider: DatabaseProvider;
  host: string;
  port: string;
  username: string;
  password: string;
  databaseName: string;
  schema: string;
  sslMode: DatabaseProbeSslMode;
  autoConnect: boolean;
  databaseUrl: string;
  localDatabaseUrl: string;
  serverDatabaseUrl: string;
  backupDatabaseUrl: string;
  redacted?: {
    databaseUrl: string | null;
    localDatabaseUrl: string | null;
    serverDatabaseUrl: string | null;
    backupDatabaseUrl: string | null;
    bootDatabaseUrl: string | null;
  };
  storage?: "database";
};

type JsonSettings = {
  enabled: boolean;
  backupEnabled: boolean;
  backupPath: string;
  currentFile: string;
  current: unknown | null;
  currentAvailable: boolean;
  currentPurpose: string;
  requiredForRunContainer: boolean;
  storage?: "database";
};

type NotlaufSettings = {
  enabled: boolean;
  statusLabel: string;
  storageRoot: string;
  bootstrapFile: string;
  masterFile: string;
  pendingRecords: number;
  pendingFiles: number;
  categories: unknown[];
  sync: unknown;
  lastStartedAt: string | null;
  lastEndedAt: string | null;
  lastManualSyncAt: string | null;
  note: string;
  storage?: "database";
};

type RuntimeSettings = {
  authMode: string;
  platformPort: number;
  localAuthPort: number;
  localAuthBind: string;
  runSystemRoot: string;
  runSystemSystemRoot: string;
  settingsStorage: string;
  bootDatabaseUrl: string | null;
  note: string;
};

type SystemSettings = {
  ok: true;
  area: "system";
  source: "database";
  oidc: OidcSettings;
  twoFactor: TwoFactorSettings;
  database: DatabaseSettings;
  json: JsonSettings;
  notlauf: NotlaufSettings;
  runtime: RuntimeSettings;
  restartRequired: boolean;
  updatedAt: string | null;
};

type SettingMap = Map<string, SettingRow>;

type DatabaseProbeTarget = "normal" | "redundant";
type DatabaseProbeSslMode = "disable" | "prefer" | "require";

type DatabaseProbeConfig = {
  target: DatabaseProbeTarget;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema: string;
  sslMode: DatabaseProbeSslMode;
};

type StoredDatabaseTarget = DatabaseProbeConfig & {
  autoConnect: boolean;
};

function db() {
  return prisma as PrismaWithSystemConfig;
}

function settingsDelegate(): SystemSettingDelegate {
  const delegate = db().systemSetting;
  if (!delegate) {
    throw new Error("SYSTEM_SETTING_MODEL_NOT_AVAILABLE");
  }
  return delegate;
}

function currentJsonPath() {
  return path.join(getRunSystemSystemRoot(), CURRENT_JSON_FILE);
}

function toBool(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "enabled", "aktiv"].includes(normalized)) return true;
    if (["0", "false", "no", "off", "disabled", "inaktiv", ""].includes(normalized)) return false;
  }
  return fallback;
}

function text(value: unknown, fallback = "") {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function settingValue(settings: SettingMap, key: string, fallback: unknown = undefined) {
  return settings.has(key) ? settings.get(key)?.value : fallback;
}

function textSetting(settings: SettingMap, key: string, fallback = "") {
  return text(settingValue(settings, key, fallback), fallback);
}

function boolSetting(settings: SettingMap, key: string, fallback = false) {
  return toBool(settingValue(settings, key, fallback), fallback);
}

function databaseOperationMode(value: unknown): DatabaseSettings["operationMode"] {
  return value === "local-only" || value === "local-to-server" || value === "server-only"
    ? value
    : "server-only";
}

function databaseSyncMode(value: unknown): DatabaseSettings["syncMode"] {
  return value === "disabled" || value === "manual" ? value : "manual";
}

function databaseProvider(value: unknown): DatabaseProvider {
  return value === "mariadb" || value === "mysql" || value === "postgresql" ? value : "postgresql";
}

function databaseSslMode(value: unknown): DatabaseProbeSslMode {
  return value === "disable" || value === "require" ? value : "prefer";
}

function defaultDatabasePort(provider: DatabaseProvider) {
  return provider === "postgresql" ? "5432" : "3306";
}

function databaseScheme(provider: DatabaseProvider) {
  return provider === "postgresql" ? "postgresql" : "mysql";
}

function parseDatabaseUrl(connectionString: string): Partial<DatabaseSettings> {
  if (!connectionString) return {};

  try {
    const parsed = new URL(connectionString);
    const protocol = parsed.protocol.replace(":", "");
    const provider = databaseProvider(protocol === "mariadb" ? "mariadb" : protocol === "mysql" ? "mysql" : "postgresql");

    return {
      provider,
      host: parsed.hostname || "localhost",
      port: parsed.port || defaultDatabasePort(provider),
      username: decodeURIComponent(parsed.username || ""),
      password: decodeURIComponent(parsed.password || ""),
      databaseName: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
      schema: parsed.searchParams.get("schema") || "public",
      sslMode: databaseSslMode(parsed.searchParams.get("sslmode")),
    };
  } catch {
    return {};
  }
}

function encodeUrlPart(value: string) {
  return encodeURIComponent(value || "");
}

function buildDatabaseUrl(input: Partial<DatabaseSettings>) {
  const provider = databaseProvider(input.provider);
  const scheme = databaseScheme(provider);
  const username = encodeUrlPart(text(input.username, "postgres").trim() || "postgres");
  const password = encodeUrlPart(text(input.password, "").trim());
  const host = text(input.host, "localhost").trim() || "localhost";
  const port = text(input.port, defaultDatabasePort(provider)).trim();
  const databaseName = encodeUrlPart(text(input.databaseName, "bonni_core").trim() || "bonni_core");
  const auth = password ? `${username}:${password}` : username;
  const portPart = port ? `:${port}` : "";
  const query = new URLSearchParams();

  if (provider === "postgresql") {
    query.set("schema", text(input.schema, "public").trim() || "public");
    query.set("sslmode", databaseSslMode(input.sslMode));
  }

  const queryPart = query.size ? `?${query.toString()}` : "";
  return `${scheme}://${auth}@${host}${portPart}/${databaseName}${queryPart}`;
}

function redactConnectionString(connectionString: string) {
  if (!connectionString) return null;

  try {
    const parsed = new URL(connectionString);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "configured";
  }
}

function maxUpdatedAt(rows: SettingRow[]) {
  const timestamps = rows
    .map((row) => row.updatedAt)
    .filter(Boolean)
    .map((value) => new Date(value as string | Date).getTime())
    .filter((value) => Number.isFinite(value));

  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

async function readCurrentJson() {
  try {
    return JSON.parse(await fs.readFile(currentJsonPath(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readTimecapsuleStorageStatus() {
  try {
    return await timecapsuleApi.storageStatus();
  } catch (error) {
    return {
      driver: "unavailable",
      storageRoot: "",
      masterFile: "",
      bootstrapFile: "",
      sync: {
        emergencyBlocked: true,
        note: error instanceof Error ? error.message : String(error),
      },
      categories: [],
    };
  }
}

function isoText(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

function summarizePending(storage: any) {
  const categories = Array.isArray(storage?.categories) ? storage.categories : [];
  let pendingRecords = 0;
  let pendingFiles = 0;

  for (const category of categories) {
    const files = Array.isArray(category?.files) ? category.files : [];
    for (const file of files) {
      const count = Number(file?.pendingRecords ?? 0);
      if (Number.isFinite(count)) {
        pendingRecords += count;
        if (count > 0) pendingFiles += 1;
      }
    }
  }

  return { pendingRecords, pendingFiles };
}

function buildNotlaufSettings(settings: SettingMap, storage: any): NotlaufSettings {
  const enabled = boolSetting(settings, SETTING_KEYS.timecapsuleEmergencyMode, false);
  const pending = summarizePending(storage);

  return {
    enabled,
    statusLabel: enabled ? "Notlauf aktiv" : "Normalbetrieb",
    storageRoot: text(storage?.storageRoot, ""),
    bootstrapFile: text(storage?.bootstrapFile, ""),
    masterFile: text(storage?.masterFile, ""),
    pendingRecords: pending.pendingRecords,
    pendingFiles: pending.pendingFiles,
    categories: Array.isArray(storage?.categories) ? storage.categories : [],
    sync: {
      ...(storage?.sync && typeof storage.sync === "object" ? storage.sync : {}),
      emergencyBlocked: enabled || Boolean(storage?.sync?.emergencyBlocked),
      dbEmergencyMode: enabled,
      note: enabled
        ? "Notlauf ist in SystemSetting aktiv. Neue Änderungen bleiben zuerst in den verschlüsselten lokalen Dateien. Übernahme in die Datenbank erst beim Beenden oder manuellen Übernehmen."
        : storage?.sync?.note || "Timecapsule-Dateien können in die Datenbank übernommen werden.",
    },
    lastStartedAt: isoText(settingValue(settings, SETTING_KEYS.timecapsuleLastStartedAt, null)),
    lastEndedAt: isoText(settingValue(settings, SETTING_KEYS.timecapsuleLastEndedAt, null)),
    lastManualSyncAt: isoText(settingValue(settings, SETTING_KEYS.timecapsuleLastManualSyncAt, null)),
    note: "Die drei Capsule-Dateien werden hier nicht geöffnet/angezeigt, sondern entschlüsselt und sauber in die Datenbank-Tabelle TimeCapsuleEvent übernommen.",
    storage: "database",
  };
}

async function readSettingRows() {
  const rows = await settingsDelegate().findMany({
    where: {
      key: {
        in: ALL_SETTING_KEYS,
      },
    },
    orderBy: {
      key: "asc",
    },
  });

  return rows;
}

function rowsToMap(rows: SettingRow[]): SettingMap {
  return new Map(rows.map((row) => [row.key, row]));
}

async function readOidcProvider() {
  try {
    return await db().authProvider?.findUnique({ where: { key: "oidc" } });
  } catch {
    return null;
  }
}

async function upsertSetting(key: string, value: unknown) {
  return settingsDelegate().upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

async function upsertSettings(values: Record<string, unknown>) {
  await Promise.all(Object.entries(values).map(([key, value]) => upsertSetting(key, value)));
}

async function upsertOidcProvider(values: {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
}) {
  const delegate = db().authProvider;
  if (!delegate) return;

  await delegate.upsert({
    where: { key: "oidc" },
    update: {
      type: "OIDC",
      name: "OIDC Login",
      issuerUrl: values.issuerUrl || null,
      clientId: values.clientId || null,
      active: values.enabled,
    },
    create: {
      key: "oidc",
      type: "OIDC",
      name: "OIDC Login",
      issuerUrl: values.issuerUrl || null,
      clientId: values.clientId || null,
      active: values.enabled,
    },
  });
}

async function recordAuthMode(mode: "LOCAL" | "OIDC") {
  const delegate = db().systemAuthMode;
  if (!delegate) return;

  try {
    await delegate.updateMany({ where: { active: true }, data: { active: false } });
    await delegate.create({
      data: {
        mode,
        reason: "system-system-db-config",
        active: true,
      },
    });
  } catch {
    // Der Eintrag ist nur Verlauf/Anzeige. Wenn das Modell noch nicht bereit ist,
    // darf das Speichern der Hauptkonfiguration nicht scheitern.
  }
}

function normalizePayload(input: any, current: SystemSettings) {
  const nextOidc = input?.oidc ?? {};
  const nextDatabase = input?.database ?? {};
  const nextJson = input?.json ?? {};
  const nextNotlauf = input?.notlauf ?? {};

  const oidcEnabled = toBool(nextOidc.enabled, current.oidc.enabled);
  const authMode = oidcEnabled ? "OIDC" : "LOCAL";
  const clientSecret = text(nextOidc.clientSecret, "").trim();
  const values: Record<string, unknown> = {
    [SETTING_KEYS.authMode]: authMode,
    [SETTING_KEYS.oidcEnabled]: oidcEnabled,
    [SETTING_KEYS.oidcIssuerUrl]: text(nextOidc.issuerUrl, current.oidc.issuerUrl).trim(),
    [SETTING_KEYS.oidcClientId]: text(nextOidc.clientId, current.oidc.clientId).trim(),
    [SETTING_KEYS.oidcRedirectUri]: text(nextOidc.redirectUri, current.oidc.redirectUri).trim(),
    [SETTING_KEYS.oidcPostLogoutRedirectUri]: text(
      nextOidc.postLogoutRedirectUri,
      current.oidc.postLogoutRedirectUri,
    ).trim(),

    [SETTING_KEYS.databaseOperationMode]: databaseOperationMode(
      nextDatabase.operationMode ?? current.database.operationMode,
    ),
    [SETTING_KEYS.databaseSyncMode]: databaseSyncMode(nextDatabase.syncMode ?? current.database.syncMode),
    [SETTING_KEYS.databaseProvider]: databaseProvider(nextDatabase.provider ?? current.database.provider),
    [SETTING_KEYS.databaseHost]: text(nextDatabase.host, current.database.host).trim(),
    [SETTING_KEYS.databasePort]: text(nextDatabase.port, current.database.port).trim(),
    [SETTING_KEYS.databaseUsername]: text(nextDatabase.username, current.database.username).trim(),
    [SETTING_KEYS.databasePassword]: text(nextDatabase.password, current.database.password).trim(),
    [SETTING_KEYS.databaseName]: text(nextDatabase.databaseName, current.database.databaseName).trim(),
    [SETTING_KEYS.databaseSchema]: text(nextDatabase.schema, current.database.schema).trim() || "public",
    [SETTING_KEYS.databaseSslMode]: databaseSslMode(nextDatabase.sslMode ?? current.database.sslMode),
    [SETTING_KEYS.databaseAutoConnect]: toBool(nextDatabase.autoConnect, current.database.autoConnect),
    [SETTING_KEYS.databaseUrl]: buildDatabaseUrl({
      provider: databaseProvider(nextDatabase.provider ?? current.database.provider),
      host: text(nextDatabase.host, current.database.host).trim(),
      port: text(nextDatabase.port, current.database.port).trim(),
      username: text(nextDatabase.username, current.database.username).trim(),
      password: text(nextDatabase.password, current.database.password).trim(),
      databaseName: text(nextDatabase.databaseName, current.database.databaseName).trim(),
      schema: text(nextDatabase.schema, current.database.schema).trim() || "public",
      sslMode: databaseSslMode(nextDatabase.sslMode ?? current.database.sslMode),
    }),
    [SETTING_KEYS.localDatabaseUrl]: text(nextDatabase.localDatabaseUrl, current.database.localDatabaseUrl).trim(),
    [SETTING_KEYS.serverDatabaseUrl]: buildDatabaseUrl({
      provider: databaseProvider(nextDatabase.provider ?? current.database.provider),
      host: text(nextDatabase.host, current.database.host).trim(),
      port: text(nextDatabase.port, current.database.port).trim(),
      username: text(nextDatabase.username, current.database.username).trim(),
      password: text(nextDatabase.password, current.database.password).trim(),
      databaseName: text(nextDatabase.databaseName, current.database.databaseName).trim(),
      schema: text(nextDatabase.schema, current.database.schema).trim() || "public",
      sslMode: databaseSslMode(nextDatabase.sslMode ?? current.database.sslMode),
    }),
    [SETTING_KEYS.backupDatabaseUrl]: text(nextDatabase.backupDatabaseUrl, current.database.backupDatabaseUrl).trim(),

    [SETTING_KEYS.jsonEnabled]: toBool(nextJson.enabled, current.json.enabled),
    [SETTING_KEYS.jsonBackupEnabled]: toBool(nextJson.backupEnabled, current.json.backupEnabled),
    [SETTING_KEYS.jsonBackupPath]: text(nextJson.backupPath, current.json.backupPath).trim(),

    [SETTING_KEYS.timecapsuleEmergencyMode]: toBool(nextNotlauf.enabled, current.notlauf.enabled),
  };

  if (clientSecret) {
    values[SETTING_KEYS.oidcClientSecret] = clientSecret;
  }

  return {
    authMode: authMode as "LOCAL" | "OIDC",
    values,
  };
}

export async function getSystemSystemSettings(): Promise<SystemSettings> {
  const [rows, oidcProvider, currentJson, timecapsuleStorage, externalTwoFactorProviders] = await Promise.all([
    readSettingRows(),
    readOidcProvider(),
    readCurrentJson(),
    readTimecapsuleStorageStatus(),
    getExternalTwoFactorProviderAdminStates(),
  ]);
  const settings = rowsToMap(rows);

  const oidcEnabled = boolSetting(settings, SETTING_KEYS.oidcEnabled, false);
  const issuerUrl = textSetting(settings, SETTING_KEYS.oidcIssuerUrl, oidcProvider?.issuerUrl || "");
  const clientId = textSetting(settings, SETTING_KEYS.oidcClientId, oidcProvider?.clientId || "");
  const clientSecret = textSetting(settings, SETTING_KEYS.oidcClientSecret, "");
  const redirectUri = textSetting(settings, SETTING_KEYS.oidcRedirectUri, "");
  const postLogoutRedirectUri = textSetting(settings, SETTING_KEYS.oidcPostLogoutRedirectUri, "");
  const databaseUrl = textSetting(settings, SETTING_KEYS.databaseUrl, env.DATABASE_URL);
  const parsedDatabaseUrl = parseDatabaseUrl(databaseUrl);
  const provider = databaseProvider(textSetting(settings, SETTING_KEYS.databaseProvider, parsedDatabaseUrl.provider || "postgresql"));
  const host = textSetting(settings, SETTING_KEYS.databaseHost, parsedDatabaseUrl.host || "localhost");
  const port = textSetting(settings, SETTING_KEYS.databasePort, parsedDatabaseUrl.port || defaultDatabasePort(provider));
  const username = textSetting(settings, SETTING_KEYS.databaseUsername, parsedDatabaseUrl.username || "postgres");
  const password = textSetting(settings, SETTING_KEYS.databasePassword, parsedDatabaseUrl.password || "");
  const databaseName = textSetting(settings, SETTING_KEYS.databaseName, parsedDatabaseUrl.databaseName || "bonni_core");
  const schema = textSetting(settings, SETTING_KEYS.databaseSchema, parsedDatabaseUrl.schema || "public") || "public";
  const sslMode = databaseSslMode(textSetting(settings, SETTING_KEYS.databaseSslMode, parsedDatabaseUrl.sslMode || "prefer"));
  const autoConnect = boolSetting(settings, SETTING_KEYS.databaseAutoConnect, true);
  const builtDatabaseUrl = buildDatabaseUrl({ provider, host, port, username, password, databaseName, schema, sslMode });
  const localDatabaseUrl = textSetting(settings, SETTING_KEYS.localDatabaseUrl, env.LOCAL_DATABASE_URL);
  const serverDatabaseUrl = textSetting(settings, SETTING_KEYS.serverDatabaseUrl, builtDatabaseUrl || env.SERVER_DATABASE_URL);
  const backupDatabaseUrl = textSetting(settings, SETTING_KEYS.backupDatabaseUrl, "");

  const authMode = textSetting(settings, SETTING_KEYS.authMode, oidcEnabled ? "OIDC" : "LOCAL");

  const activeExternalTwoFactorProviders = externalTwoFactorProviders.filter((provider) => provider.enabled);
  if (activeExternalTwoFactorProviders.length > 1) {
    throw Object.assign(new Error("TWO_FACTOR_MULTIPLE_ACTIVE_PROVIDERS"), {
      code: "TWO_FACTOR_MULTIPLE_ACTIVE_PROVIDERS",
      statusCode: 409,
    });
  }
  const activeExternalTwoFactorProvider = activeExternalTwoFactorProviders[0] || null;

  return {
    ok: true,
    area: "system",
    source: "database",
    oidc: {
      enabled: oidcEnabled,
      issuerUrl,
      clientId,
      clientSecret: "",
      clientSecretConfigured: Boolean(clientSecret),
      redirectUri,
      postLogoutRedirectUri,
      configured: Boolean(oidcEnabled && issuerUrl && clientId && redirectUri),
      storage: "database",
    },
    twoFactor: {
      provider: activeExternalTwoFactorProvider?.id || "local",
      configured: activeExternalTwoFactorProvider
        ? activeExternalTwoFactorProvider.configured
        : true,
      externalProviders: externalTwoFactorProviders,
      storage: externalTwoFactorProviders.length ? "plugin" : "core",
    },
    database: {
      operationMode: databaseOperationMode(textSetting(settings, SETTING_KEYS.databaseOperationMode, env.DATABASE_OPERATION_MODE)),
      syncMode: databaseSyncMode(textSetting(settings, SETTING_KEYS.databaseSyncMode, env.DATABASE_SYNC_MODE)),
      provider,
      host,
      port,
      username,
      password,
      databaseName,
      schema,
      sslMode,
      autoConnect,
      databaseUrl: builtDatabaseUrl,
      localDatabaseUrl,
      serverDatabaseUrl,
      backupDatabaseUrl,
      redacted: {
        databaseUrl: redactConnectionString(builtDatabaseUrl),
        localDatabaseUrl: redactConnectionString(localDatabaseUrl),
        serverDatabaseUrl: redactConnectionString(serverDatabaseUrl),
        backupDatabaseUrl: redactConnectionString(backupDatabaseUrl),
        bootDatabaseUrl: redactConnectionString(env.DATABASE_URL),
      },
      storage: "database",
    },
    json: {
      enabled: boolSetting(settings, SETTING_KEYS.jsonEnabled, true),
      backupEnabled: boolSetting(settings, SETTING_KEYS.jsonBackupEnabled, true),
      backupPath: textSetting(settings, SETTING_KEYS.jsonBackupPath, ""),
      currentFile: currentJsonPath(),
      current: currentJson,
      currentAvailable: Boolean(currentJson),
      currentPurpose:
        "current.json ist die lokale RunContainer-Markierung: aktiver Slot, System-Version, Schema-Version und Benutzeranzahl. Sie ist keine Benutzer-/OIDC-/Datenbank-Konfiguration.",
      requiredForRunContainer: true,
      storage: "database",
    },
    notlauf: buildNotlaufSettings(settings, timecapsuleStorage),
    runtime: {
      authMode,
      platformPort: env.PORT,
      localAuthPort: env.LOCAL_AUTH_PORT,
      localAuthBind: env.LOCAL_AUTH_BIND,
      runSystemRoot: getRunSystemRoot(),
      runSystemSystemRoot: getRunSystemSystemRoot(),
      settingsStorage: "PostgreSQL: SystemSetting",
      bootDatabaseUrl: redactConnectionString(env.DATABASE_URL),
      note:
        "Die System-Konfiguration wird in PostgreSQL/SystemSetting gespeichert. DATABASE_URL bleibt nur der Boot-Zugang, damit das Backend die Datenbank überhaupt öffnen kann.",
    },
    restartRequired: false,
    updatedAt: maxUpdatedAt(rows),
  };
}

export async function updateSystemSystemSettings(input: unknown): Promise<SystemSettings> {
  const current = await getSystemSystemSettings();
  const { authMode, values } = normalizePayload(input, current);
  const nextTwoFactor = (input as any)?.twoFactor;
  const externalProviders = current.twoFactor.externalProviders;

  if (nextTwoFactor && typeof nextTwoFactor === "object") {
    const requestedProvider = String(nextTwoFactor.provider || "local").trim().toLowerCase();
    const requestedExternalProvider = externalProviders.find((provider) => provider.id === requestedProvider);
    if (requestedProvider !== "local" && !requestedExternalProvider) {
      throw Object.assign(new Error("TWO_FACTOR_PROVIDER_NOT_INSTALLED"), {
        code: "TWO_FACTOR_PROVIDER_NOT_INSTALLED",
        statusCode: 409,
      });
    }
    const submittedProviders = Array.isArray(nextTwoFactor.externalProviders)
      ? nextTwoFactor.externalProviders
      : nextTwoFactor.externalProvider
        ? [nextTwoFactor.externalProvider]
        : [];
    const orderedProviders = [...externalProviders].sort((left, right) => (
      left.id === requestedProvider ? -1 : right.id === requestedProvider ? 1 : 0
    ));
    for (const external of orderedProviders) {
      const submitted = submittedProviders.find((provider: any) => provider?.id === external.id);
      const submittedValues = submitted?.configuration?.values;
      await updateExternalTwoFactorProviderAdminState(external.id, {
        ...external.configuration.values,
        ...(submittedValues && typeof submittedValues === "object" ? submittedValues : {}),
        enabled: requestedProvider === external.id,
      });
    }
  }

  await upsertSettings(values);
  await upsertOidcProvider({
    enabled: Boolean(values[SETTING_KEYS.oidcEnabled]),
    issuerUrl: text(values[SETTING_KEYS.oidcIssuerUrl], ""),
    clientId: text(values[SETTING_KEYS.oidcClientId], ""),
  });
  await recordAuthMode(authMode);

  return getSystemSystemSettings();
}

function databasePort(value: unknown, fallback: number) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function storedDatabaseTargets(settings: SettingMap) {
  const bootConfig = parseDatabaseUrl(env.SERVER_DATABASE_URL || env.DATABASE_URL);
  const normalUrl = textSetting(
    settings,
    SETTING_KEYS.serverDatabaseUrl,
    textSetting(settings, SETTING_KEYS.databaseUrl, env.SERVER_DATABASE_URL || env.DATABASE_URL),
  );
  const parsedNormal = {
    ...bootConfig,
    ...parseDatabaseUrl(normalUrl),
  };
  const normal: StoredDatabaseTarget = {
    target: "normal",
    host: textSetting(settings, SETTING_KEYS.databaseHost, parsedNormal.host || "localhost").trim() || "localhost",
    port: databasePort(
      textSetting(settings, SETTING_KEYS.databasePort, parsedNormal.port || "5432"),
      5432,
    ),
    database: textSetting(
      settings,
      SETTING_KEYS.databaseName,
      parsedNormal.databaseName || "bonni_core",
    ).trim() || "bonni_core",
    user: textSetting(
      settings,
      SETTING_KEYS.databaseUsername,
      parsedNormal.username || "postgres",
    ).trim() || "postgres",
    password: textSetting(
      settings,
      SETTING_KEYS.databasePassword,
      parsedNormal.password || "",
    ),
    schema: textSetting(
      settings,
      SETTING_KEYS.databaseSchema,
      parsedNormal.schema || "public",
    ).trim() || "public",
    sslMode: databaseSslMode(
      textSetting(settings, SETTING_KEYS.databaseSslMode, parsedNormal.sslMode || "prefer"),
    ),
    autoConnect: boolSetting(settings, SETTING_KEYS.databaseAutoConnect, true),
  };

  const backupUrl = textSetting(settings, SETTING_KEYS.backupDatabaseUrl, "");
  const parsedRedundant = parseDatabaseUrl(backupUrl);
  const redundant: StoredDatabaseTarget = {
    target: "redundant",
    host: text(parsedRedundant.host, normal.host).trim() || normal.host,
    port: databasePort(parsedRedundant.port, normal.port === 5432 ? 5433 : normal.port),
    database: text(parsedRedundant.databaseName, `${normal.database}_redundant`).trim()
      || `${normal.database}_redundant`,
    user: text(parsedRedundant.username, normal.user).trim() || normal.user,
    password: text(parsedRedundant.password, normal.password),
    schema: text(parsedRedundant.schema, normal.schema).trim() || normal.schema,
    sslMode: databaseSslMode(parsedRedundant.sslMode || normal.sslMode),
    autoConnect: boolSetting(settings, SETTING_KEYS.redundantDatabaseAutoConnect, false),
  };

  return { normal, redundant };
}

async function readStoredDatabaseTargets() {
  return storedDatabaseTargets(rowsToMap(await readSettingRows()));
}

function routingDatabaseTarget(
  target: DatabaseProbeTarget,
  connectionString: string,
  normal?: StoredDatabaseTarget,
): StoredDatabaseTarget {
  const parsed = parseDatabaseUrl(connectionString);
  return {
    target,
    host: text(parsed.host, normal?.host || "localhost").trim() || normal?.host || "localhost",
    port: databasePort(parsed.port, normal?.port || (target === "normal" ? 5432 : 5433)),
    database: text(
      parsed.databaseName,
      target === "normal" ? "bonni_core" : `${normal?.database || "bonni_core"}_redundant`,
    ).trim(),
    user: text(parsed.username, normal?.user || "postgres").trim() || normal?.user || "postgres",
    password: text(parsed.password, normal?.password || ""),
    schema: text(parsed.schema, normal?.schema || "public").trim() || "public",
    sslMode: databaseSslMode(parsed.sslMode || normal?.sslMode || "prefer"),
    autoConnect: target === "normal",
  };
}

function databaseTargetsFromRouting() {
  const normal = routingDatabaseTarget(
    "normal",
    getDatabaseTargetConnectionString("normal"),
  );
  let redundantUrl = "";
  try {
    redundantUrl = getDatabaseTargetConnectionString("redundant");
  } catch {
    // Eine noch nicht konfigurierte Redundanz wird nur als Platzhalter angezeigt.
  }
  const redundant = routingDatabaseTarget("redundant", redundantUrl, normal);
  return { normal, redundant };
}

async function readStoredDatabaseTargetsWithRoutingFallback() {
  try {
    return await readStoredDatabaseTargets();
  } catch (error) {
    if (!isDatabaseConnectionFailure(error)) throw error;
    return databaseTargetsFromRouting();
  }
}

async function databaseRoutingWithJsonStatus(
  routing = getDatabaseRoutingStatus(),
) {
  const jsonEmergency = await getJsonEmergencyStatus();
  return {
    ...routing,
    jsonEmergency: {
      ...routing.jsonEmergency,
      ...jsonEmergency,
    },
  };
}

function publicDatabaseTarget(config: StoredDatabaseTarget) {
  return {
    target: config.target,
    provider: "postgresql" as const,
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    passwordConfigured: Boolean(config.password),
    schema: config.schema,
    sslMode: config.sslMode,
    autoConnect: config.autoConnect,
    connectionUrl: redactConnectionString(buildDatabaseUrl({
      provider: "postgresql",
      host: config.host,
      port: String(config.port),
      username: config.user,
      password: config.password,
      databaseName: config.database,
      schema: config.schema,
      sslMode: config.sslMode,
    })),
  };
}

function storedDatabaseTargetUrl(config: StoredDatabaseTarget) {
  return buildDatabaseUrl({
    provider: "postgresql",
    host: config.host,
    port: String(config.port),
    username: config.user,
    password: config.password,
    databaseName: config.database,
    schema: config.schema,
    sslMode: config.sslMode,
  });
}

async function applyStoredTargetsToRuntime(
  targets: { normal: StoredDatabaseTarget; redundant: StoredDatabaseTarget },
  mode: DatabaseRoutingMode = getDatabaseRoutingStatus().mode,
) {
  return configureDatabaseRouting({
    mode,
    normalUrl: storedDatabaseTargetUrl(targets.normal),
    redundantUrl: storedDatabaseTargetUrl(targets.redundant),
  });
}

export async function getSystemDatabaseTargets() {
  let targets: { normal: StoredDatabaseTarget; redundant: StoredDatabaseTarget };
  let routing;
  try {
    targets = await readStoredDatabaseTargets();
    routing = await applyStoredTargetsToRuntime(targets);
    await markJsonEmergencyDatabaseRecovered();
  } catch (error) {
    if (!isDatabaseConnectionFailure(error)) throw error;
    targets = databaseTargetsFromRouting();
    routing = getDatabaseRoutingStatus();
  }
  return {
    ok: true,
    routing: await databaseRoutingWithJsonStatus(routing),
    targets: {
      normal: publicDatabaseTarget(targets.normal),
      redundant: publicDatabaseTarget(targets.redundant),
    },
  };
}

export async function getSystemDatabaseRouting() {
  return {
    ok: true,
    routing: await databaseRoutingWithJsonStatus(),
  };
}

export async function updateSystemDatabaseRouting(input: unknown) {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const requestedMode: DatabaseRoutingMode | null = body.mode === "normal"
    || body.mode === "redundant"
    || body.mode === "both"
    ? body.mode
    : null;
  const jsonEmergencyEnabled = typeof body.jsonEmergencyEnabled === "boolean"
    ? body.jsonEmergencyEnabled
    : undefined;

  if ((body.mode !== undefined && !requestedMode)
    || (!requestedMode && jsonEmergencyEnabled === undefined)) {
    throw Object.assign(new Error("DATABASE_WRITE_MODE_INVALID"), { statusCode: 400 });
  }

  const routing = await configureDatabaseRouting({
    mode: requestedMode || getDatabaseRoutingStatus().mode,
    jsonEmergencyEnabled,
  });

  return {
    ok: true,
    routing: await databaseRoutingWithJsonStatus(routing),
  };
}

export async function replaySystemJsonEmergency(input: unknown) {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const target = body.target === "normal" || body.target === "redundant"
    ? body.target
    : null;
  if (!target) {
    throw Object.assign(new Error("JSON_EMERGENCY_REPLAY_TARGET_INVALID"), {
      statusCode: 400,
      code: "JSON_EMERGENCY_REPLAY_TARGET_INVALID",
    });
  }
  const replay = await replayJsonEmergencyWrites(target);
  return {
    ...replay,
    routing: await databaseRoutingWithJsonStatus(),
  };
}

function normalizeDatabaseTargetUpdate(input: unknown, stored: StoredDatabaseTarget) {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rawConfig = body.config && typeof body.config === "object"
    ? body.config as Record<string, unknown>
    : {};
  const host = text(rawConfig.host, stored.host).trim();
  const port = Number(text(rawConfig.port, String(stored.port)));
  const database = text(rawConfig.database ?? rawConfig.databaseName, stored.database).trim();
  const user = text(rawConfig.user ?? rawConfig.username, stored.user).trim();
  const enteredPassword = text(rawConfig.password, "");
  const password = enteredPassword || stored.password;
  const schema = text(rawConfig.schema, stored.schema).trim() || "public";
  const sslMode = databaseSslMode(rawConfig.sslMode ?? stored.sslMode);
  const autoConnect = toBool(rawConfig.autoConnect, stored.autoConnect);

  if (!host || host.length > 253) {
    return invalidDatabaseProbe("Der Datenbank-Host ist ungültig.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return invalidDatabaseProbe("Der Datenbank-Port muss zwischen 1 und 65535 liegen.");
  }
  if (!database || database.length > 128) {
    return invalidDatabaseProbe("Der Datenbankname ist ungültig.");
  }
  if (!user || user.length > 128) {
    return invalidDatabaseProbe("Der Datenbankbenutzer ist ungültig.");
  }
  if (!schema || schema.length > 63) {
    return invalidDatabaseProbe("Das PostgreSQL-Schema ist ungültig.");
  }

  return {
    target: stored.target,
    host,
    port,
    database,
    user,
    password,
    schema,
    sslMode,
    autoConnect,
  } satisfies StoredDatabaseTarget;
}

export async function updateSystemDatabaseTarget(input: unknown) {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const target: DatabaseProbeTarget | null = body.target === "normal" || body.target === "redundant"
    ? body.target
    : null;

  if (!target) {
    return invalidDatabaseProbe("Datenbankziel muss 'normal' oder 'redundant' sein.");
  }

  const storedTargets = await readStoredDatabaseTargets();
  const config = normalizeDatabaseTargetUpdate(input, storedTargets[target]);
  const databaseUrl = buildDatabaseUrl({
    provider: "postgresql",
    host: config.host,
    port: String(config.port),
    username: config.user,
    password: config.password,
    databaseName: config.database,
    schema: config.schema,
    sslMode: config.sslMode,
  });

  if (target === "normal") {
    await upsertSettings({
      [SETTING_KEYS.databaseProvider]: "postgresql",
      [SETTING_KEYS.databaseHost]: config.host,
      [SETTING_KEYS.databasePort]: String(config.port),
      [SETTING_KEYS.databaseUsername]: config.user,
      [SETTING_KEYS.databasePassword]: config.password,
      [SETTING_KEYS.databaseName]: config.database,
      [SETTING_KEYS.databaseSchema]: config.schema,
      [SETTING_KEYS.databaseSslMode]: config.sslMode,
      [SETTING_KEYS.databaseAutoConnect]: config.autoConnect,
      [SETTING_KEYS.databaseUrl]: databaseUrl,
      [SETTING_KEYS.serverDatabaseUrl]: databaseUrl,
    });
  } else {
    await upsertSettings({
      [SETTING_KEYS.backupDatabaseUrl]: databaseUrl,
      [SETTING_KEYS.redundantDatabaseAutoConnect]: config.autoConnect,
    });
  }

  const updatedTargets = await readStoredDatabaseTargets();
  const routing = await applyStoredTargetsToRuntime(updatedTargets);
  return {
    ok: true,
    updatedTarget: target,
    routing: await databaseRoutingWithJsonStatus(routing),
    targets: {
      normal: publicDatabaseTarget(updatedTargets.normal),
      redundant: publicDatabaseTarget(updatedTargets.redundant),
    },
  };
}

function invalidDatabaseProbe(message: string): never {
  throw Object.assign(new Error(message), {
    statusCode: 400,
    code: "INVALID_DATABASE_PROBE",
  });
}

async function normalizeDatabaseProbe(input: unknown): Promise<DatabaseProbeConfig> {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const target = body.target === "redundant" ? "redundant" : body.target === "normal" ? "normal" : null;
  const rawConfig = body.config && typeof body.config === "object"
    ? body.config as Record<string, unknown>
    : {};

  if (!target) {
    return invalidDatabaseProbe("Datenbankziel muss 'normal' oder 'redundant' sein.");
  }

  const stored = (await readStoredDatabaseTargetsWithRoutingFallback())[target];
  const host = text(rawConfig.host, stored.host).trim();
  const port = Number(text(rawConfig.port, String(stored.port)));
  const database = text(
    rawConfig.database ?? rawConfig.databaseName,
    stored.database,
  ).trim();
  const user = text(rawConfig.user ?? rawConfig.username, stored.user).trim();
  const enteredPassword = text(rawConfig.password, "");
  const password = enteredPassword || stored.password;
  const schema = text(rawConfig.schema, stored.schema).trim() || "public";
  const sslMode = databaseSslMode(rawConfig.sslMode ?? stored.sslMode);

  if (!host || host.length > 253) {
    return invalidDatabaseProbe("Der Datenbank-Host ist ungültig.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return invalidDatabaseProbe("Der Datenbank-Port muss zwischen 1 und 65535 liegen.");
  }
  if (!database || database.length > 128) {
    return invalidDatabaseProbe("Der Datenbankname ist ungültig.");
  }
  if (!user || user.length > 128) {
    return invalidDatabaseProbe("Der Datenbankbenutzer ist ungültig.");
  }
  if (!schema || schema.length > 63) {
    return invalidDatabaseProbe("Das PostgreSQL-Schema ist ungültig.");
  }

  return { target, host, port, database, user, password, schema, sslMode };
}

function databaseProbeError(error: unknown) {
  const code = String((error as { code?: unknown } | null)?.code || "").toUpperCase();
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { code: "HOST_NOT_FOUND", message: "Der Datenbank-Host wurde nicht gefunden." };
  }
  if (code === "ECONNREFUSED") {
    return { code: "CONNECTION_REFUSED", message: "Der Host ist erreichbar, lehnt die Datenbankverbindung aber ab." };
  }
  if (code === "ETIMEDOUT" || message.includes("timeout") || message.includes("timed out")) {
    return { code: "CONNECTION_TIMEOUT", message: "Die Datenbank hat nicht innerhalb von 3 Sekunden geantwortet." };
  }
  if (code === "3D000") {
    return { code: "DATABASE_NOT_FOUND", message: "Der Server ist erreichbar, aber die angegebene Datenbank existiert nicht." };
  }
  if (code === "3F000") {
    return { code: "SCHEMA_NOT_FOUND", message: "Die Datenbank ist erreichbar, aber das angegebene Schema existiert nicht." };
  }
  if (code === "28P01" || code === "28000") {
    return { code: "AUTHENTICATION_FAILED", message: "Benutzername oder Passwort wurden von PostgreSQL abgelehnt." };
  }
  if (code === "57P03") {
    return { code: "DATABASE_STARTING", message: "PostgreSQL ist erreichbar, aber momentan noch nicht bereit." };
  }

  return { code: "DATABASE_UNAVAILABLE", message: "Die Datenbankverbindung konnte nicht hergestellt werden." };
}

export async function pingSystemDatabase(input: unknown) {
  const config = await normalizeDatabaseProbe(input);
  const startedAt = Date.now();
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.sslMode === "require" ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 3_000,
    query_timeout: 3_000,
    statement_timeout: 3_000,
    application_name: "bonni-control-center-database-probe",
  });

  try {
    await client.connect();
    const schemaResult = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists",
      [config.schema],
    );
    if (!schemaResult.rows[0]?.exists) {
      throw Object.assign(new Error("PostgreSQL schema does not exist"), { code: "3F000" });
    }
    await client.query("SELECT 1 AS available");
    await markJsonEmergencyDatabaseRecovered();

    return {
      ok: true,
      available: true,
      target: config.target,
      checkedAt: new Date().toISOString(),
      latencyMs: Math.max(0, Date.now() - startedAt),
      connection: {
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        schema: config.schema,
        sslMode: config.sslMode,
      },
      message: "Die Datenbank ist erreichbar und beantwortet Abfragen.",
    };
  } catch (error) {
    const failure = databaseProbeError(error);

    return {
      ok: false,
      available: false,
      target: config.target,
      checkedAt: new Date().toISOString(),
      latencyMs: Math.max(0, Date.now() - startedAt),
      connection: {
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        schema: config.schema,
        sslMode: config.sslMode,
      },
      ...failure,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}


async function readNotlaufEnabled() {
  const rows = await readSettingRows();
  return boolSetting(rowsToMap(rows), SETTING_KEYS.timecapsuleEmergencyMode, false);
}

export async function getSystemNotlaufStatus() {
  const settings = await getSystemSystemSettings();
  return {
    ok: true,
    notlauf: settings.notlauf,
  };
}

export async function startSystemNotlauf() {
  const now = new Date().toISOString();
  await upsertSettings({
    [SETTING_KEYS.timecapsuleEmergencyMode]: true,
    [SETTING_KEYS.timecapsuleLastStartedAt]: now,
  });

  await timecapsuleApi.recordSystemEvent("notlauf.started", {
    source: "system-system-tab",
    timecapsuleEmergencyMode: true,
    timecapsuleSyncDisabled: true,
  });

  return getSystemNotlaufStatus();
}

export async function syncSystemNotlaufFiles() {
  const emergencyMode = await readNotlaufEnabled();
  if (emergencyMode) {
    return {
      ok: false,
      blocked: true,
      reason: "Notlauf ist aktiv. Bitte zuerst 'Notlauf beenden & übernehmen' verwenden.",
      status: await getSystemNotlaufStatus(),
    };
  }

  const syncResult = await timecapsuleApi.syncStorage({
    emergencyMode: false,
    reason: "system-manual-timecapsule-file-sync",
  });

  await upsertSetting(SETTING_KEYS.timecapsuleLastManualSyncAt, new Date().toISOString());

  return {
    ok: syncResult.ok,
    sync: syncResult,
    status: await getSystemNotlaufStatus(),
  };
}

export async function endSystemNotlauf(input: unknown = {}) {
  const body = input && typeof input === "object" ? input as { sync?: unknown } : {};
  const shouldSync = body.sync !== false;
  const now = new Date().toISOString();

  await upsertSettings({
    [SETTING_KEYS.timecapsuleEmergencyMode]: false,
    [SETTING_KEYS.timecapsuleLastEndedAt]: now,
  });

  await timecapsuleApi.recordSystemEvent("notlauf.ended", {
    source: "system-system-tab",
    syncAfterEnd: shouldSync,
  });

  let syncResult = null;
  if (shouldSync) {
    syncResult = await timecapsuleApi.syncStorage({
      emergencyMode: false,
      reason: "system-notlauf-ended",
    });
    await upsertSetting(SETTING_KEYS.timecapsuleLastManualSyncAt, new Date().toISOString());
  }

  return {
    ok: syncResult ? syncResult.ok : true,
    sync: syncResult,
    status: await getSystemNotlaufStatus(),
  };
}
