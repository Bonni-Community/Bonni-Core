import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
      return true;
    }

    if (["0", "false", "no", "off", "disabled", ""].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean());

const optionalString = z.string().optional().default("");
const optionalLoopbackBind = z.string()
  .trim()
  .refine(
    (value) => value === "" || new Set(["127.0.0.1", "::1", "localhost"]).has(value),
    { message: "SYSTEM_SERVER_BIND must be empty or a loopback host." },
  )
  .optional()
  .default("");
const optionalAbsolutePath = z.string()
  .trim()
  .refine((value) => value === "" || (!value.includes("\u0000") && path.isAbsolute(value)), {
    message: "Runtime root paths must be absolute paths without NUL bytes.",
  })
  .optional()
  .default("");
const runtimeSlotRoleSchema = z.enum(["active", "emergency", "candidate", "previous", "idle", "installer"]);

const DEFAULT_PORT = 4000;
const DEFAULT_LOCAL_AUTH_PORT = 4101;
const DEFAULT_LOCAL_AUTH_BIND = "127.0.0.1";

const rawEnvSchema = z.object({
  // Pflicht: echte Boot-Werte. Ohne diese Werte kommt das System nicht bis zur DB.
  MASTER_KEY: z.string().min(16, "MASTER_KEY is required and must be at least 16 characters."),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required."),
  // Legacy alias for BONNI_RUNTIME_STATE_ROOT. It remains accepted so older
  // launchers can start the same runtime without changing its state location.
  RUN_SYSTEM_ROOT: optionalString,

  // Program generations are immutable. Product state and logs may therefore
  // live outside the generation that currently executes the backend.
  BONNI_PROJECT_ROOT: optionalString,
  BONNI_PROGRAM_ROOT: optionalAbsolutePath,
  BONNI_PRODUCT_ROOT: optionalAbsolutePath,
  // Installierte Apps/Module bleiben bei einem Core-Slotwechsel im stabilen
  // SYSTEM-Baum. Der unveraenderliche Program-Slot enthaelt bewusst nur Core.
  BONNI_MODULE_PACKAGE_ROOT: optionalAbsolutePath,
  BONNI_LOG_ROOT: optionalAbsolutePath,
  BONNI_RUN_INSTALL_ROOT: optionalAbsolutePath,
  BONNI_RUN_SYSTEM_ROOT: optionalAbsolutePath,
  BONNI_PROGRAM_SLOTS_ROOT: optionalAbsolutePath,
  BONNI_RUNTIME_STATE_ROOT: optionalAbsolutePath,

  // Optional: technische Boot-Overrides. Wenn nicht gesetzt, greifen feste Standards.
  PORT: z.coerce.number().default(DEFAULT_PORT),
  LOCAL_AUTH_PORT: z.coerce.number().default(DEFAULT_LOCAL_AUTH_PORT),
  // Leer bewahrt das bisherige Node-/Container-Verhalten. RUN-Slots setzen
  // diesen Wert explizit auf Loopback, damit ihr interner Port den stabilen
  // lokalen Proxy nicht umgehen kann.
  SYSTEM_SERVER_BIND: optionalLoopbackBind,

  // Interne Defaults. Diese Werte sollen künftig aus SystemSetting/System kommen.
  NODE_ENV: z.string().default("development"),
  LOCAL_AUTH_BIND: z.string().default(DEFAULT_LOCAL_AUTH_BIND),

  SYSTEM_SLOT_NAME: z.string().min(1).default("backend-single"),
  SYSTEM_SLOT_ROLE: runtimeSlotRoleSchema.default("active"),
  SYSTEM_VERSION: z.string().min(1).default(process.env.npm_package_version || "0.0.0"),
  BONNI_CORE_IMAGE_VERSION: optionalString,
  SYSTEM_UPDATE_PROBE_MODE: booleanFromEnv.default(false),
  SYSTEM_EMERGENCY_HOLD_DAYS: z.coerce.number().int().positive().default(14),
  SYSTEM_BOOT_KEY_REQUIRED: booleanFromEnv.default(false),

  // Kompatibilität: Codepfade dürfen die spezialisierten URLs weiter lesen.
  // Wenn sie fehlen, werden sie aus DATABASE_URL abgeleitet.
  LOCAL_DATABASE_URL: optionalString,
  SERVER_DATABASE_URL: optionalString,
  DATABASE_OPERATION_MODE: z.enum(["local-only", "server-only", "local-to-server"]).default("server-only"),
  DATABASE_SYNC_MODE: z.enum(["disabled", "manual"]).default("manual"),

  // JWT_SECRET ist kein eigener Pflichtwert mehr. Wenn nichts gesetzt ist, wird MASTER_KEY verwendet.
  JWT_SECRET: optionalString,
  JWT_EXPIRES_IN: z.string().default("8h"),

  AUTH_MODE: z.enum(["LOCAL", "OIDC", "SANDBOX", "MAINTENANCE"]).default("LOCAL"),

  OIDC_ENABLED: booleanFromEnv.default(false),
  OIDC_ISSUER_URL: optionalString,
  OIDC_CLIENT_ID: optionalString,
  OIDC_CLIENT_SECRET: optionalString,
  OIDC_REDIRECT_URI: optionalString,
  OIDC_POST_LOGOUT_REDIRECT_URI: optionalString,

  LOG_LEVEL: z.string().default("info"),

  MEDIA_STORAGE_ROOT: optionalString,
  MEDIA_PUBLIC_BASE_PATH: z.string().optional().default("/api/media/files"),
  MEDIA_MAX_UPLOAD_BYTES: z.coerce.number().optional().default(10 * 1024 * 1024),
});

