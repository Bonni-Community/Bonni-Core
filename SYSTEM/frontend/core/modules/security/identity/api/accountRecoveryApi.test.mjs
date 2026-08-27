import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_RECOVERY_CONTRACT_VERSION,
  completePasswordRecovery,
  createAccountRecoveryDecisionChallenge,
  fetchAccountRecoveryOverview,
  fetchPasswordRecoveryStatus,
  normalizeAccountRecoveryOverview,
  normalizePasswordRecoveryRequest,
  normalizePasswordRecoveryStatus,
  requestPasswordRecovery,
  submitAccountRecoveryDecision,
} from "./accountRecoveryApi.js";

const CONTRACT = ACCOUNT_RECOVERY_CONTRACT_VERSION;
const REFERENCE = "PR-ABCDE-23456";
const EXPIRES_AT = "2035-04-05T12:30:00.000Z";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withFetch(handler, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

function requestDto(overrides = {}) {
  return {
    id: "request_123",
    targetLabel: "Testkonto",
    reference: REFERENCE,
    status: "PENDING",
    approvals: 1,
    threshold: 3,
    expiresAt: EXPIRES_AT,
    canDecide: true,
    targetIsCurrentAccount: false,
    ...overrides,
  };
}

function challengeDto(purpose = "ACCOUNT_RECOVERY_APPROVAL") {
  return {
    id: "challenge_123",
    purpose,
    method: "TOTP",
    provider: "local",
    providerLabel: "Bonni Core",
    proofFields: [{ name: "code", label: "Authenticator-Code", type: "password", autocomplete: "one-time-code" }],
    status: "PENDING",
    expiresAt: EXPIRES_AT,
    maxAttempts: 8,
    accessScope: "core.account-recovery:ACCOUNT_RECOVERY:DECISION:APPROVE:REQUEST:REQUEST_123",
  };
}

test("public v1 DTO requires the neutral reference and the frozen support-code semantics", () => {
  assert.deepEqual(normalizePasswordRecoveryRequest({
    contractVersion: CONTRACT,
    status: "REQUESTED",
    reference: REFERENCE,
  }), {
    contractVersion: CONTRACT,
    status: "REQUESTED",
    reference: REFERENCE,
  });

  assert.deepEqual(normalizePasswordRecoveryStatus({
    contractVersion: CONTRACT,
    status: "NONE",
    reference: null,
    expiresAt: null,
    supportCodeAllowed: true,
  }).supportCodeAllowed, true);

  assert.equal(normalizePasswordRecoveryStatus({
    contractVersion: CONTRACT,
    status: "APPROVED",
    reference: REFERENCE,
    expiresAt: EXPIRES_AT,
    supportCodeAllowed: false,
  }).status, "APPROVED");

  for (const invalid of [
    { contractVersion: CONTRACT, status: "REQUESTED" },
    { contractVersion: CONTRACT, status: "REQUESTED", reference: "PR-invalid" },
    { contractVersion: CONTRACT, status: "REQUESTED", reference: REFERENCE, requestId: "leak" },
  ]) assert.throws(() => normalizePasswordRecoveryRequest(invalid));

  assert.throws(() => normalizePasswordRecoveryStatus({
    contractVersion: CONTRACT,
    status: "NONE",
    reference: null,
    expiresAt: null,
    supportCodeAllowed: false,
  }));
  assert.throws(() => normalizePasswordRecoveryStatus({
    contractVersion: CONTRACT,
    status: "APPROVED",
    reference: REFERENCE,
    expiresAt: EXPIRES_AT,
    supportCodeAllowed: true,
  }));
});

test("public transport sends username only with credentials and never fails over", async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/status")) return jsonResponse({
      contractVersion: CONTRACT,
      status: "NONE",
      reference: null,
      expiresAt: null,
      supportCodeAllowed: true,
    });
    return jsonResponse({ contractVersion: CONTRACT, status: "REQUESTED", reference: REFERENCE }, 202);
  }, async () => {
    await requestPasswordRecovery("a");
    await requestPasswordRecovery("user.name");
    await fetchPasswordRecoveryStatus();
  });

  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/api\/auth\/password-recovery\/requests$/u);
  assert.deepEqual(JSON.parse(calls[0].options.body), { loginName: "a" });
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.cache, "no-store");
  assert.deepEqual(JSON.parse(calls[1].options.body), { loginName: "user.name" });
  assert.match(calls[2].url, /\/api\/auth\/password-recovery\/status$/u);
  assert.equal(calls[2].options.credentials, "include");

  for (const invalid of ["", " user.name", "user name", "a".repeat(81), 123]) {
    assert.throws(() => requestPasswordRecovery(invalid));
  }
});

