import assert from "node:assert/strict";
import test from "node:test";

const { advanceTwoFactorAfterPasswordChange } = await import(
  process.env.BONNI_TEST_SOURCE === "1"
    ? "../src/core/modules/security/two-factor/password-change.ts"
    : "../dist/core/modules/security/two-factor/password-change.js"
);

function transaction(activeCredentials, pendingRecoveries = []) {
  const writes = {
    credential: [],
    recovery: [],
    enrollment: [],
    challenge: [],
    recoveryRequest: [],
    recoveryAudit: [],
  };
  return {
    writes,
    securityTwoFactorCredential: {
      async findMany() { return activeCredentials; },
      async updateMany(input) {
        writes.credential.push(input);
        return { count: input.where?.id ? 1 : 0 };
      },
    },
    securityTwoFactorRecoveryCode: {
      async updateMany(input) {
        writes.recovery.push(input);
        return { count: 1 };
      },
    },
    securityTwoFactorEnrollment: {
      async updateMany(input) {
        writes.enrollment.push(input);
        return { count: 1 };
      },
    },
    securityTwoFactorChallenge: {
      async updateMany(input) {
        writes.challenge.push(input);
        return { count: 1 };
      },
    },
    securityAccountRecoveryRequest: {
      async findMany() { return pendingRecoveries; },
      async updateMany(input) {
        writes.recoveryRequest.push(input);
        return { count: 1 };
      },
    },
    securityAccountRecoveryAuditLog: {
      async create(input) {
        writes.recoveryAudit.push(input);
        return input;
      },
    },
  };
}

test("a password change advances active TOTP and recovery material atomically", async () => {
  const tx = transaction(
    [{
      id: "credential-1",
      credentialRevision: 7,
      enrollmentSlot: "account-1",
    }],
    [{ id: "recovery-1", requestRevision: 3 }],
  );
  await advanceTwoFactorAfterPasswordChange(tx, {
    accountId: "account-1",
    previousRevision: 7,
    nextRevision: 8,
    twoFactorProviderId: "local",
  });

  assert.deepEqual(tx.writes.credential[0].data, {
    credentialRevision: 8,
    enrollmentSlot: "account-1",
  });
  assert.deepEqual(tx.writes.recovery[0].data, { credentialRevision: 8 });
  assert.deepEqual(tx.writes.enrollment[0].data, {
    status: "REVOKED",
    enrollmentPasswordHash: null,
    revokedAt: tx.writes.enrollment[0].data.revokedAt,
  });
  assert.equal(tx.writes.enrollment[0].data.revokedAt instanceof Date, true);
  const pendingCredential = tx.writes.credential.at(-1).data;
  assert.equal(pendingCredential.status, "REVOKED");
  assert.equal(pendingCredential.secretEncrypted, null);
  assert.equal(pendingCredential.enrollmentSlot, null);
  assert.deepEqual(tx.writes.challenge[0].data, { status: "CANCELLED" });
  assert.equal(tx.writes.recoveryRequest.length, 1);
  assert.deepEqual(tx.writes.recoveryRequest[0].data, {
    status: "CANCELLED",
    activeSlot: null,
    browserTokenHash: null,
    browserTokenExpiresAt: null,
    supportCodeHash: null,
    supportCodeExpiresAt: null,
    cancelledAt: tx.writes.recoveryRequest[0].data.cancelledAt,
    requestRevision: { increment: 1 },
  });
  assert.equal(tx.writes.recoveryAudit[0].data.event, "ACCOUNT_RECOVERY_CANCELLED_CREDENTIAL_CHANGED");
});

test("the exact recovery request driving a revision transition is preserved", async () => {
  const tx = transaction(
    [{ id: "credential-1", credentialRevision: 7, enrollmentSlot: "account-1" }],
    [{ id: "recovery-owned", requestRevision: 2 }],
  );
  await advanceTwoFactorAfterPasswordChange(tx, {
    accountId: "account-1",
    previousRevision: 7,
    nextRevision: 8,
    twoFactorProviderId: "local",
    preserveAccountRecoveryRequestId: "recovery-owned",
  });
  assert.equal(tx.writes.recoveryRequest.length, 0);
  assert.equal(tx.writes.recoveryAudit.length, 0);
});

test("ambiguous active credentials abort the password rotation", async () => {
  const tx = transaction([
    { id: "credential-1", credentialRevision: 7, enrollmentSlot: "account-1" },
    { id: "credential-2", credentialRevision: 7, enrollmentSlot: null },
  ]);
  await assert.rejects(
    advanceTwoFactorAfterPasswordChange(tx, {
      accountId: "account-1",
      previousRevision: 7,
      nextRevision: 8,
      twoFactorProviderId: "local",
    }),
    (error) => error?.code === "TWO_FACTOR_CREDENTIAL_STATE_AMBIGUOUS"
      && error?.statusCode === 409,
  );
});
