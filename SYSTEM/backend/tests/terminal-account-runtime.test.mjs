import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  createModuleTerminalAccountRuntime,
  describeTerminalAccountIdentity,
  normalizeDeclaredModuleTerminalAccounts,
  reconcileDeclaredModuleTerminalAccounts,
} = await import(process.env.BONNI_TEST_SOURCE === "1"
  ? "../src/platform/auth/terminal-accounts/terminal-account.service.ts"
  : "../dist/platform/auth/terminal-accounts/terminal-account.service.js");
const { validateModuleManifest } = await import(process.env.BONNI_TEST_SOURCE === "1"
  ? "../src/platform/module-manager/manifests/manifest.service.ts"
  : "../dist/platform/module-manager/manifests/manifest.service.js");

function fakeDatabase(initialAccounts = []) {
  const accounts = initialAccounts.map((account) => ({
    credentialRevision: account.credentialRevision ?? 0,
    isActive: account.isActive ?? true,
    passwordHash: account.passwordHash ?? null,
    twoFactorProviderId: account.twoFactorProviderId ?? null,
    twoFactorEnrolledAt: account.twoFactorEnrolledAt ?? null,
    privateDataTwoFactorEnrolledAt: account.privateDataTwoFactorEnrolledAt ?? null,
    passwordRecoveryLockedAt: account.passwordRecoveryLockedAt ?? null,
    passwordRecoveryRequestId: account.passwordRecoveryRequestId ?? null,
    passwordRecoveryRequests: structuredClone(account.passwordRecoveryRequests || []),
    twoFactorCredentials: structuredClone(account.twoFactorCredentials || []),
    twoFactorRecoveryCodes: structuredClone(account.twoFactorRecoveryCodes || []),
    twoFactorEnrollment: structuredClone(account.twoFactorEnrollment || null),
    twoFactorChallenges: structuredClone(account.twoFactorChallenges || []),
    twoFactorLockouts: structuredClone(account.twoFactorLockouts || []),
    sessionIds: [...(account.sessionIds || [])],
    refreshTokenIds: [...(account.refreshTokenIds || [])],
    ...account,
    roleKeys: new Set(account.roleKeys || []),
  }));
  const roles = new Map();
  const permissions = new Map();
  const authProviders = new Map([
    ["local", {
      id: "provider-local",
      key: "local",
      type: "LOCAL",
      name: "Local Login",
      active: true,
    }],
  ]);
  const rolePermissionLinks = new Set();
  const accountRoleLinks = new Set();
  const accountUpdates = [];
  const accountCreates = [];
  const auditLogs = [];

  for (const account of accounts) {
    for (const key of account.roleKeys) {
      roles.set(key, { id: `role-${key}`, key, label: key });
    }
  }

  function accountRow(account) {
    if (!account) return null;
    return {
      ...account,
      roles: [...account.roleKeys].map((key) => ({
        role: roles.get(key),
      })),
      sessions: account.sessionIds.map((id) => ({ id, endedAt: null })),
      refreshTokens: account.refreshTokenIds.map((id) => ({ id, revokedAt: null })),
      passwordRecoveryRequests: account.passwordRecoveryRequests.filter((request) => (
        ["PENDING", "LOCKED", "APPROVED"].includes(request.status)
      )),
    };
  }

  function applyData(row, data) {
    for (const [key, value] of Object.entries(data || {})) {
      if (value && typeof value === "object" && Object.hasOwn(value, "increment")) {
        row[key] += value.increment;
      } else {
        row[key] = value;
      }
    }
  }

  function accountFor(where) {
    return accounts.find((account) => account.id === where.accountId);
  }

  const transaction = {
    account: {
      async findUnique({ where }) {
        return accountRow(accounts.find((account) => (
          where.loginName ? account.loginName === where.loginName : account.id === where.id
        )));
      },
      async updateMany({ where, data }) {
        const account = accounts.find((candidate) => candidate.id === where.id);
        if (
          !account
          || account.credentialRevision !== where.credentialRevision
          || account.type !== where.type
          || account.isActive !== where.isActive
        ) return { count: 0 };
        applyData(account, data);
        accountUpdates.push({ where, data });
        return { count: 1 };
      },
      async create({ data }) {
        assert.equal(accounts.some((account) => account.loginName === data.loginName), false);
        const account = {
          id: `account-created-${accounts.length + 1}`,
          ...data,
          roleKeys: new Set(),
          sessionIds: [],
          refreshTokenIds: [],
          credentialRevision: 0,
          twoFactorProviderId: null,
          twoFactorEnrolledAt: null,
          privateDataTwoFactorEnrolledAt: null,
          passwordRecoveryLockedAt: null,
          passwordRecoveryRequestId: null,
          passwordRecoveryRequests: [],
          twoFactorCredentials: [],
          twoFactorRecoveryCodes: [],
          twoFactorEnrollment: null,
          twoFactorChallenges: [],
          twoFactorLockouts: [],
        };
        accounts.push(account);
        accountCreates.push(structuredClone(data));
        return account;
      },
    },
    authProvider: {
      async upsert({ where, update, create }) {
        const existing = authProviders.get(where.key);
        const provider = existing
          ? { ...existing, ...update }
          : { id: `provider-${where.key}`, ...create };
        authProviders.set(where.key, provider);
        return provider;
      },
    },
    permission: {
      async upsert({ where, update, create }) {
        const existing = permissions.get(where.key);
        const row = existing
          ? { ...existing, ...update }
          : { id: `permission-${where.key}`, ...create };
        permissions.set(where.key, row);
        return row;
      },
    },
    role: {
      async upsert({ where, update, create }) {
        const existing = roles.get(where.key);
        const row = existing
          ? { ...existing, ...update }
          : { id: `role-${where.key}`, ...create };
        roles.set(where.key, row);
        return row;
      },
    },
    rolePermission: {
      async upsert({ create }) {
        rolePermissionLinks.add(`${create.roleId}:${create.permissionId}`);
        return create;
      },
    },
    accountRole: {
      async upsert({ create }) {
        accountRoleLinks.add(`${create.accountId}:${create.roleId}`);
        const account = accounts.find((candidate) => candidate.id === create.accountId);
        const role = [...roles.values()].find((candidate) => candidate.id === create.roleId);
        assert.ok(account);
        assert.ok(role);
        account.roleKeys.add(role.key);
        return create;
      },
    },
    securityTwoFactorCredential: {
      async updateMany({ where, data }) {
        const account = accountFor(where);
        if (!account) return { count: 0 };
        const rows = account.twoFactorCredentials.filter((row) => (
          !where.status
          || typeof where.status === "string" && row.status === where.status
          || Array.isArray(where.status?.in) && where.status.in.includes(row.status)
        ));
        rows.forEach((row) => applyData(row, data));
        return { count: rows.length };
      },
    },
    securityTwoFactorRecoveryCode: {
      async deleteMany({ where }) {
        const account = accountFor(where);
        if (!account) return { count: 0 };
        const count = account.twoFactorRecoveryCodes.length;
        account.twoFactorRecoveryCodes = [];
        return { count };
      },
    },
    securityTwoFactorEnrollment: {
      async updateMany({ where, data }) {
        const account = accountFor(where);
        const enrollment = account?.twoFactorEnrollment;
        if (!enrollment) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(enrollment.status)) return { count: 0 };
        if (where.enrollmentPasswordHash?.not === null && enrollment.enrollmentPasswordHash == null) return { count: 0 };
        applyData(enrollment, data);
        return { count: 1 };
      },
    },
    securityTwoFactorChallenge: {
      async updateMany({ where, data }) {
        const account = accountFor(where);
        if (!account) return { count: 0 };
        const rows = account.twoFactorChallenges.filter((row) => where.status.in.includes(row.status));
        rows.forEach((row) => applyData(row, data));
        return { count: rows.length };
      },
    },
    securityTwoFactorLockout: {
      async deleteMany({ where }) {
        const account = accountFor(where);
        if (!account) return { count: 0 };
        const count = account.twoFactorLockouts.length;
        account.twoFactorLockouts = [];
        return { count };
      },
    },
    securityAccountRecoveryRequest: {
      async updateMany({ where, data }) {
        const account = accountFor(where);
        if (!account) return { count: 0 };
        const rows = account.passwordRecoveryRequests.filter((row) => (
          !where.status
          || typeof where.status === "string" && row.status === where.status
          || Array.isArray(where.status?.in) && where.status.in.includes(row.status)
        ));
        rows.forEach((row) => applyData(row, data));
        return { count: rows.length };
      },
    },
    session: {
      async updateMany({ where }) {
        const account = accountFor(where);
        if (!account) return { count: 0 };
        const count = account.sessionIds.length;
        account.sessionIds = [];
        return { count };
      },
    },
    refreshToken: {
      async updateMany({ where }) {
        const account = accountFor(where);
        if (!account) return { count: 0 };
        const count = account.refreshTokenIds.length;
        account.refreshTokenIds = [];
        return { count };
      },
    },
  };

  return {
    accounts,
    roles,
    permissions,
    authProviders,
    rolePermissionLinks,
    accountRoleLinks,
    accountUpdates,
    accountCreates,
    auditLogs,
    async $transaction(callback) {
      return callback(transaction);
    },
    auditLog: {
      async create({ data }) {
        auditLogs.push(data);
        return data;
      },
    },
  };
}

