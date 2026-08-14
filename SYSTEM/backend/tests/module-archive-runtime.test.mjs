import assert from "node:assert/strict";
import test from "node:test";

import {
  createModuleArchiveRuntime,
  MODULE_ARCHIVE_CONTRACT_VERSION,
} from "../dist/core/archive/index.js";
import {
  runWithVerifiedRequestIdentity,
} from "../dist/platform/auth/request-identity/request-identity-context.js";

const identity = {
  accountId: "account-1",
  loginName: "member",
  type: "MEMBER",
  roles: [],
  permissions: [],
  allowedApps: [],
  personId: "person-1",
  memberId: "member-1",
};

const safeFile = {
  id: "file_1",
  displayName: "Receipt",
  originalName: "receipt.pdf",
  mimeType: "application/pdf",
  sizeBytes: 123,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  objectKey: "MUST_NOT_LEAK",
  storageName: "MUST_NOT_LEAK",
};

function fakeDatabase() {
  const calls = [];
  return {
    calls,
    archiveFile: {
      async findFirst(input) {
        calls.push({ method: "findFirst", input });
        return safeFile;
      },
      async findMany(input) {
        calls.push({ method: "findMany", input });
        return input.where.id.in
          .filter((id) => id !== "hidden")
          .reverse()
          .map((id) => ({ ...safeFile, id }));
      },
    },
  };
}

function withIdentity(callback) {
  return runWithVerifiedRequestIdentity(identity, callback);
}

test("archive authorization is request-bound and returns only the six safe fields", async () => {
  const database = fakeDatabase();
  const archive = createModuleArchiveRuntime("app.example", database);
  const result = await withIdentity(() => archive.authorizeFile("file_1", {
    acceptMimeTypes: ["application/pdf"],
  }));

  assert.equal(archive.contractVersion, MODULE_ARCHIVE_CONTRACT_VERSION);
  assert.deepEqual(Object.keys(result).sort(), [
    "createdAt",
    "displayName",
    "id",
    "mimeType",
    "originalName",
    "sizeBytes",
  ]);
  assert.equal("objectKey" in result, false);
  const where = database.calls[0].input.where;
  assert.equal(where.deletedAt, null);
  assert.equal(where.folder.deletedAt, null);
  assert.equal(where.OR[0].ownerPersonId, "person-1");
  assert.equal(
    where.OR[1].folder.grants.some.granteePersonId,
    "person-1",
  );
  assert.equal(where.OR[1].folder.grants.some.canRead, true);
  assert.equal(where.OR[1].folder.grants.some.revokedAt, null);
});

test("requireOwner never falls back to a grant", async () => {
  const database = fakeDatabase();
  const archive = createModuleArchiveRuntime("app.example", database);
  await withIdentity(() => archive.authorizeFile("file_1", {
    requireOwner: true,
  }));
  const where = database.calls[0].input.where;
  assert.equal(where.ownerPersonId, "person-1");
  assert.equal("OR" in where, false);
});

test("archive rejects unauthenticated access before touching storage metadata", async () => {
  const database = fakeDatabase();
  const archive = createModuleArchiveRuntime("app.example", database);
  await assert.rejects(
    archive.authorizeFile("file_1"),
    (error) => error?.code === "CORE_ARCHIVE_UNAUTHENTICATED"
      && error?.statusCode === 401,
  );
  assert.equal(database.calls.length, 0);
});

test("technical request identities cannot use personal archive capabilities", async () => {
  const database = fakeDatabase();
  const archive = createModuleArchiveRuntime("app.example", database);
  await assert.rejects(
    runWithVerifiedRequestIdentity({
      ...identity,
      type: "TERMINAL",
    }, () => archive.authorizeFile("file_1")),
    (error) => error?.code === "CORE_ARCHIVE_UNAUTHENTICATED"
      && error?.statusCode === 401,
  );
  assert.equal(database.calls.length, 0);
});

test("MIME allowlist is enforced after authorization", async () => {
  const archive = createModuleArchiveRuntime("app.example", fakeDatabase());
  await assert.rejects(
    withIdentity(() => archive.authorizeFile("file_1", {
      acceptMimeTypes: ["image/*"],
    })),
    (error) => error?.code === "CORE_ARCHIVE_MIME_TYPE_NOT_ACCEPTED"
      && error?.statusCode === 415,
  );
});

test("archive options are closed and reject undeclared policy switches", async () => {
  const archive = createModuleArchiveRuntime("app.example", fakeDatabase());
  await assert.rejects(
    withIdentity(() => archive.authorizeFile("file_1", {
      requireOwner: false,
      bypassGrants: true,
    })),
    (error) => error?.code === "CORE_ARCHIVE_OPTIONS_INVALID"
      && error?.statusCode === 400,
  );
});

test("filterReadable accepts owner/read/copy policy and preserves input order", async () => {
  const database = fakeDatabase();
  const archive = createModuleArchiveRuntime("app.example", database);
  const result = await withIdentity(() => (
    archive.filterReadable(["first", "hidden", "second"])
  ));
  assert.deepEqual(result.map((file) => file.id), ["first", "second"]);
  const grant = database.calls[0].input.where.OR[1].folder.grants.some;
  assert.deepEqual(grant.AND, [{
    OR: [{ canRead: true }, { canCopy: true }],
  }]);
});
