import assert from "node:assert/strict";
import test from "node:test";

const { transitionAccountSecurity } = await import(
  process.env.BONNI_TEST_SOURCE === "1"
    ? "../src/core/modules/security/two-factor/account-security-transition.ts"
    : "../dist/core/modules/security/two-factor/account-security-transition.js"
);

function matchesScalar(value, expected) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (Array.isArray(expected.in)) return expected.in.includes(value);
    if (Object.hasOwn(expected, "not")) return value !== expected.not;
  }
  return value === expected;
}

function matches(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "accountId" || key === "id" || key === "method" || key === "status"
      || key === "credentialRevision" || key === "enrollmentSlot" || key === "usedAt"
      || key === "endedAt" || key === "revokedAt" || key === "enrollmentPasswordHash"
      || key === "lockedAt" || key === "requestRevision") {
      return matchesScalar(row[key], expected);
    }
    return true;
  });
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

function mutableTransaction(initial) {
  const state = structuredClone(initial);
  const updateMany = (collection) => async ({ where, data }) => {
    const selected = collection.filter((row) => matches(row, where));
    selected.forEach((row) => applyData(row, data));
    return { count: selected.length };
  };
  const transaction = {
    state,
    account: {
      async updateMany({ where, data }) {
        if (
          state.account.id !== where.id
          || state.account.credentialRevision !== where.credentialRevision
          || state.account.type !== where.type
          || state.account.isActive !== where.isActive
        ) return { count: 0 };
        applyData(state.account, data);
        return { count: 1 };
      },
    },
    securityTwoFactorCredential: {
      async findMany({ where, take }) {
        return state.credentials.filter((row) => matches(row, where)).slice(0, take);
      },
      updateMany: updateMany(state.credentials),
    },
    securityTwoFactorRecoveryCode: {
      updateMany: updateMany(state.recoveryCodes),
      async deleteMany({ where }) {
        const before = state.recoveryCodes.length;
        state.recoveryCodes = state.recoveryCodes.filter((row) => !matches(row, where));
        return { count: before - state.recoveryCodes.length };
      },
    },
    securityTwoFactorEnrollment: {
      async updateMany({ where, data }) {
        if (!state.enrollment || !matches(state.enrollment, where)) return { count: 0 };
        applyData(state.enrollment, data);
        return { count: 1 };
      },
    },
    securityTwoFactorChallenge: { updateMany: updateMany(state.challenges) },
    securityAccountRecoveryRequest: {
      async findMany({ where }) {
        return state.recoveryRequests.filter((row) => matches(row, where));
      },
      updateMany: updateMany(state.recoveryRequests),
    },
    securityAccountRecoveryAuditLog: {
      async create(input) {
        state.recoveryAudits.push(input.data);
        return input.data;
      },
    },
    securityTwoFactorLockout: {
      async deleteMany({ where }) {
        const before = state.lockouts.length;
        state.lockouts = state.lockouts.filter((row) => !matches(row, where));
        return { count: before - state.lockouts.length };
      },
    },
    session: { updateMany: updateMany(state.sessions) },
    refreshToken: { updateMany: updateMany(state.refreshTokens) },
  };
  return transaction;
}

function personalState() {
  return {
    account: {
      id: "account-1",
      type: "MEMBER",
      isActive: true,
      passwordHash: "bonni-pw-v1$hash",
      credentialRevision: 4,
      twoFactorProviderId: "local",
      twoFactorEnrolledAt: "2026-01-01T00:00:00.000Z",
      privateDataTwoFactorEnrolledAt: "2026-01-01T00:00:00.000Z",
    },
    credentials: [{
      id: "credential-1",
      accountId: "account-1",
      method: "TOTP",
      status: "ACTIVE",
      credentialRevision: 4,
      enrollmentSlot: "account-1",
      secretEncrypted: "ciphertext",
      secretFingerprint: "fingerprint",
      externalCredentialId: null,
    }],
    recoveryCodes: [{ id: "recovery-1", accountId: "account-1", usedAt: null, credentialRevision: 4 }],
    enrollment: {
      id: "enrollment-1",
      accountId: "account-1",
      status: "PENDING",
      enrollmentPasswordHash: "verifier",
    },
    challenges: [{ id: "challenge-1", accountId: "account-1", status: "VERIFIED" }],
    sessions: [{ id: "session-revision-4", accountId: "account-1", endedAt: null, credentialRevision: 4 }],
    refreshTokens: [{ id: "refresh-revision-4", accountId: "account-1", revokedAt: null, credentialRevision: 4 }],
    lockouts: [],
    recoveryRequests: [],
    recoveryAudits: [],
  };
}

