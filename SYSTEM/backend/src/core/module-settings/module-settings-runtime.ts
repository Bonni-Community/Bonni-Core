import { getPrismaClient } from "../database/database.js";

export const MODULE_SETTINGS_CONTRACT_VERSION = "bonni.module-settings/v1" as const;

type PrismaLike = {
  systemSetting: {
    findUnique: (input: any) => Promise<any>;
    upsert: (input: any) => Promise<any>;
    deleteMany: (input: any) => Promise<{ count: number }>;
  };
};

export class ModuleSettingsRuntimeError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number) {
    super(code);
    this.name = "ModuleSettingsRuntimeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code: string, statusCode: number): never {
  throw new ModuleSettingsRuntimeError(code, statusCode);
}

function normalizeModuleKey(value: unknown) {
  const moduleKey = String(value || "").trim().toLowerCase();
  if (
    !/^(app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]$/.test(moduleKey)
    || moduleKey.includes("..")
  ) {
    fail("CORE_MODULE_SETTINGS_MODULE_KEY_INVALID", 500);
  }
  return moduleKey;
}

export function normalizeModuleSettingRelativeKey(value: unknown) {
  if (typeof value !== "string") {
    fail("CORE_MODULE_SETTINGS_KEY_INVALID", 400);
  }
  const relativeKey = value.trim().toLowerCase();
  if (
    relativeKey !== value
    || relativeKey.length > 160
    || !/^[a-z0-9](?:[a-z0-9.-]{0,158}[a-z0-9])?$/.test(relativeKey)
    || relativeKey.includes("..")
  ) {
    fail("CORE_MODULE_SETTINGS_KEY_INVALID", 400);
  }
  return relativeKey;
}

function expectedUpdatedAt(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!(typeof value === "string" || value instanceof Date)) {
    fail("CORE_MODULE_SETTINGS_UPDATED_AT_INVALID", 400);
  }
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    fail("CORE_MODULE_SETTINGS_UPDATED_AT_INVALID", 400);
  }
  return parsed;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

export function createModuleSettingsRuntime(
  moduleKeyValue: string,
  prismaValue: PrismaLike = getPrismaClient(),
) {
  const moduleKey = normalizeModuleKey(moduleKeyValue);
  const prisma = prismaValue;
  const namespacedKey = (relativeKeyValue: unknown) => (
    `${moduleKey}.${normalizeModuleSettingRelativeKey(relativeKeyValue)}`
  );

  return Object.freeze({
    contractVersion: MODULE_SETTINGS_CONTRACT_VERSION,
    moduleKey,
    async getLegacyJson(relativeKeyValue: unknown) {
      const record = await prisma.systemSetting.findUnique({
        where: { key: namespacedKey(relativeKeyValue) },
        select: {
          value: true,
          updatedAt: true,
        },
      });
      if (!record) return null;
      return Object.freeze({
        value: cloneJson(record.value),
        updatedAt: record.updatedAt,
      });
    },
    async putJson(
      relativeKeyValue: unknown,
      value: unknown,
      expectedUpdatedAtValue?: unknown,
    ) {
      const key = namespacedKey(relativeKeyValue);
      const updatedAt = expectedUpdatedAt(expectedUpdatedAtValue);
      const jsonValue = cloneJson(value);

      if (updatedAt) {
        const existing = await prisma.systemSetting.findUnique({
          where: { key },
          select: { updatedAt: true },
        });
        if (!existing || new Date(existing.updatedAt).getTime() !== updatedAt.getTime()) {
          fail("CORE_MODULE_SETTINGS_CONFLICT", 409);
        }
      }

      const record = await prisma.systemSetting.upsert({
        where: { key },
        create: { key, value: jsonValue },
        update: { value: jsonValue },
        select: { value: true, updatedAt: true },
      });
      return Object.freeze({
        value: cloneJson(record.value),
        updatedAt: record.updatedAt,
      });
    },
    async deleteLegacyJson(
      relativeKeyValue: unknown,
      expectedUpdatedAtValue?: unknown,
    ) {
      const key = namespacedKey(relativeKeyValue);
      const updatedAt = expectedUpdatedAt(expectedUpdatedAtValue);
      const result = await prisma.systemSetting.deleteMany({
        where: {
          key,
          ...(updatedAt ? { updatedAt } : {}),
        },
      });
      if (result.count > 0) return true;
      if (updatedAt) {
        const existing = await prisma.systemSetting.findUnique({
          where: { key },
          select: { id: true },
        });
        if (existing) fail("CORE_MODULE_SETTINGS_CONFLICT", 409);
      }
      return false;
    },
  });
}
