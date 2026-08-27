import assert from "node:assert/strict";
import test from "node:test";

const {
  createModuleMembersRuntime,
  MODULE_MEMBERS_CONTRACT_VERSION,
  normalizeModuleLegacyAccessMappings,
} = await import(process.env.BONNI_TEST_SOURCE === "1"
  ? "../src/platform/auth/members/index.ts"
  : "../dist/platform/auth/members/index.js");
const {
  validateModuleManifest,
} = await import(process.env.BONNI_TEST_SOURCE === "1"
  ? "../src/platform/module-manager/manifests/manifest.service.ts"
  : "../dist/platform/module-manager/manifests/manifest.service.js");

const profiles = [
  {
    key: "member",
    label: "Member",
    permission: "module.app-example.member",
    workspace: "MEMBER",
    usage: "local",
    accountType: "MEMBER",
  },
  {
    key: "manager",
    label: "Manager",
    permission: "module.app-example.manager",
    workspace: "MEMBER",
    usage: "local",
    accountType: "MEMBER",
  },
  {
    key: "helper",
    label: "Helper",
    permission: "module.app-example.helper",
    workspace: "MEMBER",
    usage: "local",
    accountType: "MEMBER",
  },
  {
    key: "counter",
    label: "Counter",
    permission: "module.app-example.counter",
    workspace: "COUNTER",
    usage: "technical",
    accountType: "TERMINAL",
  },
];

const legacyMappings = {
  roles: { member: "member" },
  capabilities: { helper: "helper" },
};

function memberRow(overrides = {}) {
  return {
    id: "member-1",
    personId: "person-1",
    memberNumber: "M-1",
    status: "MEMBER",
    membershipStatus: "ACTIVE_MEMBER",
    joinedAt: new Date("2020-01-01T00:00:00.000Z"),
    leftAt: null,
    notes: "Core note",
    iban: "MUST_NOT_LEAK",
    bic: "MUST_NOT_LEAK",
    allowNegativeBalance: true,
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    updatedAt: new Date("2020-02-01T00:00:00.000Z"),
    person: {
      id: "person-1",
      displayName: "Ada Example",
      firstName: "Ada",
      lastName: "Example",
      nickname: null,
      email: "ada@example.test",
      phone: "123",
      birthDate: new Date("1990-01-01T00:00:00.000Z"),
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      updatedAt: new Date("2020-02-01T00:00:00.000Z"),
      accounts: [{
        id: "account-1",
        loginName: "ada",
        email: "account@example.test",
        type: "MEMBER",
        isActive: true,
        isSandbox: false,
        credentialRevision: 4,
        lastLoginAt: new Date("2024-01-01T00:00:00.000Z"),
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
        updatedAt: new Date("2020-02-01T00:00:00.000Z"),
        passwordHash: "MUST_NOT_LEAK",
        externalSubject: "MUST_NOT_LEAK",
        authProvider: {
          key: "local",
          type: "LOCAL",
          active: true,
          externalSubject: "MUST_NOT_LEAK",
        },
        roles: [
          { role: { key: "access:app:app-example:member" } },
          { role: { key: "foreign-role" } },
        ],
        accountMemberCapabilities: [
          { capability: { key: "HELPER" } },
          { capability: { key: "FOREIGN" } },
        ],
        sessions: [{ token: "MUST_NOT_LEAK" }],
      }],
    },
    presenceLog: [{
      id: "presence-1",
      status: "PRESENT",
      source: "door",
      note: null,
      createdAt: new Date("2024-02-01T00:00:00.000Z"),
    }],
    ...overrides,
  };
}

