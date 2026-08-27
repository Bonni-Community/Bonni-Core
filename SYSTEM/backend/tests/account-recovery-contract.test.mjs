import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.JWT_SECRET ||= "account-recovery-test-secret-2026-with-more-than-32-bytes";

const schemas = await import(process.env.BONNI_TEST_SOURCE === "1"
  ? "../src/core/modules/security/account-recovery/schemas.ts"
  : "../dist/core/modules/security/account-recovery/schemas.js");
const service = await import(process.env.BONNI_TEST_SOURCE === "1"
  ? "../src/core/modules/security/account-recovery/service.ts"
  : "../dist/core/modules/security/account-recovery/service.js");

test("public DTOs are strict and recovery passwords are exact 12..512 code points", () => {
  assert.equal(schemas.publicRecoveryRequestSchema.safeParse({ body: { loginName: "member.one" } }).success, true);
  assert.equal(schemas.publicRecoveryRequestSchema.safeParse({ body: { loginName: "a" } }).success, true);
  assert.equal(schemas.publicRecoveryRequestSchema.safeParse({ body: { loginName: `a${"b".repeat(79)}` } }).success, true);
  assert.equal(schemas.publicRecoveryRequestSchema.safeParse({ body: { loginName: `a${"b".repeat(80)}` } }).success, false);
  assert.equal(schemas.publicRecoveryRequestSchema.safeParse({ body: { loginName: "member.one", email: "leak@example.invalid" } }).success, false);

  const twelveEmoji = "🔐".repeat(12);
  const maxEmoji = "🔐".repeat(512);
  for (const password of [twelveEmoji, maxEmoji, " exact password "]) {
    assert.equal(schemas.publicRecoveryCompleteSchema.safeParse({
      body: { newPassword: password, newPasswordConfirmation: password },
    }).success, true);
  }
  for (const password of ["x".repeat(11), "🔐".repeat(513), "line\nbreak", "nul\0byte", "lone\ud800surrogate"]) {
    assert.equal(schemas.publicRecoveryCompleteSchema.safeParse({
      body: { newPassword: password, newPasswordConfirmation: password },
    }).success, false);
  }
  assert.equal(schemas.publicRecoveryCompleteSchema.safeParse({
    body: { newPassword: "exact-password-a", newPasswordConfirmation: "exact-password-b" },
  }).success, false);
});

test("review decisions and policy proposals require closed, bound DTOs", () => {
  assert.equal(schemas.recoveryDecisionSchema.safeParse({
    params: { id: "request_1" },
    body: { decision: "APPROVE", challengeId: "challenge_1", proof: { code: "123456" } },
  }).success, true);
  assert.equal(schemas.recoveryDecisionSchema.safeParse({
    params: { id: "request_1" },
    body: { decision: "APPROVE", challengeId: "challenge_1", proof: { code: "123456", unexpected: true } },
  }).success, false);
  assert.equal(schemas.policyChallengeSchema.safeParse({
    body: { reviewerAccountIds: ["a_1", "a_2", "a_3"], threshold: 3 },
  }).success, true);
  assert.equal(schemas.policyChallengeSchema.safeParse({
    body: { reviewerAccountIds: ["a_1", "a_2"], threshold: 3 },
  }).success, false);
  assert.equal(schemas.updateRecoveryPolicySchema.safeParse({
    body: {
      reviewerAccountIds: ["a_1", "a_2", "a_3"],
      threshold: 3,
      challengeId: "challenge_1",
      proof: { recoveryCode: "ABCD-EFGH-JKLM-NPQR" },
    },
  }).success, true);
});

test("browser capability is signed, opaque, persistent for 48 hours and tamper evident", () => {
  const now = new Date("2026-08-20T10:00:00.000Z");
  const capability = service.createBrowserCapability(undefined, now);
  assert.match(capability.reference, /^PR-[A-Z2-9]{5}-[A-Z2-9]{5}$/u);
  assert.match(capability.token, /^PR-[A-Z2-9]{5}-[A-Z2-9]{5}\.\d{10}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u);
  assert.equal(capability.expiresAt.getTime() - capability.issuedAt.getTime(), 48 * 60 * 60 * 1000);
  assert.equal(service.parseBrowserCapability(capability.token, new Date(now.getTime() + 47 * 60 * 60 * 1000))?.reference, capability.reference);
  const replacement = capability.token.endsWith("A") ? "B" : "A";
  assert.equal(service.parseBrowserCapability(`${capability.token.slice(0, -1)}${replacement}`, now), null);
  assert.equal(service.parseBrowserCapability(capability.token, new Date(now.getTime() + 49 * 60 * 60 * 1000))?.expiresAt.getTime(), capability.expiresAt.getTime());
  assert.match(service.generateSupportCode(), /^[A-Z2-9]{5}(?:-[A-Z2-9]{5}){3}$/u);
});

