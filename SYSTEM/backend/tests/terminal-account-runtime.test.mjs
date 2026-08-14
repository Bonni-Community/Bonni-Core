import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createModuleTerminalAccountRuntime,
  describeTerminalAccountIdentity,
  normalizeDeclaredModuleTerminalAccounts,
  reconcileDeclaredModuleTerminalAccounts,
} from "../dist/platform/auth/terminal-accounts/terminal-account.service.js";
import { validateModuleManifest } from "../dist/platform/module-manager/manifests/manifest.service.js";

function fakeDatabase(initialAccounts = []) {
  const accounts = initialAccounts.map((account) => ({
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
    };
  }

  const transaction = {
    account: {
      async findUnique({ where }) {
        return accountRow(accounts.find((account) => account.loginName === where.loginName));
      },
      async update({ where, data }) {
        assert.deepEqual(Object.keys(data), ["type"]);
        const account = accounts.find((candidate) => candidate.id === where.id);
        assert.ok(account);
        account.type = data.type;
        accountUpdates.push({ where, data });
        return account;
      },
      async create({ data }) {
        assert.equal(accounts.some((account) => account.loginName === data.loginName), false);
        const account = {
          id: `account-created-${accounts.length + 1}`,
          ...data,
          roleKeys: new Set(),
          sessionIds: [],
          refreshTokenIds: [],
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

test("existing account reconciliation preserves every identity and credential field", async () => {
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
    sessionIds: ["session-existing"],
    refreshTokenIds: ["refresh-existing"],
    roleKeys: ["legacy-counter", "unrelated-role"],
  }]);
  const before = structuredClone({
    id: database.accounts[0].id,
    loginName: database.accounts[0].loginName,
    authProviderId: database.accounts[0].authProviderId,
    passwordHash: database.accounts[0].passwordHash,
    personId: database.accounts[0].personId,
    email: database.accounts[0].email,
    externalSubject: database.accounts[0].externalSubject,
    isActive: database.accounts[0].isActive,
    sessionIds: database.accounts[0].sessionIds,
    refreshTokenIds: database.accounts[0].refreshTokenIds,
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
    passwordHash: database.accounts[0].passwordHash,
    personId: database.accounts[0].personId,
    email: database.accounts[0].email,
    externalSubject: database.accounts[0].externalSubject,
    isActive: database.accounts[0].isActive,
    sessionIds: database.accounts[0].sessionIds,
    refreshTokenIds: database.accounts[0].refreshTokenIds,
  }, before);
  assert.equal(database.accounts[0].type, "TERMINAL");
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
