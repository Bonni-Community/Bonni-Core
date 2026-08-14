import assert from "node:assert/strict";
import test from "node:test";

const { createModuleInstanceIdentityRuntime } = await import(
  "../dist/core/instance-identity/index.js"
);

function fakeDatabase(initial = {}) {
  const values = new Map(Object.entries(initial));
  const row = (key) => ({ key, value: values.get(key) });
  return {
    values,
    systemSetting: {
      async findMany({ where }) {
        return where.key.in.filter((key) => values.has(key)).map(row);
      },
      async upsert({ where, create }) {
        if (!values.has(where.key)) values.set(where.key, create.value);
        return row(where.key);
      },
    },
    async $transaction(work) {
      return work(this);
    },
  };
}

test("instance identity is generated once and persisted without manual environment values", async () => {
  const previous = {
    organizationId: process.env.BONNI_ORGANIZATION_ID,
    tenantId: process.env.BONNI_TENANT_ID,
    serial: process.env.BONNI_SERIAL,
  };
  delete process.env.BONNI_ORGANIZATION_ID;
  delete process.env.BONNI_TENANT_ID;
  delete process.env.BONNI_SERIAL;
  try {
    const database = fakeDatabase();
    const first = await createModuleInstanceIdentityRuntime(database).get();
    assert.match(first.organizationId, /^org:[0-9a-f-]{36}$/);
    assert.equal(first.tenantId, first.organizationId);

    process.env.BONNI_ORGANIZATION_ID = "organization:changed-later";
    process.env.BONNI_TENANT_ID = "tenant:changed-later";
    const second = await createModuleInstanceIdentityRuntime(database).get();
    assert.deepEqual(second, first, "stored identity must win over later environment changes");
    assert.equal(database.values.get("system.instance.organizationId"), first.organizationId);
    assert.equal(database.values.get("system.instance.tenantId"), first.tenantId);
  } finally {
    if (previous.organizationId === undefined) delete process.env.BONNI_ORGANIZATION_ID;
    else process.env.BONNI_ORGANIZATION_ID = previous.organizationId;
    if (previous.tenantId === undefined) delete process.env.BONNI_TENANT_ID;
    else process.env.BONNI_TENANT_ID = previous.tenantId;
    if (previous.serial === undefined) delete process.env.BONNI_SERIAL;
    else process.env.BONNI_SERIAL = previous.serial;
  }
});

test("existing stored identity is returned unchanged", async () => {
  const database = fakeDatabase({
    "system.instance.organizationId": "organization:bonni-main",
    "system.instance.tenantId": "tenant:bonni-main",
  });
  const identity = await createModuleInstanceIdentityRuntime(database).get();
  assert.deepEqual(identity, {
    organizationId: "organization:bonni-main",
    tenantId: "tenant:bonni-main",
  });
});