test("deactivate then reactivate advances TOTP but revokes both generations of JWT/refresh state", async () => {
  const tx = mutableTransaction(personalState());
  await transitionAccountSecurity(tx, {
    accountId: "account-1",
    previousRevision: 4,
    previousType: "MEMBER",
    previousIsActive: true,
    nextType: "MEMBER",
    nextIsActive: false,
    twoFactorProviderId: "local",
  });

  assert.equal(tx.state.account.isActive, false);
  assert.equal(tx.state.account.credentialRevision, 5);
  assert.equal(tx.state.credentials[0].status, "ACTIVE");
  assert.equal(tx.state.credentials[0].credentialRevision, 5);
  assert.equal(tx.state.recoveryCodes[0].credentialRevision, 5);
  assert.ok(tx.state.sessions[0].endedAt instanceof Date);
  assert.ok(tx.state.refreshTokens[0].revokedAt instanceof Date);
  assert.equal(tx.state.challenges[0].status, "CANCELLED");
  assert.equal(tx.state.enrollment.enrollmentPasswordHash, null);

  tx.state.sessions.push({ id: "session-revision-5", accountId: "account-1", endedAt: null, credentialRevision: 5 });
  tx.state.refreshTokens.push({ id: "refresh-revision-5", accountId: "account-1", revokedAt: null, credentialRevision: 5 });
  tx.state.challenges.push({ id: "challenge-revision-5", accountId: "account-1", status: "PENDING" });
  await transitionAccountSecurity(tx, {
    accountId: "account-1",
    previousRevision: 5,
    previousType: "MEMBER",
    previousIsActive: false,
    nextType: "MEMBER",
    nextIsActive: true,
    twoFactorProviderId: "local",
  });

  assert.equal(tx.state.account.isActive, true);
  assert.equal(tx.state.account.credentialRevision, 6);
  assert.equal(tx.state.credentials[0].credentialRevision, 6);
  assert.equal(tx.state.recoveryCodes[0].credentialRevision, 6);
  assert.ok(tx.state.sessions.every((row) => row.endedAt instanceof Date));
  assert.ok(tx.state.refreshTokens.every((row) => row.revokedAt instanceof Date));
  assert.ok(tx.state.challenges.every((row) => row.status === "CANCELLED"));
  assert.notEqual(4, tx.state.account.credentialRevision, "the original JWT revision stays invalid");
  assert.notEqual(5, tx.state.account.credentialRevision, "the deactivated-generation JWT stays invalid");
});

test("personal deactivate/reactivate cancels the request but retains the sticky recovery lock", async () => {
  const initial = personalState();
  initial.account.passwordRecoveryLockedAt = new Date("2026-08-20T10:00:00.000Z");
  initial.account.passwordRecoveryRequestId = "recovery-1";
  initial.recoveryRequests.push({
    id: "recovery-1",
    accountId: "account-1",
    status: "LOCKED",
    activeSlot: "account-1",
    browserTokenHash: "browser-hash",
    browserTokenExpiresAt: new Date("2026-08-22T10:00:00.000Z"),
    supportCodeHash: null,
    supportCodeExpiresAt: null,
    requestRevision: 1,
  });
  const tx = mutableTransaction(initial);
  await transitionAccountSecurity(tx, {
    accountId: "account-1",
    previousRevision: 4,
    previousType: "MEMBER",
    previousIsActive: true,
    nextType: "MEMBER",
    nextIsActive: false,
    twoFactorProviderId: "local",
  });
  assert.ok(tx.state.account.passwordRecoveryLockedAt instanceof Date);
  assert.equal(tx.state.account.passwordRecoveryRequestId, null);
  assert.equal(tx.state.recoveryRequests[0].status, "CANCELLED");
  assert.equal(tx.state.recoveryRequests[0].activeSlot, null);
  assert.equal(tx.state.recoveryRequests[0].browserTokenHash, null);

  await transitionAccountSecurity(tx, {
    accountId: "account-1",
    previousRevision: 5,
    previousType: "MEMBER",
    previousIsActive: false,
    nextType: "MEMBER",
    nextIsActive: true,
    twoFactorProviderId: "local",
  });
  assert.ok(tx.state.account.passwordRecoveryLockedAt instanceof Date);
  assert.equal(tx.state.account.passwordRecoveryRequestId, null);
});

