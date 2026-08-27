import assert from "node:assert/strict";
import test from "node:test";

import "./test-env.mjs";

const sourceMode = process.env.BONNI_TEST_SOURCE === "1";
const { createModuleProtectedPeopleRuntime } = await import(
  sourceMode
    ? "../src/core/protected-people/index.ts"
    : "../dist/core/protected-people/index.js"
);
const { createModuleProtectedOrganizationRuntime } = await import(
  sourceMode
    ? "../src/core/protected-organization/index.ts"
    : "../dist/core/protected-organization/index.js"
);
const { runWithVerifiedRequestIdentity } = await import(
  sourceMode
    ? "../src/platform/auth/request-identity/request-identity-context.ts"
    : "../dist/platform/auth/request-identity/request-identity-context.js"
);

const identity = Object.freeze({
  accountId: "account-1",
  loginName: "manager",
  type: "MEMBER",
  roles: [],
  permissions: [],
  allowedApps: [],
  personId: "person-1",
  memberId: "member-1",
  credentialRevision: 7,
});

function withIdentity(callback, assurance = null) {
  return runWithVerifiedRequestIdentity(identity, callback, assurance);
}

const mfaAssurance = Object.freeze({
  sessionId: "session-manager-1",
  accountId: "account-1",
  credentialRevision: 7,
  mfaVerifiedAt: "2026-08-22T08:15:00.000Z",
  mfaProviderId: "local",
  mfaMethod: "TOTP",
});

test("a verified module challenge issues a grant accepted by protected organization", async () => {
  let storedGrant = null;
  let consumedInput = null;
  const privacy = {
    protectedDataAccessGrant: {
      async create({ data }) {
        storedGrant = { ...data, id: "grant-1", revokedAt: null };
        return storedGrant;
      },
      async findUnique({ where }) {
        return storedGrant?.tokenHash === where.tokenHash ? storedGrant : null;
      },
    },
    protectedDataAccessLog: {
      async create({ data }) { return data; },
    },
  };
  const protectedPeople = createModuleProtectedPeopleRuntime(
    "app.kontorapp",
    {},
    {},
    privacy,
    {
      async consumeVerifiedChallenge(input) {
        consumedInput = input;
        return {
          credentialRevision: 7,
          providerId: "local",
          accessScope: "app.kontorapp:ACCOUNTING_PAYMENT",
        };
      },
    },
  );

  const issued = await withIdentity(() => protectedPeople.issueAccessGrant({
    challengeId: "challenge-1",
    purpose: "KONTOR.MANAGER.PRIVATE_DATA",
    minutes: 10,
  }));

  assert.equal(consumedInput.accessScope, "ACCOUNTING_PAYMENT");
  assert.equal(consumedInput.moduleKey, "app.kontorapp");
  assert.equal(storedGrant.accessScope, "ACCOUNTING_PAYMENT");

  const protectedOrganization = createModuleProtectedOrganizationRuntime(
    "app.kontorapp",
    {
      organizationProfile: { async findUnique() { return null; } },
      organizationBankAccount: { async findFirst() { return null; } },
    },
    privacy,
    { async get() { return { organizationId: "organization-1", tenantId: "tenant-1" }; } },
    {
      async getTwoFactorStatus() {
        return {
          enabled: true,
          available: true,
          privateDataProtectionEnrolled: true,
          credentialRevision: 7,
          provider: { id: "local", configured: true, available: true },
        };
      },
    },
  );

  const result = await withIdentity(() => protectedOrganization.getCollectionIdentity({
    purpose: "KONTOR.MANAGER.PRIVATE_DATA",
    grantToken: issued.token,
  }));
  assert.equal(result, null);
});