test("enumeration-neutral public response has a shared minimum with bounded jitter", () => {
  assert.equal(service.enumerationNeutralDelayMs(0, 0), 420);
  assert.equal(service.enumerationNeutralDelayMs(0, 80), 500);
  assert.equal(service.enumerationNeutralDelayMs(500, 80), 0);
  assert.equal(service.enumerationNeutralDelayMs(5, 81), 415);
});

test("decision reduction locks on first approval and needs quorum for either terminal result", () => {
  const firstApprove = service.deriveRecoveryDecisionOutcome({
    currentStatus: "PENDING", approvals: 0, rejections: 0, threshold: 3, decision: "APPROVE",
  });
  assert.equal(firstApprove.shouldAcquireLock, true);
  assert.equal(firstApprove.nextStatus, "PENDING");

  const oneReject = service.deriveRecoveryDecisionOutcome({
    currentStatus: "LOCKED", approvals: 1, rejections: 0, threshold: 3, decision: "REJECT",
  });
  assert.equal(oneReject.nextStatus, "LOCKED");
  const rejectQuorum = service.deriveRecoveryDecisionOutcome({
    currentStatus: "LOCKED", approvals: 1, rejections: 2, threshold: 3, decision: "REJECT",
  });
  assert.equal(rejectQuorum.nextStatus, "CANCELLED");
  const approveQuorum = service.deriveRecoveryDecisionOutcome({
    currentStatus: "LOCKED", approvals: 2, rejections: 1, threshold: 3, decision: "APPROVE",
  });
  assert.equal(approveQuorum.nextStatus, "APPROVED");
});

test("reviewer snapshots exclude target, ambiguous local TOTP and unavailable external providers", () => {
  const candidates = [
    { id: "target", type: "ADMIN", credentialRevision: 1, twoFactorProviderId: "local", twoFactorEnrolledAt: new Date() },
    { id: "local-ok", type: "ADMIN", credentialRevision: 4, twoFactorProviderId: "local", twoFactorEnrolledAt: new Date() },
    { id: "local-corrupt", type: "ADMIN", credentialRevision: 6, twoFactorProviderId: "local", twoFactorEnrolledAt: new Date() },
    { id: "local-ambiguous", type: "ADMIN", credentialRevision: 2, twoFactorProviderId: "local", twoFactorEnrolledAt: new Date() },
    { id: "external-down", type: "ADMIN", credentialRevision: 3, twoFactorProviderId: "privacyidea", twoFactorEnrolledAt: new Date() },
    { id: "trustee", type: "MEMBER", credentialRevision: 5, twoFactorProviderId: "external-ok", twoFactorEnrolledAt: new Date() },
  ];
  const localCredentials = [
    { accountId: "target", credentialRevision: 1, enrollmentSlot: "target", secretEncrypted: "cipher-target" },
    { accountId: "local-ok", credentialRevision: 4, enrollmentSlot: "local-ok", secretEncrypted: "cipher-local" },
    { accountId: "local-corrupt", credentialRevision: 6, enrollmentSlot: "local-corrupt", secretEncrypted: null },
    { accountId: "local-ambiguous", credentialRevision: 2, enrollmentSlot: "local-ambiguous", secretEncrypted: "cipher-a" },
    { accountId: "local-ambiguous", credentialRevision: 1, enrollmentSlot: null, secretEncrypted: "cipher-b" },
  ];
  assert.deepEqual([...service.deriveReviewerSnapshot({
    candidates,
    localCredentials,
    availableExternalProviderIds: ["external-ok"],
    configuredReviewerAccountIds: ["trustee"],
    targetAccountId: "target",
  })], ["local-ok", "trustee"]);
});

test("canonical routes, cookie flags and no-alias mount stay frozen", async () => {
  const [routes, authMount, coreMount] = await Promise.all([
    readFile(path.join(backendRoot, "src/core/modules/security/account-recovery/routes.ts"), "utf8"),
    readFile(path.join(backendRoot, "src/platform/auth/registerCoreAuth.ts"), "utf8"),
    readFile(path.join(backendRoot, "src/system/routes/registerCoreRoutes.ts"), "utf8"),
  ]);
  assert.match(authMount, /app\.use\("\/api\/auth\/password-recovery", passwordRecoveryPublicRouter\)/u);
  assert.doesNotMatch(authMount, /identity\/auth\/password-recovery/u);
  assert.match(coreMount, /app\.use\("\/api\/security\/account-recovery", accountRecoveryRouter\)/u);
  assert.match(routes, /HttpOnly/u);
  assert.match(routes, /SameSite=Strict/u);
  assert.match(routes, /Path=\/api\/auth\/password-recovery/u);
  assert.match(routes, /ACCOUNT_RECOVERY_COOKIE_SECONDS/u);
  assert.match(routes, /fetchSite === "same-origin" \|\| fetchSite === "none"/u);
  assert.match(routes, /values\.length !== 1/u);
});