function normalizeDatabaseUrls(raw: z.infer<typeof rawEnvSchema>) {
  const serverDatabaseUrl = raw.SERVER_DATABASE_URL || raw.DATABASE_URL;
  const localDatabaseUrl = raw.LOCAL_DATABASE_URL || raw.DATABASE_URL;

  return {
    ...raw,
    DATABASE_URL: raw.DATABASE_URL,
    SERVER_DATABASE_URL: serverDatabaseUrl,
    LOCAL_DATABASE_URL: localDatabaseUrl,
  };
}

function normalizeBootEnv(raw: z.infer<typeof rawEnvSchema>) {
  const normalized = normalizeDatabaseUrls(raw);
  const jwtSecret = normalized.JWT_SECRET || normalized.MASTER_KEY;
  const legacyProjectRoot = normalized.BONNI_PROJECT_ROOT.trim();
  const programRoot = normalized.BONNI_PROGRAM_ROOT
    || (legacyProjectRoot ? path.resolve(legacyProjectRoot) : path.resolve(process.cwd(), "../.."));
  const productRoot = normalized.BONNI_PRODUCT_ROOT
    || programRoot;
  const configuredRuntimeStateRoot = normalized.BONNI_RUNTIME_STATE_ROOT
    || normalized.RUN_SYSTEM_ROOT.trim();
  const runtimeStateRoot = configuredRuntimeStateRoot
    ? path.resolve(configuredRuntimeStateRoot)
    : path.join(productRoot, "run_system");

  // Kompatibilität für bestehende Module, die noch direkt process.env lesen.
  // The bootstrap selects v2 by exporting BONNI_RUNTIME_STATE_ROOT explicitly.
  // BONNI_RUN_SYSTEM_ROOT alone is only the container path and must never make
  // a raw SYSTEM start guess that its state lives in RUN_SYSTEM/runtime.
  process.env.BONNI_RUNTIME_STATE_ROOT = runtimeStateRoot;
  process.env.RUN_SYSTEM_ROOT = runtimeStateRoot;
  process.env.BONNI_PROGRAM_ROOT = programRoot;
  process.env.BONNI_PROJECT_ROOT = programRoot;
  process.env.BONNI_PRODUCT_ROOT = productRoot;
  if (normalized.BONNI_MODULE_PACKAGE_ROOT) {
    process.env.BONNI_MODULE_PACKAGE_ROOT = normalized.BONNI_MODULE_PACKAGE_ROOT;
  }
  if (normalized.BONNI_LOG_ROOT) {
    process.env.BONNI_LOG_ROOT = normalized.BONNI_LOG_ROOT;
  }
  process.env.SERVER_DATABASE_URL = normalized.SERVER_DATABASE_URL;
  process.env.LOCAL_DATABASE_URL = normalized.LOCAL_DATABASE_URL;
  process.env.JWT_SECRET = jwtSecret;

  return {
    ...normalized,
    BONNI_PROGRAM_ROOT: programRoot,
    BONNI_PROJECT_ROOT: programRoot,
    BONNI_PRODUCT_ROOT: productRoot,
    BONNI_MODULE_PACKAGE_ROOT: normalized.BONNI_MODULE_PACKAGE_ROOT,
    BONNI_RUNTIME_STATE_ROOT: runtimeStateRoot,
    RUN_SYSTEM_ROOT: runtimeStateRoot,
    JWT_SECRET: jwtSecret,
  };
}

const envSchema = rawEnvSchema.transform(normalizeBootEnv);

export const env = envSchema.parse(process.env);