test("grant issuance fails closed if Core returns a differently bound challenge scope", async () => {
  const privacy = {
    protectedDataAccessGrant: {
      async create() { throw new Error("must not persist"); },
    },
    protectedDataAccessLog: { async create() { throw new Error("must not audit"); } },
  };
  const protectedPeople = createModuleProtectedPeopleRuntime(
    "app.kontorapp",
    {},
    {},
    privacy,
    {
      async consumeVerifiedChallenge() {
        return {
          credentialRevision: 7,
          providerId: "local",
          accessScope: "app.otherapp:ACCOUNTING_PAYMENT",
        };
      },
    },
  );

  await assert.rejects(
    withIdentity(() => protectedPeople.issueAccessGrant({
      challengeId: "challenge-1",
      purpose: "KONTOR.MANAGER.PRIVATE_DATA",
    })),
    (error) => error?.code === "PROTECTED_PEOPLE_CHALLENGE_SCOPE_INVALID"
      && error?.statusCode === 500,
  );
});

test("login MFA session unlocks normal Kontor people and organization data", async () => {
  const privacy = {
    protectedDataAccessGrant: {
      async findUnique() { throw new Error("session MFA must not query a private grant"); },
    },
    protectedDataAccessLog: {
      async create({ data }) { return data; },
    },
  };
  const twoFactorStatus = async () => ({
    enabled: true,
    available: true,
    privateDataProtectionEnrolled: true,
    credentialRevision: 7,
    provider: { id: "local", configured: true, available: true },
  });
  const protectedPeople = createModuleProtectedPeopleRuntime(
    "app.kontorapp",
    {
      memberProfile: {
        async findUnique() { return { id: "member-1", personId: "person-1" }; },
      },
    },
    {
      peopleBankAccount: { async findFirst() { return null; } },
    },
    privacy,
    { getTwoFactorStatus: twoFactorStatus },
  );
  const protectedOrganization = createModuleProtectedOrganizationRuntime(
    "app.kontorapp",
    {
      organizationProfile: { async findUnique() { return null; } },
      organizationBankAccount: { async findFirst() { return null; } },
    },
    privacy,
    { async get() { return { organizationId: "organization-1", tenantId: "tenant-1" }; } },
    { getTwoFactorStatus: twoFactorStatus },
  );

  assert.equal(await withIdentity(() => protectedPeople.getPaymentAccount({
    memberId: "member-1",
    purpose: "KONTOR.MEMBER.PRIVATE_PAYMENT",
    grantToken: "bonni-session-mfa-v1",
  }), mfaAssurance), null);
  assert.equal(await withIdentity(() => protectedOrganization.getCollectionIdentity({
    purpose: "KONTOR.MANAGER.PRIVATE_DATA",
    grantToken: "bonni-session-mfa-v1",
  }), mfaAssurance), null);
});

test("session sentinel without matching server MFA assurance fails closed", async () => {
  const privacy = {
    protectedDataAccessGrant: {
      async findUnique() { throw new Error("session sentinel must never fall back to a grant lookup"); },
    },
  };
  const runtime = createModuleProtectedOrganizationRuntime(
    "app.kontorapp",
    {},
    privacy,
    { async get() { return { organizationId: "organization-1", tenantId: "tenant-1" }; } },
    {
      async getTwoFactorStatus() {
        return {
          enabled: true,
          available: true,
          privateDataProtectionEnrolled: true,
          credentialRevision: 7,
          provider: { id: "local", configured: true, available: true },
        };
      },
    },
  );
  const request = () => runtime.getCollectionIdentity({
    purpose: "KONTOR.MANAGER.PRIVATE_DATA",
    grantToken: "bonni-session-mfa-v1",
  });

  await assert.rejects(
    withIdentity(request),
    (error) => error?.code === "PROTECTED_ORGANIZATION_SESSION_MFA_INVALID",
  );
  await assert.rejects(
    withIdentity(request, { ...mfaAssurance, mfaProviderId: "other" }),
    (error) => error?.code === "PROTECTED_ORGANIZATION_SESSION_MFA_INVALID",
  );
  await assert.rejects(
    withIdentity(request, { ...mfaAssurance, credentialRevision: 6 }),
    (error) => error?.code === "PROTECTED_ORGANIZATION_SESSION_MFA_INVALID",
  );
});
