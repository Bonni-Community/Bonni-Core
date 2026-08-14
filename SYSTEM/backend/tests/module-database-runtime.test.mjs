import assert from "node:assert/strict";
import test from "node:test";

const { createModuleDatabaseRuntime, moduleDatabaseDomain } = await import(
  "../dist/platform/module-manager/loader/module-database-runtime.js"
);
const { validateModuleManifest } = await import(
  "../dist/platform/module-manager/manifests/manifest.service.js"
);

function scopedManifest() {
  return {
    key: "app.example",
    kind: "app",
    name: "Example",
    version: "1.0.0",
    metadata: {
      database: {
        mode: "scoped-v1",
        delegates: ["exampleRecord"],
      },
    },
  };
}

test("scoped module database exposes only declared delegates", () => {
  const prisma = {
    exampleRecord: { findMany() {} },
    account: { findMany() {} },
  };
  const database = createModuleDatabaseRuntime("app.example", prisma, scopedManifest());
  assert.equal(database.mode, "scoped-v1");
  assert.equal(database.client.exampleRecord, prisma.exampleRecord);
  assert.throws(
    () => database.client.account,
    /MODULE_DATABASE_DELEGATE_DENIED:app\.example:account/,
  );
});

test("database-less plugins start without a data domain and receive no Prisma capability", () => {
  const manifest = {
    key: "plugin.privacyidea",
    kind: "plugin",
    name: "Zwei-Faktor-Authentifizierung (2FA)",
    version: "0.1.0",
    metadata: { database: { mode: "none" } },
  };

  assert.deepEqual(validateModuleManifest(manifest), { ok: true, errors: [] });
  assert.equal(moduleDatabaseDomain("plugin.privacyidea", manifest), null);

  const database = createModuleDatabaseRuntime("plugin.privacyidea", null, manifest);
  assert.equal(database.mode, "none");
  assert.deepEqual(database.allowedDelegates, []);
  assert.throws(
    () => database.client.systemSetting,
    /MODULE_DATABASE_UNAVAILABLE:plugin\.privacyidea:systemSetting/,
  );
});

test("privacyIDEA compatibility scope starts on older loaders without exposing a real Core delegate", () => {
  const manifest = {
    key: "plugin.privacyidea",
    kind: "plugin",
    name: "Zwei-Faktor-Authentifizierung (2FA)",
    version: "0.2.1",
    metadata: {
      database: {
        mode: "scoped-v1",
        domain: "core",
        delegates: ["twoFactorPluginStorageUnavailable"],
      },
    },
  };

  assert.deepEqual(validateModuleManifest(manifest), { ok: true, errors: [] });
  assert.equal(moduleDatabaseDomain("plugin.privacyidea", manifest), "core");

  const database = createModuleDatabaseRuntime("plugin.privacyidea", {}, manifest);
  assert.equal(database.mode, "scoped-v1");
  assert.deepEqual(database.allowedDelegates, ["twoFactorPluginStorageUnavailable"]);
  assert.throws(
    () => database.client.twoFactorPluginStorageUnavailable,
    /MODULE_DATABASE_DELEGATE_UNAVAILABLE:plugin\.privacyidea:twoFactorPluginStorageUnavailable/,
  );
  assert.throws(
    () => database.client.systemSetting,
    /MODULE_DATABASE_DELEGATE_DENIED:plugin\.privacyidea:systemSetting/,
  );
});

test("interactive transactions remain scoped and forward validated options", async () => {
  let receivedOptions;
  const transaction = {
    exampleRecord: { updateMany() {} },
    account: { deleteMany() {} },
  };
  const prisma = {
    exampleRecord: { findMany() {} },
    async $transaction(callback, options) {
      receivedOptions = options;
      return callback(transaction);
    },
  };
  const database = createModuleDatabaseRuntime("app.example", prisma, scopedManifest());
  const result = await database.client.$transaction((tx) => {
    assert.equal(tx.exampleRecord, transaction.exampleRecord);
    assert.throws(() => tx.account, /MODULE_DATABASE_DELEGATE_DENIED/);
    return "committed";
  }, {
    isolationLevel: "Serializable",
    maxWait: 5_000,
    timeout: 20_000,
  });
  assert.equal(result, "committed");
  assert.deepEqual(receivedOptions, {
    isolationLevel: "Serializable",
    maxWait: 5_000,
    timeout: 20_000,
  });

  await assert.rejects(
    database.client.$transaction(() => null, { isolationLevel: "Unsafe" }),
    /MODULE_DATABASE_TRANSACTION_ISOLATION_INVALID/,
  );
  await assert.rejects(
    database.client.$transaction(() => null, { unexpected: true }),
    /MODULE_DATABASE_TRANSACTION_OPTIONS_INVALID/,
  );
});
