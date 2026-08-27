import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { Window } from "../../../../../../app/kontorapp/frontend/node_modules/happy-dom/lib/index.js";

const componentDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(componentDirectory, "../../../../..");
const browser = new Window({ url: "http://localhost/" });
const previousGlobals = {};
const EXPIRES_AT = "2035-04-05T12:30:00.000Z";
let vite;
let React;
let act;
let createRoot;
let Simulate;
let AccountRecoveryPanel;

function installBrowserGlobals() {
  for (const name of [
    "window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Event", "InputEvent",
  ]) {
    previousGlobals[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === "window" ? browser : browser[name],
    });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

function restoreBrowserGlobals() {
  for (const [name, descriptor] of Object.entries(previousGlobals)) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
}

function button(host, text) {
  return [...host.querySelectorAll("button")].find((entry) => entry.textContent.trim() === text);
}

function change(element, value) {
  Simulate.change(element, { target: { value } });
}

async function flush() {
  await act(async () => new Promise((resolve) => browser.setTimeout(resolve, 0)));
}

function challenge(id, purpose = "ACCOUNT_RECOVERY_APPROVAL") {
  return {
    id,
    purpose,
    provider: "local",
    providerLabel: "Bonni Core",
    proofFields: [{ name: "code", label: "Authenticator-Code", type: "password", autocomplete: "one-time-code" }],
    expiresAt: EXPIRES_AT,
  };
}

function request(overrides = {}) {
  return {
    id: "request_1",
    targetLabel: "Zielkonto",
    reference: "PR-ABCDE-23456",
    status: "PENDING",
    approvals: 1,
    threshold: 3,
    expiresAt: EXPIRES_AT,
    canDecide: true,
    targetIsCurrentAccount: false,
    ...overrides,
  };
}

function overview() {
  return {
    canReview: true,
    canInitiate: true,
    policy: { reviewerAccountIds: ["account_1", "account_2", "account_3"], threshold: 3 },
    requests: [
      request(),
      request({
        id: "request_own",
        targetLabel: "Eigenes Konto",
        reference: "PR-BCDEF-34567",
        canDecide: false,
        targetIsCurrentAccount: true,
      }),
      request({
        id: "request_approved",
        targetLabel: "Freigegebenes Konto",
        reference: "PR-CDEFG-45678",
        status: "APPROVED",
        approvals: 3,
        canDecide: false,
      }),
    ],
  };
}

before(async () => {
  installBrowserGlobals();
  const reactModule = await import("react");
  React = reactModule.default;
  act = reactModule.act;
  ({ createRoot } = await import("react-dom/client"));
  ({ Simulate } = await import("react-dom/test-utils"));
  vite = await createServer({
    configFile: false,
    root: frontendRoot,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
    plugins: [react({ jsxRuntime: "classic" })],
  });
  ({ default: AccountRecoveryPanel } = await vite.ssrLoadModule(
    "/core/modules/security/identity/components/AccountRecoveryPanel.jsx",
  ));
});

after(async () => {
  await vite?.close();
  browser.close();
  restoreBrowserGlobals();
});

test("support can initiate, vote with fresh Core 2FA and issue a purged one-shot code", async () => {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  let initiatedTarget = null;
  let receivedDecision = null;
  let decisionSnapshot = null;
  const overviewReferences = [];
  let resolveDecision;
  const pendingDecision = new Promise((resolve) => { resolveDecision = resolve; });
  const api = {
    async getOverview(_token, options = {}) {
      overviewReferences.push(options.reference || null);
      return overview();
    },
    async initiate(_token, input) {
      initiatedTarget = input.targetAccountId;
      return { request: request({ id: "request_new", reference: "PR-DEFGH-56789" }) };
    },
    async createDecisionChallenge(_token, requestId, decision) {
      assert.equal(requestId, "request_1");
      assert.equal(decision, "APPROVE");
      return { challenge: challenge("challenge_vote") };
    },
    submitDecision(_token, requestId, input) {
      assert.equal(requestId, "request_1");
      receivedDecision = input;
      decisionSnapshot = { decision: input.decision, challengeId: input.challengeId, proof: { ...input.proof } };
      return pendingDecision;
    },
    async createSupportCodeChallenge(_token, requestId) {
      assert.equal(requestId, "request_approved");
      return { challenge: challenge("challenge_support", "ACCOUNT_RECOVERY_SUPPORT_CODE") };
    },
    async issueSupportCode(_token, requestId, input) {
      assert.equal(requestId, "request_approved");
      assert.equal(input.challengeId, "challenge_support");
      assert.deepEqual(input.proof, { code: "654321" });
      return {
        supportCode: "ABCDE-23456-BCDEF-34567",
        supportCodeShownOnce: true,
        expiresAt: EXPIRES_AT,
      };
    },
    async createPolicyChallenge() { throw new Error("unexpected"); },
    async updatePolicy() { throw new Error("unexpected"); },
  };

  await act(async () => root.render(React.createElement(AccountRecoveryPanel, { token: "token", api })));
  await flush();
  assert.match(host.textContent, /1 von 3 bestaetigt/u);
  assert.match(host.textContent, /Zielkonto kann seinen eigenen Antrag nicht/u);

  const referenceInput = host.querySelector('input[placeholder="PR-XXXXX-XXXXX"]');
  await act(async () => change(referenceInput, "pr-abcde-23456"));
  await act(async () => referenceInput.closest("form").dispatchEvent(
    new browser.Event("submit", { bubbles: true, cancelable: true }),
  ));
  await flush();
  assert.equal(overviewReferences.at(-1), "PR-ABCDE-23456");
  await act(async () => button(host, "Alle anzeigen").click());
  await flush();
  assert.equal(overviewReferences.at(-1), null);

  const targetInput = [...host.querySelectorAll("input")].find((entry) => entry.previousElementSibling?.textContent === "Zielkonto-ID");
  await act(async () => change(targetInput, "target_account"));
  await act(async () => targetInput.closest("form").dispatchEvent(
    new browser.Event("submit", { bubbles: true, cancelable: true }),
  ));
  await flush();
  assert.equal(initiatedTarget, "target_account");

  await act(async () => button(host, "Bestaetigen").click());
  await flush();
  let proofInput = host.querySelector(".bonni-2fa-proof input");
  await act(async () => change(proofInput, "123456"));
  await act(async () => {
    host.querySelector(".bonni-2fa-proof").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  assert.deepEqual(decisionSnapshot, {
    decision: "APPROVE",
    challengeId: "challenge_vote",
    proof: { code: "123456" },
  });
  assert.equal(proofInput.value, "", "proof DOM must be empty while the decision is pending");
  await act(async () => resolveDecision({ status: "PENDING", approvals: 2, rejections: 0, threshold: 3 }));
  await flush();
  assert.equal(receivedDecision.proof.code, "", "detached proof is overwritten after submit");

  await act(async () => button(host, "Einmaligen Support-Code ausgeben").click());
  await flush();
  proofInput = host.querySelector(".bonni-2fa-proof input");
  await act(async () => change(proofInput, "654321"));
  await act(async () => host.querySelector(".bonni-2fa-proof").dispatchEvent(
    new browser.Event("submit", { bubbles: true, cancelable: true }),
  ));
  await flush();
  assert.match(host.textContent, /ABCDE-23456-BCDEF-34567/u);
  const codeNode = host.querySelector(".bonni-account-recovery__one-shot code");
  await act(async () => browser.dispatchEvent(new browser.Event("pagehide")));
  assert.equal(codeNode.textContent, "");
  assert.equal(host.querySelector(".bonni-account-recovery__one-shot"), null);

  await act(async () => root.unmount());
  host.remove();
});

test("policy update is 3..6, threshold-bound and reuses the challenged proposal exactly", async () => {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  let challengedProposal = null;
  let updatedSnapshot = null;
  const api = {
    async getOverview() { return overview(); },
    async initiate() { throw new Error("unexpected"); },
    async createDecisionChallenge() { throw new Error("unexpected"); },
    async submitDecision() { throw new Error("unexpected"); },
    async createSupportCodeChallenge() { throw new Error("unexpected"); },
    async issueSupportCode() { throw new Error("unexpected"); },
    async createPolicyChallenge(_token, proposal) {
      challengedProposal = { reviewerAccountIds: [...proposal.reviewerAccountIds], threshold: proposal.threshold };
      return { challenge: challenge("challenge_policy", "ACCOUNT_RECOVERY_POLICY") };
    },
    async updatePolicy(_token, input) {
      updatedSnapshot = {
        reviewerAccountIds: [...input.reviewerAccountIds],
        threshold: input.threshold,
        challengeId: input.challengeId,
        proof: { ...input.proof },
      };
      return { reviewerAccountIds: input.reviewerAccountIds, threshold: input.threshold, policyRevision: 2 };
    },
  };
  await act(async () => root.render(React.createElement(AccountRecoveryPanel, {
    token: "token",
    api,
    canManagePolicy: true,
  })));
  await flush();
  await act(async () => button(host, "Mit Core-2FA pruefen").click());
  await flush();
  assert.deepEqual(challengedProposal, {
    reviewerAccountIds: ["account_1", "account_2", "account_3"],
    threshold: 3,
  });
  const textarea = host.querySelector("textarea");
  assert.equal(textarea.disabled, true, "proposal cannot change after its bound challenge exists");
  const proofInput = host.querySelector(".bonni-2fa-proof input");
  await act(async () => change(proofInput, "123456"));
  await act(async () => host.querySelector(".bonni-2fa-proof").dispatchEvent(
    new browser.Event("submit", { bubbles: true, cancelable: true }),
  ));
  await flush();
  assert.deepEqual(updatedSnapshot, {
    reviewerAccountIds: challengedProposal.reviewerAccountIds,
    threshold: challengedProposal.threshold,
    challengeId: "challenge_policy",
    proof: { code: "123456" },
  });
  assert.match(host.textContent, /Wiederherstellungsrichtlinie wurde gespeichert/u);

  await act(async () => root.unmount());
  host.remove();
});

test("missing clipboard never reports success and still purges the one-shot code synchronously", async () => {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(browser.navigator, "clipboard");
  Object.defineProperty(browser.navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  const api = {
    async getOverview() {
      return {
        canReview: true,
        canInitiate: false,
        policy: null,
        requests: [request({
          id: "request_approved",
          status: "APPROVED",
          approvals: 3,
          canDecide: false,
        })],
      };
    },
    async createSupportCodeChallenge() {
      return { challenge: challenge("challenge_support", "ACCOUNT_RECOVERY_SUPPORT_CODE") };
    },
    async issueSupportCode() {
      return { supportCode: "ABCDE-23456-BCDEF-34567", supportCodeShownOnce: true, expiresAt: EXPIRES_AT };
    },
  };

  try {
    await act(async () => root.render(React.createElement(AccountRecoveryPanel, { token: "token", api })));
    await flush();
    await act(async () => button(host, "Einmaligen Support-Code ausgeben").click());
    await flush();
    const proofInput = host.querySelector(".bonni-2fa-proof input");
    await act(async () => change(proofInput, "123456"));
    await act(async () => host.querySelector(".bonni-2fa-proof").dispatchEvent(
      new browser.Event("submit", { bubbles: true, cancelable: true }),
    ));
    await flush();
    const codeNode = host.querySelector(".bonni-account-recovery__one-shot code");
    assert.match(codeNode.textContent, /ABCDE-23456-BCDEF-34567/u);
    await act(async () => button(host, "Kopieren und ausblenden").click());
    assert.equal(codeNode.textContent, "");
    assert.equal(host.querySelector(".bonni-account-recovery__one-shot"), null);
    await flush();
    assert.match(host.textContent, /Zwischenablage war nicht verfuegbar/u);
    assert.doesNotMatch(host.textContent, /wurde kopiert/u);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    if (clipboardDescriptor) Object.defineProperty(browser.navigator, "clipboard", clipboardDescriptor);
    else delete browser.navigator.clipboard;
  }
});