const counterDeclaration = {
  loginName: "counter-terminal",
  profileKey: "counter",
  label: "Counter",
  legacyRoleKeys: ["legacy-counter"],
};

test("terminal identity keys are canonical and module-owned", () => {
  assert.deepEqual(
    describeTerminalAccountIdentity("app.example", "counter"),
    {
      ownerModule: "app.example",
      profileKey: "counter",
      roleKey: "access:app:app-example:counter",
      permissionKey: "module.app-example.counter",
    },
  );
  assert.deepEqual(
    describeTerminalAccountIdentity("addon.example", "counter"),
    {
      ownerModule: "addon.example",
      profileKey: "counter",
      roleKey: "access:addon:addon-example:counter",
      permissionKey: "module.addon-example.counter",
    },
  );
});

test("manifest declarations are immutable and reject protected generic legacy roles", () => {
  const declarations = normalizeDeclaredModuleTerminalAccounts("app.example", [
    counterDeclaration,
  ]);
  assert.equal(Object.isFrozen(declarations), true);
  assert.equal(Object.isFrozen(declarations[0]), true);
  assert.equal(Object.isFrozen(declarations[0].legacyRoleKeys), true);

  for (const legacyRoleKey of [
    "member",
    "admin",
    "user",
    "service",
    "system-admin",
    "system_admin",
    "system.admin",
    "system:admin",
    "access:app:other:counter",
    "module.app-example.member",
    "system.operator",
    "core_admin",
  ]) {
    assert.throws(
      () => normalizeDeclaredModuleTerminalAccounts("app.example", [{
        ...counterDeclaration,
        legacyRoleKeys: [legacyRoleKey],
      }]),
      /TERMINAL_ACCOUNT_LEGACY_ROLE_INVALID/,
    );
  }
});

