import "dotenv/config";
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
const runtimeSlotRoleSchema = z.enum(["active", "emergency", "candidate", "previous", "idle", "installer"]);

const DEFAULT_PORT = 4000;
const DEFAULT_LOCAL_AUTH_PORT = 4101;
const DEFAULT_LOCAL_AUTH_BIND = "127.0.0.1";
const DEFAULT_RUN_SYSTEM_ROOT = "../../run_system";

const rawEnvSchema = z.object({
  // Pflicht: echte Boot-Werte. Ohne diese Werte kommt das System nicht bis zur DB.
  MASTER_KEY: z.string().min(16, "MASTER_KEY is required and must be at least 16 characters."),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required."),
  RUN_SYSTEM_ROOT: z.string().default(DEFAULT_RUN_SYSTEM_ROOT),

  // Optional: technische Boot-Overrides. Wenn nicht gesetzt, greifen feste Standards.
  PORT: z.coerce.number().default(DEFAULT_PORT),
  LOCAL_AUTH_PORT: z.coerce.number().default(DEFAULT_LOCAL_AUTH_PORT),

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

  LICENSE_PUBLIC_KEY_PATH: optionalString,
  LICENSE_DEFAULT_KEY_FILE: optionalString,
  LICENSE_KEY_FILE: optionalString,
  LICENSE_INSTALLATION_FILE: optionalString,
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

  // Kompatibilität für bestehende Module, die noch direkt process.env lesen.
  process.env.RUN_SYSTEM_ROOT = normalized.RUN_SYSTEM_ROOT;
  process.env.SERVER_DATABASE_URL = normalized.SERVER_DATABASE_URL;
  process.env.LOCAL_DATABASE_URL = normalized.LOCAL_DATABASE_URL;
  process.env.JWT_SECRET = jwtSecret;

  return {
    ...normalized,
    JWT_SECRET: jwtSecret,
  };
}

const envSchema = rawEnvSchema.transform(normalizeBootEnv);

export const env = envSchema.parse(process.env);