function readDatabase(row = memberRow()) {
  const passwordUpdates = [];
  const sessionRevocations = [];
  const refreshTokenRevocations = [];
  const recoveryRequestUpdates = [];
  const recoveryAuditLogs = [];
  return {
    passwordUpdates,
    sessionRevocations,
    refreshTokenRevocations,
    recoveryRequestUpdates,
    recoveryAuditLogs,
    async $transaction(callback) {
      return callback({
        account: {
          async updateMany(input) {
            passwordUpdates.push(input);
            return { count: 1 };
          },
        },
        session: {
          async updateMany(input) {
            sessionRevocations.push(input);
            return { count: 1 };
          },
        },
        refreshToken: {
          async updateMany(input) {
            refreshTokenRevocations.push(input);
            return { count: 1 };
          },
        },
        securityTwoFactorCredential: {
          async findMany() { return []; },
          async updateMany() { return { count: 0 }; },
        },
        securityTwoFactorRecoveryCode: {
          async updateMany() { return { count: 0 }; },
        },
        securityTwoFactorEnrollment: {
          async updateMany() { return { count: 0 }; },
        },
        securityTwoFactorChallenge: {
          async updateMany() { return { count: 0 }; },
        },
        securityAccountRecoveryRequest: {
          async findMany() { return []; },
          async updateMany(input) {
            recoveryRequestUpdates.push(input);
            return { count: 1 };
          },
        },
        securityAccountRecoveryAuditLog: {
          async create(input) {
            recoveryAuditLogs.push(input);
            return input;
          },
        },
      });
    },
    memberProfile: {
      async findUnique(input) {
        if (input.select?.id && Object.keys(input.select).length === 1) {
          return { id: row.id };
        }
        return row;
      },
      async findMany(input) {
        if (input.select?.allowNegativeBalance) {
          return [
            {
              id: "member-1",
              allowNegativeBalance: true,
              account: {
                id: "financial-1",
                balanceCached: { toString: () => "12.34" },
                lastSettledAt: null,
                createdAt: new Date("2020-01-01T00:00:00.000Z"),
                updatedAt: new Date("2020-02-01T00:00:00.000Z"),
              },
            },
            {
              id: "member-without-account",
              allowNegativeBalance: false,
              account: null,
            },
          ];
        }
        return [row];
      },
      async update() {
        return row;
      },
    },
    memberPresenceLog: {
      async findMany() {
        return row.presenceLog;
      },
    },
    account: {
      async findUnique(input) {
        if (input.select?.person) {
          return {
            type: "MEMBER",
            isSandbox: false,
            person: { member: { id: row.id } },
          };
        }
        return null;
      },
      async update(input) {
        passwordUpdates.push(input);
        return { id: input.where.id };
      },
      async findMany() {
        return [];
      },
    },
  };
}

function runtime(database = readDatabase(), options = {}) {
  return createModuleMembersRuntime(
    "app.example",
    profiles,
    legacyMappings,
    {
      prisma: database,
      publishRecords: async () => ({ published: 0 }),
      ...options,
    },
  );
}

test("member DTO is field-bounded and matches the module accessAccounts contract", async () => {
  const members = runtime();
  const result = await members.get("member-1", { presenceLimit: 5 });

  assert.equal(members.contractVersion, MODULE_MEMBERS_CONTRACT_VERSION);
  assert.equal(members.moduleKey, "app.example");
  assert.equal(result.person.id, "person-1");
  assert.equal(result.notes, "Core note");
  assert.deepEqual(Object.keys(result.accessAccounts[0]).sort(), [
    "accessProfiles",
    "accountId",
    "isActive",
    "isSandbox",
    "lastLoginAt",
    "loginName",
    "memberCapabilities",
    "securityState",
    "settlementOnly",
    "type",
  ]);
  assert.equal(result.accessAccounts[0].securityState, "READY");
  assert.equal(result.accessAccounts[0].settlementOnly, false);
  assert.deepEqual(result.accessAccounts[0].accessProfiles, ["member"]);
  assert.deepEqual(result.accessAccounts[0].memberCapabilities, ["HELPER"]);
  assert.equal(result.presence[0].id, "presence-1");
  assert.equal("accounts" in result, false);
  assert.equal("accessProfiles" in result, false);
  assert.equal("legacyCapabilities" in result, false);
  assert.equal("presenceLogs" in result, false);
  assert.equal("authProvider" in result.accessAccounts[0], false);
  assert.equal("passwordHash" in result.accessAccounts[0], false);
  assert.equal("iban" in result, false);
  assert.equal("bic" in result, false);
  assert.equal("allowNegativeBalance" in result, false);
});

test("getByAccountId resolves only a personal Core member account", async () => {
  const result = await runtime().getByAccountId("account-1");
  assert.equal(result.memberId, "member-1");
});

test("technical-only profiles and declared technical account ids are hidden from member reads", async () => {
  const technicalRow = memberRow();
  technicalRow.person.accounts[0].loginName = "counter-terminal";
  const database = readDatabase(technicalRow);
  database.account.findUnique = async () => ({
    loginName: "counter-terminal",
    type: "MEMBER",
    isSandbox: false,
    roles: [{ role: { key: "legacy-counter" } }],
    person: { member: { id: "member-1" } },
  });
  const members = runtime(database, {
    technicalAccounts: [{
      loginName: "counter-terminal",
      profileKey: "counter",
      label: "Counter",
      legacyRoleKeys: ["legacy-counter"],
    }],
  });

  assert.equal(await members.get("member-1"), null);
  assert.equal(await members.getByAccountId("account-technical"), null);
});

