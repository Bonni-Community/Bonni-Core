import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { env } from "../config/env.js";
import {
  dataDomainDatabase,
  dataDomainSchemas,
  dataDomains,
  type DataDomain,
} from "./data-domains.js";
import type { DatabaseTarget } from "./database-routing.js";

export const dataDomainRoutingModes = ["isolated"] as const;
export type DataDomainRoutingMode = (typeof dataDomainRoutingModes)[number];

type EncryptedDomainConnection = Partial<Record<DatabaseTarget | "local", string>>;

type DataDomainRoutingFile = {
  version: 1;
  mode: DataDomainRoutingMode;
  connections: Partial<Record<DataDomain, EncryptedDomainConnection>>;
  updatedAt: string;
};

type DataDomainRoutingRuntime = {
  mode: DataDomainRoutingMode;
  initialized: boolean;
  fileStamp: string;
  connections: Partial<Record<DataDomain, Partial<Record<DatabaseTarget | "local", string>>>>;
  lastError: string | null;
};

const FILE_VERSION = 1;
const FILE_NAME = "data-domain-routing.json";
const FILE_AAD = "bonni-core:data-domain-routing:v1";

const runtime: DataDomainRoutingRuntime = {
  mode: "isolated",
  initialized: false,
  fileStamp: "",
  connections: {},
  lastError: null,
};

function routingFilePath() {
  return path.join(path.resolve(env.BONNI_RUNTIME_STATE_ROOT), "system", FILE_NAME);
}

function routingKey() {
  return createHash("sha256")
    .update(env.MASTER_KEY, "utf8")
    .update(FILE_AAD, "utf8")
    .digest();
}