test("new password is exact 12..512 codepoints and caller copies are cleared", async () => {
  const exact512 = "😀".repeat(512);
  let transmitted;
  const input = { newPassword: exact512, newPasswordConfirmation: exact512 };
  await withFetch(async (_url, options) => {
    transmitted = JSON.parse(options.body);
    return jsonResponse({ contractVersion: CONTRACT, status: "COMPLETED", requiresFreshLogin: true });
  }, async () => completePasswordRecovery(input));
  assert.equal(transmitted.newPassword, exact512);
  assert.equal(transmitted.newPasswordConfirmation, exact512);
  assert.equal(input.newPassword, undefined);
  assert.equal(input.newPasswordConfirmation, undefined);

  for (const invalid of [
    "x".repeat(11),
    "😀".repeat(513),
    "valid-password\r\n",
    "valid-password\0",
    `valid-password\uD800`,
  ]) {
    await assert.rejects(() => completePasswordRecovery({
      newPassword: invalid,
      newPasswordConfirmation: invalid,
    }));
  }
  await assert.rejects(() => completePasswordRecovery({
    newPassword: "valid-password",
    newPasswordConfirmation: 123,
  }));
});

test("protected overview is exact and target accounts can never decide", () => {
  const normalized = normalizeAccountRecoveryOverview({
    contractVersion: CONTRACT,
    canReview: true,
    canInitiate: true,
    policy: { reviewerAccountIds: ["account_1", "account_2", "account_3"], threshold: 3 },
    requests: [requestDto()],
  });
  assert.equal(normalized.policy.reviewerAccountIds.length, 3);
  assert.equal(normalized.requests[0].reference, REFERENCE);

  assert.throws(() => normalizeAccountRecoveryOverview({
    contractVersion: CONTRACT,
    canReview: true,
    canInitiate: true,
    policy: { reviewerAccountIds: ["account_1", "account_2"], threshold: 3 },
    requests: [],
  }));
  assert.throws(() => normalizeAccountRecoveryOverview({
    contractVersion: CONTRACT,
    canReview: true,
    canInitiate: true,
    policy: null,
    requests: [requestDto({ targetIsCurrentAccount: true, canDecide: true })],
  }));
  assert.throws(() => normalizeAccountRecoveryOverview({
    contractVersion: CONTRACT,
    canReview: false,
    canInitiate: false,
    policy: null,
    requests: [requestDto()],
  }));
});

test("protected reference search uses the single strict query contract", async () => {
  const urls = [];
  await withFetch(async (url) => {
    urls.push(String(url));
    return jsonResponse({
      contractVersion: CONTRACT,
      canReview: false,
      canInitiate: false,
      policy: null,
      requests: [],
    });
  }, async () => {
    await fetchAccountRecoveryOverview("token", { reference: REFERENCE });
    await fetchAccountRecoveryOverview("token", { reference: "" });
    await assert.rejects(() => fetchAccountRecoveryOverview("token", { reference: "PR-invalid" }));
  });
  assert.match(urls[0], /\/api\/security\/account-recovery\/overview\?reference=PR-ABCDE-23456$/u);
  assert.match(urls[1], /\/api\/security\/account-recovery\/overview$/u);
  assert.equal(urls.length, 2, "invalid references must fail before transport");
});

test("decision challenge keeps the canonical provider shape and proof is purged on abort", async () => {
  let calls = 0;
  await withFetch(async (_url, options) => {
    calls += 1;
    assert.deepEqual(JSON.parse(options.body), { decision: "APPROVE" });
    return jsonResponse({
      contractVersion: CONTRACT,
      requestId: "request_123",
      decision: "APPROVE",
      challenge: challengeDto(),
    }, 201);
  }, async () => {
    const envelope = await createAccountRecoveryDecisionChallenge(
      "token",
      "request_123",
      "APPROVE",
    );
    assert.equal(envelope.challenge.provider, "local");
    assert.equal(envelope.challenge.providerLabel, "Bonni Core");
    assert.deepEqual(envelope.challenge.proofFields.map((field) => field.name), ["code"]);
  });
  assert.equal(calls, 1);

  const controller = new AbortController();
  const proof = { code: "123456" };
  await withFetch((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  }), async () => {
    const pending = submitAccountRecoveryDecision("token", "request_123", {
      decision: "APPROVE",
      challengeId: "challenge_123",
      proof,
    }, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    assert.equal(proof.code, undefined, "caller proof must be overwritten synchronously on abort");
    await assert.rejects(pending, { name: "AbortError" });
  });
});