test("password reset hashes in Core and requires exactly one active personal LOCAL account", async () => {
  const database = readDatabase();
  const members = runtime(database, {
    hashPassword: async (password) => `hashed:${password}`,
  });
  const result = await members.resetLocalPassword(
    "member-1",
    "correct horse battery staple",
  );
  assert.deepEqual(result, {
    memberId: "member-1",
    accountId: "account-1",
    mode: "custom",
    updated: true,
  });
  assert.deepEqual(database.passwordUpdates, [{
    where: { id: "account-1", credentialRevision: 4, passwordRecoveryLockedAt: null },
    data: {
      passwordHash: "hashed:correct horse battery staple",
      credentialRevision: { increment: 1 },
    },
  }]);
  assert.equal(database.sessionRevocations.length, 1);
  assert.deepEqual(database.sessionRevocations[0].where, {
    accountId: "account-1",
    endedAt: null,
  });
  assert.equal(database.refreshTokenRevocations.length, 1);
  assert.deepEqual(database.refreshTokenRevocations[0].where, {
    accountId: "account-1",
    revokedAt: null,
  });

  const ambiguous = memberRow();
  ambiguous.person.accounts.push({
    ...structuredClone(ambiguous.person.accounts[0]),
    id: "account-2",
    loginName: "ada.second",
  });
  await assert.rejects(
    runtime(readDatabase(ambiguous)).resetLocalPassword(
      "member-1",
      "correct horse battery staple",
    ),
    (error) => error?.code === "CORE_MEMBERS_LOCAL_ACCOUNT_AMBIGUOUS"
      && error?.statusCode === 409,
  );
});

test("legacy financial export includes every member, even without MemberAccount", async () => {
  assert.deepEqual(await runtime().exportLegacyFinancialProfiles(), [
    {
      memberId: "member-1",
      allowNegativeBalance: true,
      memberAccount: {
        id: "financial-1",
        balanceCached: "12.34",
        lastSettledAt: null,
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
        updatedAt: new Date("2020-02-01T00:00:00.000Z"),
      },
    },
    {
      memberId: "member-without-account",
      allowNegativeBalance: false,
      memberAccount: null,
    },
  ]);
});

test("legacy mappings normalize source keys case-insensitively and reject technical targets", () => {
  const normalized = normalizeModuleLegacyAccessMappings(
    {
      roles: { Member: "member" },
      capabilities: { HeLpEr: "helper" },
    },
    profiles,
  );
  assert.equal(normalized.roles.get("MEMBER"), "member");
  assert.equal(normalized.capabilities.get("HELPER"), "helper");
  assert.throws(
    () => normalizeModuleLegacyAccessMappings(
      { roles: { bar: "counter" } },
      profiles,
    ),
    /CORE_MEMBERS_LEGACY_ACCESS_MAPPING_TARGET_INVALID/,
  );
});

test("manifest binds legacy mappings to core.members and declared local profiles", () => {
  const manifest = {
    key: "app.example",
    kind: "app",
    name: "Example",
    version: "1.0.0",
    dependsOn: ["core.members"],
    permissions: {
      provides: profiles.map((profile) => profile.permission),
      requires: [],
    },
    metadata: {
      accessProfiles: profiles,
      legacyAccessMappings: {
        roles: { MEMBER: "member" },
        capabilities: { HELPER: "helper" },
      },
    },
  };
  assert.deepEqual(validateModuleManifest(manifest), { ok: true, errors: [] });
  assert.match(
    validateModuleManifest({
      ...manifest,
      dependsOn: [],
    }).errors.join(" "),
    /legacyAccessMappings benötigt dependsOn core\.members/,
  );
  assert.match(
    validateModuleManifest({
      ...manifest,
      metadata: {
        ...manifest.metadata,
        legacyAccessMappings: {
          capabilities: { HELPER: "counter" },
        },
      },
    }).errors.join(" "),
    /legacyAccessMappings ist ungültig/,
  );
  assert.match(
    validateModuleManifest({
      key: "app.no-member-profile",
      kind: "app",
      name: "No Member Profile",
      version: "1.0.0",
      dependsOn: ["core.members"],
    }).errors.join(" "),
    /core\.members benötigt das lokale MEMBER-Zugriffsprofil member/,
  );
});