function encryptSecret(value: string) {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", routingKey(), iv);
  cipher.setAAD(Buffer.from(FILE_AAD, "utf8"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decryptSecret(value: string) {
  if (!value) return "";
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) {
    throw new Error("DATA_DOMAIN_ROUTING_SECRET_CORRUPT");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    routingKey(),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAAD(Buffer.from(FILE_AAD, "utf8"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function fileStamp(filePath = routingFilePath()) {
  const stats = statSync(filePath, { bigint: true });
  return `${stats.dev}:${stats.ino}:${stats.mtimeNs}:${stats.size}`;
}

function normalizeMode(value: unknown): DataDomainRoutingMode {
  if (value !== "isolated") {
    throw new Error("DATA_DOMAIN_ROUTING_MUST_BE_ISOLATED");
  }
  return "isolated";
}

function validateConnectionUrl(value: string, label: string) {
  if (!value) return "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`DATA_DOMAIN_DATABASE_URL_INVALID:${label}`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`DATA_DOMAIN_DATABASE_MUST_BE_POSTGRESQL:${label}`);
  }
  return value;
}

function applyFile(parsed: Partial<DataDomainRoutingFile>) {
  if (parsed.version !== FILE_VERSION) {
    throw new Error("DATA_DOMAIN_ROUTING_FILE_VERSION_UNSUPPORTED");
  }
  const connections: DataDomainRoutingRuntime["connections"] = {};
  for (const domain of dataDomains) {
    const encrypted = parsed.connections?.[domain];
    if (!encrypted) continue;
    const decoded: Partial<Record<DatabaseTarget | "local", string>> = {};
    for (const target of ["normal", "redundant", "local"] as const) {
      const value = decryptSecret(String(encrypted[target] || ""));
      if (value) decoded[target] = validateConnectionUrl(value, `${domain}:${target}`);
    }
    connections[domain] = decoded;
  }
  runtime.mode = normalizeMode(parsed.mode);
  runtime.connections = connections;
  runtime.initialized = true;
  runtime.lastError = null;
}

function refreshFromDisk(force = false) {
  const filePath = routingFilePath();
  try {
    const nextStamp = fileStamp(filePath);
    if (!force && runtime.fileStamp === nextStamp) return;
    applyFile(JSON.parse(readFileSync(filePath, "utf8")) as Partial<DataDomainRoutingFile>);
    runtime.fileStamp = nextStamp;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      runtime.initialized = true;
      return;
    }
    runtime.lastError = error instanceof Error ? error.message : "DATA_DOMAIN_ROUTING_LOAD_FAILED";
  }
}

function withSchema(connectionString: string, schema: string) {
  const parsed = new URL(validateConnectionUrl(connectionString, schema));
  parsed.searchParams.set("schema", schema);
  return parsed.toString();
}

function derivedPosConnection(connectionString: string) {
  const parsed = new URL(validateConnectionUrl(connectionString, "pos"));
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName) throw new Error("POS_DATABASE_NAME_MISSING");
  parsed.pathname = `/${encodeURIComponent(`${databaseName}_pos`)}`;
  parsed.searchParams.set("schema", dataDomainSchemas.pos);
  return parsed.toString();
}

function configuredConnection(
  domain: DataDomain,
  target: DatabaseTarget | "local",
) {
  refreshFromDisk();
  return runtime.connections[domain]?.[target] || "";
}

export function getDataDomainConnectionString(
  domain: DataDomain,
  target: DatabaseTarget | "local",
  baseConnectionString: string,
) {
  refreshFromDisk();
  const configured = configuredConnection(domain, target);
  if (configured) return configured;

  // Hub is a new shared data owner. Never fall back to another domain's or
  // maintenance credentials while its isolated routing is not provisioned.
  if (domain === "hub") throw new Error("HUB_DATABASE_ROUTING_REQUIRED");
  if (domain === "gourmet") throw new Error("GOURMET_DATABASE_ROUTING_REQUIRED");
  if (domain === "capture") throw new Error("CAPTURE_DATABASE_ROUTING_REQUIRED");
  if (domain === "paypal") throw new Error("PAYPAL_DATABASE_ROUTING_REQUIRED");

  if (dataDomainDatabase(domain) === "pos") {
    const environmentValue = target === "redundant"
      ? process.env.POS_REDUNDANT_DATABASE_URL
      : process.env.POS_DATABASE_URL;
    return environmentValue
      ? withSchema(environmentValue, dataDomainSchemas.pos)
      : derivedPosConnection(baseConnectionString);
  }

  return withSchema(baseConnectionString, dataDomainSchemas[domain]);
}

export function getDataDomainRoutingStatus() {
  refreshFromDisk();
  return {
    mode: runtime.mode,
    isolated: runtime.mode === "isolated",
    fileName: FILE_NAME,
    configured: Object.fromEntries(dataDomains.map((domain) => [
      domain,
      {
        database: dataDomainDatabase(domain),
        schema: dataDomainSchemas[domain],
        normal: Boolean(runtime.connections[domain]?.normal),
        redundant: Boolean(runtime.connections[domain]?.redundant),
        local: Boolean(runtime.connections[domain]?.local),
      },
    ])),
    lastError: runtime.lastError,
  };
}

export async function configureDataDomainRouting(input: {
  mode: DataDomainRoutingMode;
  connections?: Partial<Record<DataDomain, Partial<Record<DatabaseTarget | "local", string>>>>;
}) {
  const normalizedConnections: DataDomainRoutingRuntime["connections"] = {};
  for (const domain of dataDomains) {
    const requested = input.connections?.[domain];
    if (!requested) continue;
    normalizedConnections[domain] = {};
    for (const target of ["normal", "redundant", "local"] as const) {
      const value = validateConnectionUrl(String(requested[target] || ""), `${domain}:${target}`);
      if (value) normalizedConnections[domain]![target] = value;
    }
  }

  const payload: DataDomainRoutingFile = {
    version: FILE_VERSION,
    mode: normalizeMode(input.mode),
    connections: Object.fromEntries(
      Object.entries(normalizedConnections).map(([domain, targets]) => [
        domain,
        Object.fromEntries(
          Object.entries(targets || {}).map(([target, value]) => [target, encryptSecret(String(value))]),
        ),
      ]),
    ),
    updatedAt: new Date().toISOString(),
  };

  const filePath = routingFilePath();
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
  applyFile(payload);
  runtime.fileStamp = fileStamp(filePath);
  return getDataDomainRoutingStatus();
}