test("manifest validator binds technical declarations to the capability and TERMINAL profile", () => {
  const manifest = {
    key: "app.example",
    kind: "app",
    name: "Example",
    version: "1.0.0",
    dependsOn: ["core.terminal-accounts"],
    permissions: {
      provides: ["module.app-example.counter"],
      requires: [],
    },
    metadata: {
      technicalAccounts: [counterDeclaration],
      accessProfiles: [{
        key: "counter",
        label: "Counter",
        permission: "module.app-example.counter",
        workspace: "COUNTER",
        usage: "technical",
        accountType: "TERMINAL",
      }],
    },
  };

  assert.deepEqual(validateModuleManifest(manifest), { ok: true, errors: [] });
  assert.match(
    validateModuleManifest({
      ...manifest,
      dependsOn: [],
    }).errors.join(" "),
    /metadata\.technicalAccounts benötigt dependsOn core\.terminal-accounts/,
  );
  assert.match(
    validateModuleManifest({
      ...manifest,
      metadata: {
        ...manifest.metadata,
        technicalAccounts: [{
          ...counterDeclaration,
          legacyRoleKeys: ["access:app:foreign:counter"],
        }],
      },
    }).errors.join(" "),
    /metadata\.technicalAccounts ist ungültig/,
  );
  assert.match(
    validateModuleManifest({
      ...manifest,
      metadata: {
        ...manifest.metadata,
        accessProfiles: [{
          ...manifest.metadata.accessProfiles[0],
          accountType: "SERVICE",
        }],
      },
    }).errors.join(" "),
    /exakt auf technische TERMINAL-Zugriffsprofile/,
  );
});