test("create accepts no requested login, creates a passwordless MEMBER account and default access", async () => {
  let readRow = null;
  let createdAccount = null;
  const assignedRoles = [];
  const transaction = {
    authProvider: {
      async upsert() {
        return { id: "provider-local", type: "LOCAL" };
      },
    },
    person: {
      async create({ data }) {
        return { id: "person-created", ...data };
      },
    },
    memberProfile: {
      async create({ data }) {
        readRow = memberRow({
          ...data,
          person: {
            ...memberRow().person,
            id: "person-created",
            displayName: "No Login",
            accounts: [],
          },
          presenceLog: [],
        });
        return { id: data.id };
      },
    },
    account: {
      async create({ data }) {
        createdAccount = data;
        readRow.person.accounts = [{
          ...data,
          roles: [{ role: { key: "access:app:app-example:member" } }],
          accountMemberCapabilities: [],
        }];
        return data;
      },
    },
    permission: {
      async upsert({ create }) {
        return { id: "permission-member", ...create };
      },
    },
    role: {
      async upsert({ create }) {
        return { id: "role-member", ...create };
      },
    },
    rolePermission: {
      async upsert() {
        return {};
      },
    },
    accountRole: {
      async upsert({ create }) {
        assignedRoles.push(create);
        return create;
      },
    },
  };
  const database = {
    async $transaction(callback) {
      return callback(transaction);
    },
    memberProfile: {
      async findUnique() {
        return readRow;
      },
      async findMany() {
        return [];
      },
    },
    memberPresenceLog: { async findMany() { return []; } },
    account: {
      async findUnique() { return null; },
      async update() { return null; },
      async findMany() { return []; },
    },
  };
  const members = runtime(database, {
    provisionArchive: async () => ({ provisioned: true }),
  });
  const result = await members.create({ displayName: "No Login" });

  assert.match(createdAccount.loginName, /^no\.login\.[a-z0-9]{12}$/);
  assert.equal(createdAccount.type, "MEMBER");
  assert.equal(createdAccount.passwordHash, null);
  assert.equal(createdAccount.isActive, true);
  assert.equal(createdAccount.isSandbox, false);
  assert.deepEqual(assignedRoles, [{
    accountId: createdAccount.id,
    roleId: "role-member",
  }]);
  assert.equal(result.accessAccounts[0].accessProfiles[0], "member");
});

test("createAccount false creates a real member without a login or technical account", async () => {
  let readRow = null;
  const transaction = {
    person: {
      async create({ data }) {
        return { id: "person-without-account", ...data };
      },
    },
    memberProfile: {
      async create({ data }) {
        readRow = memberRow({
          ...data,
          person: {
            ...memberRow().person,
            id: "person-without-account",
            displayName: "Mitglied ohne Konto",
            accounts: [],
          },
          presenceLog: [],
        });
        return { id: data.id };
      },
    },
  };
  const database = {
    async $transaction(callback) {
      return callback(transaction);
    },
    memberProfile: {
      async findUnique() { return readRow; },
      async findMany() { return []; },
    },
    memberPresenceLog: { async findMany() { return []; } },
    account: {
      async findUnique() { return null; },
      async update() { return null; },
      async findMany() { return []; },
    },
  };

  const result = await runtime(database).create({
    createAccount: false,
    displayName: "Mitglied ohne Konto",
  });

  assert.equal(result.person.displayName, "Mitglied ohne Konto");
  assert.deepEqual(result.accessAccounts, []);
});