test("deactivation remains available when inherited TOTP state is ambiguous", async () => {
  const initial = personalState();
  initial.credentials.push({
    ...initial.credentials[0],
    id: "credential-ambiguous",
    enrollmentSlot: null,
  });
  initial.lockouts.push({ id: "lockout-1", accountId: "account-1" });
  const tx = mutableTransaction(initial);

  await transitionAccountSecurity(tx, {
    accountId: "account-1",
    previousRevision: 4,
    previousType: "MEMBER",
    previousIsActive: true,
    nextType: "MEMBER",
    nextIsActive: false,
    twoFactorProviderId: "local",
  });

  assert.equal(tx.state.account.isActive, false);
  assert.equal(tx.state.account.credentialRevision, 5);
  assert.equal(tx.state.account.twoFactorProviderId, null);
  assert.equal(tx.state.account.twoFactorEnrolledAt, null);
  assert.equal(
    tx.state.account.privateDataTwoFactorEnrolledAt,
    "2026-01-01T00:00:00.000Z",
    "protected data stays fail-closed after an emergency revoke",
  );
  assert.ok(tx.state.credentials.every((row) => (
    row.status === "REVOKED"
    && row.secretEncrypted === null
    && row.secretFingerprint === null
    && row.enrollmentSlot === null
  )));
  assert.deepEqual(tx.state.recoveryCodes, []);
  assert.equal(tx.state.lockouts.length, 1, "deactivation must not reset an interactive lockout");
});

test("conversion to a technical account shreds password, provider binding, TOTP, recovery and enrollment verifier", async () => {
  const initial = personalState();
  initial.account.twoFactorProviderId = "privacyidea";
  initial.credentials[0].externalCredentialId = "adapter-token-id";
  initial.enrollment.status = "CLAIMED";
  initial.lockouts.push({ id: "lockout-1", accountId: "account-1" });
  const tx = mutableTransaction(initial);

  await transitionAccountSecurity(tx, {
    accountId: "account-1",
    previousRevision: 4,
    previousType: "MEMBER",
    previousIsActive: true,
    nextType: "TERMINAL",
    nextIsActive: true,
    twoFactorProviderId: "privacyidea",
  });

  assert.equal(tx.state.account.type, "TERMINAL");
  assert.equal(tx.state.account.credentialRevision, 5);
  assert.equal(tx.state.account.passwordHash, null);
  assert.equal(tx.state.account.twoFactorProviderId, null);
  assert.equal(tx.state.account.twoFactorEnrolledAt, null);
  assert.equal(tx.state.account.privateDataTwoFactorEnrolledAt, null);
  assert.deepEqual(tx.state.credentials.map((row) => ({
    status: row.status,
    secretEncrypted: row.secretEncrypted,
    secretFingerprint: row.secretFingerprint,
    enrollmentSlot: row.enrollmentSlot,
    externalCredentialId: row.externalCredentialId,
  })), [{
    status: "REVOKED",
    secretEncrypted: null,
    secretFingerprint: null,
    enrollmentSlot: null,
    externalCredentialId: null,
  }]);
  assert.deepEqual(tx.state.recoveryCodes, []);
  assert.equal(tx.state.enrollment.status, "REVOKED");
  assert.equal(tx.state.enrollment.enrollmentPasswordHash, null);
  assert.equal(tx.state.challenges[0].status, "CANCELLED");
  assert.deepEqual(tx.state.lockouts, []);
  assert.ok(tx.state.sessions[0].endedAt instanceof Date);
  assert.ok(tx.state.refreshTokens[0].revokedAt instanceof Date);
});