test("existing account reconciliation preserves identity but shreds interactive security material", async () => {
  const database = fakeDatabase([{
    id: "account-existing",
    loginName: "counter-terminal",
    type: "MEMBER",
    authProviderId: "provider-external",
    passwordHash: "existing-password-hash",
    personId: "person-existing",
    email: "terminal@example.invalid",
    externalSubject: "legacy-subject",
    isActive: true,
    credentialRevision: 3,
    twoFactorProviderId: "local",
    twoFactorEnrolledAt: "2026-01-01T00:00:00.000Z",
    privateDataTwoFactorEnrolledAt: "2026-01-01T00:00:00.000Z",
    twoFactorCredentials: [{
      id: "totp-existing",
      status: "ACTIVE",
      secretEncrypted: "ciphertext",
      secretFingerprint: "fingerprint",
      enrollmentSlot: "account-existing",
      externalCredentialId: null,
    }],
    twoFactorRecoveryCodes: [{ id: "recovery-existing" }],
    twoFactorEnrollment: {
      status: "CLAIMED",
      enrollmentPasswordHash: "verifier",
    },
    twoFactorChallenges: [{ id: "challenge-existing", status: "VERIFIED" }],
    passwordRecoveryLockedAt: new Date("2026-08-20T10:00:00.000Z"),
    passwordRecoveryRequestId: "password-recovery-existing",
    passwordRecoveryRequests: [{
      id: "password-recovery-existing",
      status: "LOCKED",
      activeSlot: "account-existing",
      browserTokenHash: "browser-hash",
      browserTokenExpiresAt: new Date("2026-08-22T10:00:00.000Z"),
      supportCodeHash: "support-hash",
      supportCodeExpiresAt: new Date("2026-08-20T10:15:00.000Z"),
      requestRevision: 2,
    }],
    sessionIds: ["session-existing"],
    refreshTokenIds: ["refresh-existing"],
    roleKeys: ["legacy-counter", "unrelated-role"],
  }]);
  const before = structuredClone({
    id: database.accounts[0].id,
    loginName: database.accounts[0].loginName,
    authProviderId: database.accounts[0].authProviderId,
    personId: database.accounts[0].personId,
    email: database.accounts[0].email,
    externalSubject: database.accounts[0].externalSubject,
    isActive: database.accounts[0].isActive,
  });

  const first = await reconcileDeclaredModuleTerminalAccounts(
    database,
    "app.example",
    "Example",
    [counterDeclaration],
  );
  database.accounts[0].roleKeys.delete("legacy-counter");
  const second = await reconcileDeclaredModuleTerminalAccounts(
    database,
    "app.example",
    "Example",
    [counterDeclaration],
  );

  assert.deepEqual({
    id: database.accounts[0].id,
    loginName: database.accounts[0].loginName,
    authProviderId: database.accounts[0].authProviderId,
    personId: database.accounts[0].personId,
    email: database.accounts[0].email,
    externalSubject: database.accounts[0].externalSubject,
    isActive: database.accounts[0].isActive,
  }, before);
  assert.equal(database.accounts[0].type, "TERMINAL");
  assert.equal(database.accounts[0].credentialRevision, 4);
  assert.equal(database.accounts[0].passwordHash, null);
  assert.equal(database.accounts[0].twoFactorProviderId, null);
  assert.equal(database.accounts[0].twoFactorEnrolledAt, null);
  assert.equal(database.accounts[0].privateDataTwoFactorEnrolledAt, null);
  assert.equal(database.accounts[0].passwordRecoveryLockedAt, null);
  assert.equal(database.accounts[0].passwordRecoveryRequestId, null);
  assert.deepEqual(database.accounts[0].passwordRecoveryRequests.map((row) => ({
    status: row.status,
    activeSlot: row.activeSlot,
    browserTokenHash: row.browserTokenHash,
    supportCodeHash: row.supportCodeHash,
  })), [{
    status: "CANCELLED",
    activeSlot: null,
    browserTokenHash: null,
    supportCodeHash: null,
  }]);
  assert.deepEqual(database.accounts[0].twoFactorCredentials.map((row) => ({
    status: row.status,
    secretEncrypted: row.secretEncrypted,
    secretFingerprint: row.secretFingerprint,
    enrollmentSlot: row.enrollmentSlot,
  })), [{
    status: "REVOKED",
    secretEncrypted: null,
    secretFingerprint: null,
    enrollmentSlot: null,
  }]);
  assert.deepEqual(database.accounts[0].twoFactorRecoveryCodes, []);
  assert.equal(database.accounts[0].twoFactorEnrollment.status, "REVOKED");
  assert.equal(database.accounts[0].twoFactorEnrollment.enrollmentPasswordHash, null);
  assert.equal(database.accounts[0].twoFactorChallenges[0].status, "CANCELLED");
  assert.deepEqual(database.accounts[0].sessionIds, []);
  assert.deepEqual(database.accounts[0].refreshTokenIds, []);
  assert.deepEqual([...database.accounts[0].roleKeys].sort(), [
    "access:app:app-example:counter",
    "unrelated-role",
  ]);
  assert.equal(first[0].status, "reconciled");
  assert.equal(first[0].typeChanged, true);
  assert.equal(first[0].roleAdded, true);
  assert.equal(second[0].status, "reconciled");
  assert.equal(second[0].typeChanged, false);
  assert.equal(second[0].roleAdded, false);
  assert.equal(database.accountUpdates.length, 1);
  assert.equal(database.accountCreates.length, 0);
});

