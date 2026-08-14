import assert from "node:assert/strict";
import test from "node:test";

import {
  createModuleSettingsRuntime,
  MODULE_SETTINGS_CONTRACT_VERSION,
  normalizeModuleSettingRelativeKey,
} from "../dist/core/module-settings/index.js";

function fakeDatabase() {
  const updatedAt = new Date("2026-01-01T00:00:00.000Z");
  const records = new Map([
    ["app.example.surface-settings", {
      id: "setting-1",
      value: { nested: { enabled: true } },
      updatedAt,
    }],
    ["app.other.surface-settings", {
      id: "setting-other",
      value: { secret: true },
      updatedAt,
    }],
  ]);
  const calls = [];
  return {
    calls,
    records,
    systemSetting: {
      async findUnique({ where, select }) {
        calls.push({ method: "findUnique", where, select });
        return records.get(where.key) || null;
      },
      async deleteMany({ where }) {
        calls.push({ method: "deleteMany", where });
        const record = records.get(where.key);
        if (
          !record
          || (
            where.updatedAt
            && record.updatedAt.getTime() !== where.updatedAt.getTime()
          )
        ) {
          return { count: 0 };
        }
        records.delete(where.key);
        return { count: 1 };
      },
      async upsert({ where, create, update }) {
        calls.push({ method: "upsert", where, create, update });
        const existing = records.get(where.key);
        const record = {
          id: existing?.id || "setting-created",
          value: structuredClone(existing ? update.value : create.value),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        };
        records.set(where.key, record);
        return record;
      },
    },
  };
}

test("legacy JSON settings are strictly namespaced and cloned", async () => {
  const database = fakeDatabase();
  const settings = createModuleSettingsRuntime("app.example", database);
  const result = await settings.getLegacyJson("surface-settings");

  assert.equal(settings.contractVersion, MODULE_SETTINGS_CONTRACT_VERSION);
  assert.equal(database.calls[0].where.key, "app.example.surface-settings");
  assert.deepEqual(result, {
    value: { nested: { enabled: true } },
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  result.value.nested.enabled = false;
  assert.equal(
    database.records.get("app.example.surface-settings").value.nested.enabled,
    true,
  );
});

test("relative keys reject traversal, alternate namespaces and non-canonical input", () => {
  for (const invalid of [
    "../surface-settings",
    ".surface-settings",
    "surface-settings.",
    "surface..settings",
    "app.other.surface-settings/escape",
    "Surface-Settings",
    " surface-settings",
  ]) {
    assert.throws(
      () => normalizeModuleSettingRelativeKey(invalid),
      /CORE_MODULE_SETTINGS_KEY_INVALID/,
    );
  }
  assert.equal(
    normalizeModuleSettingRelativeKey("surface-settings"),
    "surface-settings",
  );
});

test("deleteLegacyJson supports optimistic concurrency without crossing namespace", async () => {
  const database = fakeDatabase();
  const settings = createModuleSettingsRuntime("app.example", database);
  await assert.rejects(
    settings.deleteLegacyJson(
      "surface-settings",
      "2025-01-01T00:00:00.000Z",
    ),
    (error) => error?.code === "CORE_MODULE_SETTINGS_CONFLICT"
      && error?.statusCode === 409,
  );
  assert.equal(database.records.has("app.example.surface-settings"), true);
  assert.equal(
    await settings.deleteLegacyJson(
      "surface-settings",
      "2026-01-01T00:00:00.000Z",
    ),
    true,
  );
  assert.equal(database.records.has("app.example.surface-settings"), false);
  assert.equal(database.records.has("app.other.surface-settings"), true);
});

test("putJson writes only to the bound module namespace", async () => {
  const database = fakeDatabase();
  const settings = createModuleSettingsRuntime("plugin.privacyidea", database);
  const result = await settings.putJson("configuration", {
    challengeExpiresSeconds: 60,
    maxAttempts: 8,
  });
  assert.deepEqual(result.value, { challengeExpiresSeconds: 60, maxAttempts: 8 });
  assert.deepEqual(
    database.records.get("plugin.privacyidea.configuration").value,
    { challengeExpiresSeconds: 60, maxAttempts: 8 },
  );
  assert.equal(database.records.has("app.other.surface-settings"), true);
});
