import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createModuleProtectedOrganizationRuntime } from "../dist/core/protected-organization/index.js";
import { runWithVerifiedRequestIdentity } from "../dist/platform/auth/request-identity/request-identity-context.js";

const identity = {
  accountId: "account-1",
  loginName: "manager",
  type: "MEMBER",
  roles: [],
  permissions: [],
  allowedApps: [],
  personId: "person-1",
  memberId: "member-1",
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function harness({ forceCreateRace = false } = {}) {
  const rowsByBinding = new Map();
  const rowsById = new Map();
  const audit = [];
  const storage = { stored: [], deleted: [] };
  let nextId = 1;
  let racePending = forceCreateRace;

  function bindingKey(data) {
    return data.sourceReferenceHash
      ? `${data.organizationId}|${data.sourceModuleKey}|${data.sourceReferenceHash}`
      : null;
  }

  const organization = {
    organizationDocument: {
      async findUnique({ where }) {
        const value = where.organizationId_sourceModuleKey_sourceReferenceHash;
        return rowsByBinding.get(`${value.organizationId}|${value.sourceModuleKey}|${value.sourceReferenceHash}`) || null;
      },
      async create({ data }) {
        const key = bindingKey(data);
        if (racePending && key) {
          racePending = false;
          const winner = {
            ...data,
            id: "document-race-winner",
            objectKey: "pd_race_winner.arc",
            status: "ACTIVE",
            archivedAt: null,
            createdAt: new Date("2026-08-14T00:00:00.000Z"),
            updatedAt: new Date("2026-08-14T00:00:00.000Z"),
          };
          rowsByBinding.set(key, winner);
          rowsById.set(winner.id, winner);
          throw Object.assign(new Error("unique race"), { code: "P2002" });
        }
        if (key && rowsByBinding.has(key)) throw Object.assign(new Error("duplicate"), { code: "P2002" });
        const row = {
          ...data,
          id: `document-${nextId++}`,
          status: "ACTIVE",
          archivedAt: null,
          createdAt: new Date("2026-08-14T00:00:00.000Z"),
          updatedAt: new Date("2026-08-14T00:00:00.000Z"),
        };
        if (key) rowsByBinding.set(key, row);
        rowsById.set(row.id, row);
        return row;
      },
      async findFirst({ where }) {
        const row = rowsById.get(where.id) || null;
        if (!row || row.organizationId !== where.organizationId) return null;
        return row.status === "DELETED" ? null : row;
      },
      async update({ where, data }) {
        const row = rowsById.get(where.id);
        if (!row) throw new Error("test row missing");
        const updated = { ...row, ...data, updatedAt: new Date("2026-08-14T00:01:00.000Z") };
        rowsById.set(updated.id, updated);
        const key = bindingKey(updated);
        if (key) rowsByBinding.set(key, updated);
        return updated;
      },
    },
  };
  const privacy = {
    protectedDataAccessLog: {
      async create({ data }) {
        audit.push(data);
        return data;
      },
    },
  };
  const runtime = createModuleProtectedOrganizationRuntime(
    "app.kontorapp",
    organization,
    privacy,
    { async get() { return { organizationId: "organization-1", tenantId: "tenant-1" }; } },
    {
      async getTwoFactorStatus() {
        return {
          enabled: false,
          privateDataProtectionEnrolled: false,
          provider: { externallyManaged: false, configured: true },
        };
      },
      async storeDocument({ bytes }) {
        const data = Buffer.from(bytes);
        const objectKey = `pd_test_${storage.stored.length + 1}.arc`;
        storage.stored.push({ objectKey, data });
        return {
          objectKey,
          checksum: sha256(data),
          sizeInBytes: data.length,
          storageVersion: 1,
          encryptionVersion: 1,
          keyVersion: 1,
        };
      },
      async readDocument() { throw new Error("not used"); },
      async deleteDocument({ objectKey }) { storage.deleted.push(objectKey); },
    },
  );
  return { runtime, rowsByBinding, audit, storage };
}

function createInput(data = Buffer.from("year-file", "utf8")) {
  return {
    purpose: "ACCOUNTING_YEAR_FILE",
    grantToken: "",
    sourceReference: "year-file:2026:revision-7",
    category: "ACCOUNTING",
    title: "Year file 2026",
    fileName: "year-file-2026.zip",
    mimeType: "application/zip",
    data,
  };
}

function withIdentity(callback) {
  return runWithVerifiedRequestIdentity(identity, callback);
}

test("organization document source references replay the same central document without a second blob", async () => {
  const { runtime, rowsByBinding, audit, storage } = harness();
  const first = await withIdentity(() => runtime.createDocument(createInput()));
  const replay = await withIdentity(() => runtime.createDocument(createInput()));

  assert.equal(replay.id, first.id);
  assert.equal(storage.stored.length, 1);
  assert.equal(rowsByBinding.size, 1);
  assert.equal([...rowsByBinding.values()][0].sourceModuleKey, "app.kontorapp");
  assert.doesNotMatch([...rowsByBinding.keys()][0], /year-file:2026/u);
  assert.deepEqual(audit.map((entry) => entry.operation), [
    "ORGANIZATION_DOCUMENT_CREATE",
    "ORGANIZATION_DOCUMENT_CREATE_REPLAY",
  ]);
  assert.equal("sourceReference" in replay, false);
  assert.equal("sourceReferenceHash" in replay, false);
});

test("the same source reference fails closed when its bytes differ", async () => {
  const { runtime, storage } = harness();
  await withIdentity(() => runtime.createDocument(createInput()));
  await assert.rejects(
    withIdentity(() => runtime.createDocument(createInput(Buffer.from("changed", "utf8")))),
    (error) => error?.code === "PROTECTED_ORGANIZATION_DOCUMENT_SOURCE_CONFLICT"
      && error?.statusCode === 409,
  );
  assert.equal(storage.stored.length, 1, "conflicting bytes must be rejected before blob storage");
});

test("a concurrent unique winner is reused and the losing blob is erased", async () => {
  const { runtime, storage } = harness({ forceCreateRace: true });
  const result = await withIdentity(() => runtime.createDocument(createInput()));
  assert.equal(result.id, "document-race-winner");
  assert.equal(storage.stored.length, 1);
  assert.deepEqual(storage.deleted, [storage.stored[0].objectKey]);
});

test("calls without sourceReference keep the compatible create-every-time behavior", async () => {
  const { runtime, storage } = harness();
  const input = createInput();
  delete input.sourceReference;
  const first = await withIdentity(() => runtime.createDocument(input));
  const second = await withIdentity(() => runtime.createDocument(input));
  assert.notEqual(second.id, first.id);
  assert.equal(storage.stored.length, 2);
});

test("source-bound documents can never be physically or logically deleted", async () => {
  const { runtime, rowsByBinding, storage } = harness();
  const created = await withIdentity(() => runtime.createDocument(createInput()));
  await assert.rejects(
    withIdentity(() => runtime.deleteDocument({
      purpose: "ACCOUNTING_YEAR_FILE",
      grantToken: "",
      documentId: created.id,
    })),
    (error) => error?.code === "PROTECTED_ORGANIZATION_DOCUMENT_SOURCE_BOUND_DELETE_DENIED"
      && error?.statusCode === 409,
  );
  assert.deepEqual(storage.deleted, []);
  assert.equal([...rowsByBinding.values()][0].status, "ACTIVE");
});

test("unbound legacy documents retain the compatible delete behavior", async () => {
  const { runtime, storage } = harness();
  const input = createInput();
  delete input.sourceReference;
  const created = await withIdentity(() => runtime.createDocument(input));
  const result = await withIdentity(() => runtime.deleteDocument({
    purpose: "ACCOUNTING_YEAR_FILE",
    grantToken: "",
    documentId: created.id,
  }));
  assert.deepEqual(result, { deleted: true, documentId: created.id });
  assert.deepEqual(storage.deleted, [storage.stored[0].objectKey]);
});