test("missing declarations are created inactive, passwordless and LOCAL", async () => {
  const database = fakeDatabase();
  const [result] = await reconcileDeclaredModuleTerminalAccounts(
    database,
    "app.example",
    "Example",
    [{ ...counterDeclaration, legacyRoleKeys: [] }],
  );

  assert.deepEqual(result, {
    accountId: "account-created-1",
    loginName: "counter-terminal",
    profileKey: "counter",
    roleKey: "access:app:app-example:counter",
    permissionKey: "module.app-example.counter",
    status: "created",
    created: true,
    typeChanged: false,
    roleAdded: true,
  });
  assert.equal(database.accounts.length, 1);
  assert.deepEqual(database.accountCreates[0], {
    type: "TERMINAL",
    loginName: "counter-terminal",
    authProviderId: "provider-local",
    passwordHash: null,
    email: null,
    externalSubject: null,
    personId: null,
    isActive: false,
    isSandbox: false,
  });
  assert.equal(database.authProviders.get("local").type, "LOCAL");
  assert.deepEqual([...database.accounts[0].roleKeys], [
    "access:app:app-example:counter",
  ]);
});

test("login conflict is reported without mutation and does not block another declaration", async () => {
  const database = fakeDatabase([{
    id: "account-unrelated",
    loginName: "counter-terminal",
    type: "MEMBER",
    passwordHash: "unrelated-hash",
    personId: "person-unrelated",
    sessionIds: ["session-unrelated"],
    roleKeys: ["member"],
  }]);
  const results = await reconcileDeclaredModuleTerminalAccounts(
    database,
    "app.example",
    "Example",
    [
      counterDeclaration,
      {
        loginName: "kitchen-terminal",
        profileKey: "kitchen",
        label: "Kitchen",
        legacyRoleKeys: ["legacy-kitchen"],
      },
    ],
  );

  assert.deepEqual(results.map(({ status, conflictCode }) => ({ status, conflictCode })), [
    {
      status: "conflict",
      conflictCode: "TERMINAL_ACCOUNT_LOGIN_CONFLICT",
    },
    {
      status: "created",
      conflictCode: undefined,
    },
  ]);
  assert.equal(database.accounts[0].type, "MEMBER");
  assert.equal(database.accounts[0].passwordHash, "unrelated-hash");
  assert.deepEqual([...database.accounts[0].roleKeys], ["member"]);
  assert.deepEqual(database.accounts[0].sessionIds, ["session-unrelated"]);
  assert.equal(database.roles.has("access:app:app-example:counter"), false);
  assert.equal(database.permissions.has("module.app-example.counter"), false);
  assert.equal(database.accounts.some(({ loginName }) => loginName === "kitchen-terminal"), true);
});