test("setAccessProfiles always keeps default member and touches only local roles of its module", async () => {
  const row = memberRow();
  const roleLookups = [];
  const deletedLinks = [];
  const assignedRoleKeys = [];
  const transaction = {
    role: {
      async findMany(input) {
        roleLookups.push(input);
        return [
          { id: "old-member" },
          { id: "old-manager" },
        ];
      },
      async upsert({ where, create }) {
        assignedRoleKeys.push(where.key);
        return { id: `new:${where.key}`, ...create };
      },
    },
    permission: {
      async upsert({ where, create }) {
        return { id: `permission:${where.key}`, ...create };
      },
    },
    rolePermission: {
      async upsert() {
        return {};
      },
    },
    accountRole: {
      async deleteMany(input) {
        deletedLinks.push(input);
        return { count: 2 };
      },
      async upsert() {
        return {};
      },
    },
  };
  const database = readDatabase(row);
  database.$transaction = async (callback) => callback(transaction);

  await runtime(database).setAccessProfiles("member-1", ["manager"]);

  assert.deepEqual(new Set(roleLookups[0].where.key.in), new Set([
    "access:app:app-example:member",
    "access:app:app-example:manager",
    "access:app:app-example:helper",
  ]));
  assert.equal(
    roleLookups[0].where.key.in.includes("access:app:app-example:counter"),
    false,
    "technical profiles are outside the member mutation boundary",
  );
  assert.deepEqual(deletedLinks, [{
    where: {
      accountId: "account-1",
      roleId: { in: ["old-member", "old-manager"] },
    },
  }]);
  assert.deepEqual(new Set(assignedRoleKeys), new Set([
    "access:app:app-example:member",
    "access:app:app-example:manager",
  ]));
});

test("lifecycle status changes keep MemberStatus and ClubMembershipStatus consistent", async () => {
  const row = memberRow();
  const updates = [];
  const database = readDatabase(row);
  database.memberProfile.findUnique = async (input) => {
    if (input.select?.membershipStatus) {
      return {
        id: row.id,
        status: "MEMBER",
        membershipStatus: "ACTIVE_MEMBER",
        leftAt: null,
      };
    }
    return row;
  };
  database.memberProfile.update = async (input) => {
    updates.push(input);
    return row;
  };
  const members = runtime(database);

  await members.setStatus("member-1", "FORMER_MEMBER");
  assert.equal(updates[0].data.status, "FORMER_MEMBER");
  assert.equal(updates[0].data.membershipStatus, "RESIGNED");
  assert.ok(updates[0].data.leftAt instanceof Date);

  database.memberProfile.findUnique = async (input) => {
    if (input.select?.membershipStatus) {
      return {
        id: row.id,
        status: "FORMER_MEMBER",
        membershipStatus: "RESIGNED",
        leftAt: new Date(),
      };
    }
    return row;
  };
  await members.setStatus("member-1", "MEMBER");
  assert.deepEqual(updates[1].data, {
    status: "MEMBER",
    membershipStatus: "ACTIVE_MEMBER",
    leftAt: null,
  });
});

test("reconcile maps declared legacy access, keeps foreign data and skips technical identities", async () => {
  const assigned = [];
  const transaction = {
    permission: {
      async upsert({ where, create }) {
        return { id: `permission:${where.key}`, ...create };
      },
    },
    role: {
      async upsert({ where, create }) {
        return { id: `role:${where.key}`, ...create };
      },
    },
    rolePermission: {
      async upsert() {
        return {};
      },
    },
    accountRole: {
      async upsert({ create }) {
        assigned.push(create);
        return create;
      },
    },
  };
  const personal = {
    id: "personal-account",
    loginName: "personal",
    type: "MEMBER",
    isActive: true,
    isSandbox: false,
    person: {
      member: { id: "personal-member", status: "MEMBER" },
    },
    roles: [
      { role: { key: "member" } },
      { role: { key: "access:app:foreign:owner" } },
    ],
    accountMemberCapabilities: [
      { capability: { key: "HELPER" } },
      { capability: { key: "FOREIGN" } },
    ],
  };
  const technical = {
    ...structuredClone(personal),
    id: "technical-account",
    loginName: "counter-terminal",
    person: {
      member: { id: "technical-member", status: "MEMBER" },
    },
    roles: [{ role: { key: "legacy-counter" } }],
  };
  const database = readDatabase();
  database.account.findMany = async () => [personal, technical];
  database.$transaction = async (callback) => callback(transaction);

  const result = await runtime(database, {
    technicalAccounts: [{
      loginName: "counter-terminal",
      profileKey: "counter",
      label: "Counter",
      legacyRoleKeys: ["legacy-counter"],
    }],
  }).reconcileDeclaredAccess();

  assert.equal(result.examined, 2);
  assert.equal(result.reconciled, 1);
  assert.equal(result.results[0].accountId, "personal-account");
  assert.deepEqual(new Set(result.results[0].addedProfiles), new Set([
    "member",
    "helper",
  ]));
  assert.deepEqual(new Set(assigned.map((entry) => entry.roleId)), new Set([
    "role:access:app:app-example:member",
    "role:access:app:app-example:helper",
  ]));
  assert.equal(
    assigned.some((entry) => entry.accountId === "technical-account"),
    false,
  );
});