test("Prisma lifecycle owns lock, one active slot, hashed capabilities and distinct reviewers", async () => {
  const [accountSchema, recoverySchema] = await Promise.all([
    readFile(path.join(backendRoot, "prisma/domains/system/identity/account.prisma"), "utf8"),
    readFile(path.join(backendRoot, "prisma/domains/system/identity/account-recovery.prisma"), "utf8"),
  ]);
  assert.match(accountSchema, /passwordRecoveryLockedAt DateTime\?/u);
  assert.match(accountSchema, /passwordRecoveryRequestId String\?/u);
  assert.match(recoverySchema, /activeSlot\s+String\?\s+@unique/u);
  assert.match(recoverySchema, /browserTokenHash\s+String\?\s+@unique/u);
  assert.match(recoverySchema, /supportCodeHash\s+String\?\s+@unique/u);
  assert.match(recoverySchema, /policyRevisionSnapshot\s+Int/u);
  assert.match(recoverySchema, /reviewerAccountIdsSnapshot\s+Json/u);
  assert.match(recoverySchema, /@@unique\(\[requestId, approverAccountId\]\)/u);
});

test("lock acquisition and completion are revision-CAS transitions preserving Core TOTP", async () => {
  const source = await readFile(
    path.join(backendRoot, "src/core/modules/security/account-recovery/service.ts"),
    "utf8",
  );
  assert.match(source, /passwordRecoveryLockedAt: now/u);
  assert.match(source, /passwordRecoveryRequestId: request\.id/u);
  assert.ok((source.match(/advanceTwoFactorAfterPasswordChange\(tx/gu) || []).length >= 2);
  assert.match(source, /session\.updateMany/u);
  assert.match(source, /refreshToken\.updateMany/u);
  assert.match(source, /browserTokenHash: null/u);
  assert.match(source, /status: "CONSUMED"/u);
  assert.match(source, /isolationLevel: "Serializable"/u);
  assert.match(source, /ACCOUNT_RECOVERY_APPROVAL/u);
  assert.match(source, /policyRevisionSnapshot/u);
  assert.ok((source.match(/preserveAccountRecoveryRequestId:/gu) || []).length >= 2);
});

test("every password and Core 2FA revision change atomically frees stale recovery slots", async () => {
  const [passwordChange, twoFactor, transition] = await Promise.all([
    readFile(path.join(backendRoot, "src/core/modules/security/two-factor/password-change.ts"), "utf8"),
    readFile(path.join(backendRoot, "src/core/modules/security/two-factor/service.ts"), "utf8"),
    readFile(path.join(backendRoot, "src/core/modules/security/account-recovery/credential-transition.ts"), "utf8"),
  ]);
  assert.match(passwordChange, /cancelPendingRecoveryAfterCredentialChange/u);
  assert.ok((twoFactor.match(/cancelPendingRecoveryAfterCredentialChange\(tx/gu) || []).length >= 3);
  assert.match(transition, /status: "CANCELLED"/u);
  assert.match(transition, /activeSlot: null/u);
  assert.match(transition, /browserTokenHash: null/u);
  assert.match(transition, /ACCOUNT_RECOVERY_CANCELLED_CREDENTIAL_CHANGED/u);
});

test("all interactive auth middleware fail closed for the separate recovery lock", async () => {
  for (const relative of [
    "src/platform/auth/routes/auth.routes.ts",
    "src/core/http/middleware/requireAuth.ts",
    "src/platform/auth/middleware/current-user.middleware.ts",
    "src/platform/security/identity/middleware/requireAuth.ts",
    "src/platform/security/identity/services/auth.service.ts",
  ]) {
    const source = await readFile(path.join(backendRoot, relative), "utf8");
    assert.match(source, /passwordRecoveryLockedAt/u, `${relative} does not enforce recovery lock`);
  }
});

test("Core Members publishes a provider-neutral settlement-only signal", async () => {
  const source = await readFile(
    path.join(backendRoot, "src/platform/auth/members/module-members-runtime.ts"),
    "utf8",
  );
  assert.match(source, /passwordRecovery:\s*Object\.freeze/u);
  assert.match(source, /PASSWORD_RECOVERY_LOCKED/u);
  assert.match(source, /settlementOnly/u);
});

test("security capability writes and transactions can never enter JSON emergency replay", async () => {
  const source = await readFile(path.join(backendRoot, "src/core/database/prisma.ts"), "utf8");
  assert.match(source, /modelProperty\.startsWith\("securityTwoFactor"\)/u);
  assert.match(source, /modelProperty\.startsWith\("securityAccountRecovery"\)/u);
  assert.match(source, /modelProperty === "\$client" && operation === "\$transaction"/u);
  const guard = source.indexOf('modelProperty.startsWith("securityAccountRecovery")');
  const enqueue = source.indexOf("enqueueJsonEmergencyWrite", guard);
  assert.ok(guard > 0 && enqueue > guard, "fail-closed guard must run before queueing");
});