test("foreign ownership, ADMIN and SERVICE collisions are per-account results", async () => {
  for (const account of [
    {
      id: "account-foreign",
      loginName: "counter-terminal",
      type: "TERMINAL",
      roleKeys: ["legacy-counter", "access:app:app-other:counter"],
      expected: "TERMINAL_ACCOUNT_OWNERSHIP_CONFLICT",
    },
    {
      id: "account-admin",
      loginName: "counter-terminal",
      type: "ADMIN",
      roleKeys: ["legacy-counter"],
      expected: "TERMINAL_ACCOUNT_TYPE_CONFLICT",
    },
    {
      id: "account-service",
      loginName: "counter-terminal",
      type: "SERVICE",
      roleKeys: ["legacy-counter"],
      expected: "TERMINAL_ACCOUNT_TYPE_CONFLICT",
    },
  ]) {
    const database = fakeDatabase([account]);
    const [result] = await reconcileDeclaredModuleTerminalAccounts(
      database,
      "app.example",
      "Example",
      [counterDeclaration],
    );
    assert.equal(result.status, "conflict");
    assert.equal(result.conflictCode, account.expected);
    assert.equal(database.accountUpdates.length, 0);
    assert.equal(database.accountCreates.length, 0);
    assert.equal(database.permissions.size, 0);
  }
});

test("module runtime exposes only the manifest-bound v2 reconciliation call", async () => {
  const runtime = createModuleTerminalAccountRuntime(
    "app.example",
    "Example",
    [counterDeclaration],
  );
  assert.equal(runtime.contractVersion, "bonni.terminal-accounts/v2");
  assert.equal(typeof runtime.reconcileDeclared, "function");
  assert.equal(runtime.reconcileDeclared.length, 0);
  assert.equal("reconcileExisting" in runtime, false);

  const loader = await readFile(
    new URL("../dist/platform/module-manager/loader/module-runtime.service.js", import.meta.url),
    "utf8",
  );
  assert.match(loader, /declaredDependencies\.has\("core\.terminal-accounts"\)/);
  assert.match(
    loader,
    /createModuleTerminalAccountRuntime\(\s*module\.key,\s*manifest\?\.name \|\| module\.name,\s*manifest\?\.metadata\?\.technicalAccounts/s,
  );
});

test("generic role labels do not hard-code an application kind", async () => {
  const database = fakeDatabase([{
    id: "account-addon",
    loginName: "counter-terminal",
    type: "MEMBER",
    passwordHash: "hash-addon",
    personId: "person-addon",
    roleKeys: ["legacy-counter"],
  }]);
  await reconcileDeclaredModuleTerminalAccounts(
    database,
    "addon.example",
    "Example Add-on",
    [counterDeclaration],
  );

  const role = database.roles.get("access:addon:addon-example:counter");
  assert.equal(role.label, "Example Add-on · Counter (verwaltet)");
  assert.doesNotMatch(role.label, /^App:/);
});
