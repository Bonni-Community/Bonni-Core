import assert from "node:assert/strict";
import test from "node:test";

import {
  CORE_NETWORK_REQUEST_MAX_PAYLOAD_BYTES,
  CORE_NETWORK_REQUEST_MAX_RESPONSE_BYTES,
  createModuleNetworkRequestRuntime,
  createStagedModuleNetworkRequestRuntime,
} from "../dist/core/network-requests/network-request-registry.js";

const LOCAL_ORGANIZATION_ID = "org_local";
const LOCAL_BONNI_SERIAL = "BONNI-LOCAL-001";
const SOURCE_BONNI_SERIAL = "BONNI-SOURCE-001";

function transportProvider(request = async () => ({ ok: true }), overrides = {}) {
  return {
    localIdentity: {
      organizationId: LOCAL_ORGANIZATION_ID,
      bonniSerial: LOCAL_BONNI_SERIAL,
    },
    request,
    ...overrides,
  };
}

function requestInput(overrides = {}) {
  return {
    protocol: "test.feature.v1",
    recipientOrganizationId: "organization-target",
    recipientBonniSerial: "BONNI-TARGET-001",
    linkId: "link-target-001",
    requestId: "request-00000001",
    idempotencyKey: "idempotency-00000001",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    actor: {
      accountId: "account-1",
      loginName: "member",
      memberId: "member-1",
      displayName: "Member One",
    },
    payload: { nested: { value: "original" } },
    ...overrides,
  };
}

function inboundEnvelope(overrides = {}) {
  return {
    protocol: "test.inbound.v1",
    sourceModule: "app.inbound-test",
    recipientOrganizationId: LOCAL_ORGANIZATION_ID,
    recipientBonniSerial: LOCAL_BONNI_SERIAL,
    linkId: "link-source-001",
    requestId: "request-inbound-0001",
    idempotencyKey: "idempotency-inbound-0001",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    actor: { accountId: "remote-account", loginName: "remote-member" },
    payload: { command: "accept", nested: { value: 1 } },
    ...overrides,
  };
}

function verifiedPeer(overrides = {}) {
  return {
    sourceOrganizationId: "organization-source",
    sourceBonniSerial: SOURCE_BONNI_SERIAL,
    linkId: "link-source-001",
    serviceAccountId: "service-account-network-link",
    serviceLoginName: "svc-network-link",
    transportSecurity: "relay-e2ee",
    ...overrides,
  };
}

test("protocol and provider ownership are unique and disposal unregisters capabilities", () => {
  const owner = createModuleNetworkRequestRuntime("app.owner-test");
  const sameOwnerGeneration = createModuleNetworkRequestRuntime("app.owner-test");
  const contender = createModuleNetworkRequestRuntime("app.contender-test");
  const network = createModuleNetworkRequestRuntime("addon.bonni-network");
  const secondNetworkGeneration = createModuleNetworkRequestRuntime("addon.bonni-network");

  try {
    owner.registerHandler({
      protocol: "test.ownership.v1",
      handler: async () => ({ ok: true }),
    });
    assert.throws(
      () => sameOwnerGeneration.registerHandler({
        protocol: "test.ownership.v1",
        handler: async () => ({ ok: false }),
      }),
      /CORE_NETWORK_REQUEST_PROTOCOL_ALREADY_OWNED/,
    );
    assert.throws(
      () => contender.registerHandler({
        protocol: "test.ownership.v1",
        handler: async () => ({ ok: false }),
      }),
      /CORE_NETWORK_REQUEST_PROTOCOL_ALREADY_OWNED/,
    );
    assert.equal(owner.list().some((entry) => (
      entry.protocol === "test.ownership.v1" && entry.sourceModule === "app.owner-test"
    )), true);

    assert.throws(
      () => owner.registerTransportProvider(transportProvider()),
      /CORE_NETWORK_REQUEST_TRANSPORT_COORDINATOR_REQUIRED/,
    );
    const unregisterProvider = network.registerTransportProvider(transportProvider());
    assert.equal(owner.available(), true);
    assert.throws(
      () => secondNetworkGeneration.registerTransportProvider(transportProvider()),
      /CORE_NETWORK_REQUEST_TRANSPORT_PROVIDER_ALREADY_OWNED/,
    );
    assert.throws(
      () => network.registerTransportProvider(transportProvider()),
      /CORE_NETWORK_REQUEST_TRANSPORT_PROVIDER_ALREADY_OWNED/,
    );

    unregisterProvider();
    assert.equal(owner.isAvailable(), false);
    network.registerTransportProvider(transportProvider());
    assert.equal(owner.isAvailable(), true);

    owner.dispose();
    assert.equal(contender.list().some((entry) => entry.protocol === "test.ownership.v1"), false);
    assert.throws(
      () => owner.registerHandler({
        protocol: "test.ownership.after-dispose.v1",
        handler: async () => null,
      }),
      /CORE_NETWORK_REQUEST_RUNTIME_DISPOSED/,
    );

    network.dispose();
    assert.equal(contender.available(), false);
  } finally {
    owner.dispose();
    sameOwnerGeneration.dispose();
    contender.dispose();
    network.dispose();
    secondNetworkGeneration.dispose();
  }
});

test("staged runtimes expose no capability until Core commits activation", async () => {
  const stagedFeature = createStagedModuleNetworkRequestRuntime("app.inbound-test");
  const network = createModuleNetworkRequestRuntime("addon.bonni-network");
  let calls = 0;

  try {
    network.registerTransportProvider(transportProvider());
    stagedFeature.runtime.registerHandler({
      protocol: "test.inbound.v1",
      handler: async () => {
        calls += 1;
        return { ok: true };
      },
    });

    assert.equal("activate" in stagedFeature.runtime, false);
    assert.equal(stagedFeature.runtime.available(), false);
    await assert.rejects(
      stagedFeature.runtime.request(requestInput({ protocol: "test.inbound.v1" })),
      /CORE_NETWORK_REQUEST_RUNTIME_NOT_ACTIVE/,
    );
    await assert.rejects(
      network.dispatchInbound(inboundEnvelope(), verifiedPeer()),
      /CORE_NETWORK_REQUEST_HANDLER_NOT_FOUND/,
    );
    assert.equal(calls, 0);

    stagedFeature.activate();
    assert.equal(stagedFeature.runtime.available(), true);
    assert.deepEqual(
      await network.dispatchInbound(inboundEnvelope(), verifiedPeer()),
      { ok: true },
    );
    assert.equal(calls, 1);
  } finally {
    stagedFeature.dispose();
    network.dispose();
  }
});

test("a staged Network provider is unavailable before commit and immutable afterwards", async () => {
  const feature = createModuleNetworkRequestRuntime("app.feature-test");
  const stagedNetwork = createStagedModuleNetworkRequestRuntime("addon.bonni-network");
  const provider = transportProvider(async () => ({ ok: true }));

  try {
    feature.registerHandler({
      protocol: "test.feature.v1",
      handler: async () => ({ ok: true }),
    });
    stagedNetwork.runtime.registerTransportProvider(provider);
    assert.equal(feature.available(), false);
    await assert.rejects(
      feature.request(requestInput()),
      /CORE_NETWORK_REQUEST_TRANSPORT_UNAVAILABLE/,
    );

    stagedNetwork.activate();
    provider.localIdentity.organizationId = "mutated-after-registration";
    assert.equal(feature.available(), true);
    assert.deepEqual(await feature.request(requestInput()), { ok: true });
    assert.deepEqual(
      await stagedNetwork.runtime.dispatchInbound(
        {
          ...inboundEnvelope(),
          protocol: "test.feature.v1",
          sourceModule: "app.feature-test",
        },
        verifiedPeer(),
      ),
      { ok: true },
    );
  } finally {
    feature.dispose();
    stagedNetwork.dispose();
  }
});

test("outbound requests are exact, bounded and defensively cloned", async () => {
  const feature = createModuleNetworkRequestRuntime("app.feature-test");
  const other = createModuleNetworkRequestRuntime("app.other-test");
  const network = createModuleNetworkRequestRuntime("addon.bonni-network");
  const input = requestInput();
  let receivedEnvelope = null;
  let providerCalls = 0;

  try {
    feature.registerHandler({
      protocol: "test.feature.v1",
      handler: async () => ({ ok: true }),
    });

    await assert.rejects(
      feature.request(input),
      /CORE_NETWORK_REQUEST_TRANSPORT_UNAVAILABLE/,
    );
    await assert.rejects(
      other.request(input),
      /CORE_NETWORK_REQUEST_PROTOCOL_NOT_OWNED/,
    );
    network.registerTransportProvider(transportProvider(async (envelope) => {
      providerCalls += 1;
      receivedEnvelope = envelope;
      envelope.payload.nested.value = "provider-mutated-copy";
      return { accepted: true, recipient: envelope.recipientOrganizationId };
    }));

    const response = await feature.request(input);
    assert.deepEqual(response, {
      accepted: true,
      recipient: "organization-target",
    });
    assert.equal(providerCalls, 1);
    assert.equal(receivedEnvelope.sourceModule, "app.feature-test");
    assert.equal(receivedEnvelope.recipientOrganizationId, "organization-target");
    assert.equal(receivedEnvelope.recipientBonniSerial, "BONNI-TARGET-001");
    assert.equal(receivedEnvelope.linkId, "link-target-001");
    assert.equal(input.payload.nested.value, "original");

    await assert.rejects(
      feature.request(requestInput({ recipientOrganizationId: "*" })),
      /CORE_NETWORK_REQUEST_RECIPIENT_ORGANIZATION_INVALID/,
    );
    await assert.rejects(
      feature.request(requestInput({ requestId: `request-${"x".repeat(210)}` })),
      /CORE_NETWORK_REQUEST_ID_INVALID/,
    );
    await assert.rejects(
      feature.request(requestInput({
        payload: { value: "x".repeat(CORE_NETWORK_REQUEST_MAX_PAYLOAD_BYTES + 1) },
      })),
      /CORE_NETWORK_REQUEST_PAYLOAD_TOO_LARGE/,
    );
  } finally {
    feature.dispose();
    other.dispose();
    network.dispose();
  }
});

test("inbound dispatch binds authenticated peer, link and exact local target", async () => {
  const feature = createModuleNetworkRequestRuntime("app.inbound-test");
  const attacker = createModuleNetworkRequestRuntime("app.attacker-test");
  const network = createModuleNetworkRequestRuntime("addon.bonni-network");
  const originalEnvelope = inboundEnvelope();
  let handlerContext = null;

  try {
    feature.registerHandler({
      protocol: "test.inbound.v1",
      handler: async (request, context) => {
        handlerContext = context;
        request.payload.nested.value = 99;
        return {
          accepted: true,
          requestId: request.requestId,
          sourceOrganizationId: context.peer.sourceOrganizationId,
        };
      },
    });
    network.registerTransportProvider(transportProvider());

    assert.throws(
      () => attacker.dispatchInbound(originalEnvelope, verifiedPeer()),
      /CORE_NETWORK_REQUEST_TRANSPORT_COORDINATOR_REQUIRED/,
    );
    await assert.rejects(
      network.dispatchInbound(
        inboundEnvelope({ sourceModule: "app.attacker-test" }),
        verifiedPeer(),
      ),
      /CORE_NETWORK_REQUEST_SOURCE_MODULE_MISMATCH/,
    );
    await assert.rejects(
      network.dispatchInbound(inboundEnvelope({ linkId: undefined }), verifiedPeer()),
      /CORE_NETWORK_REQUEST_LINK_ID_INVALID/,
    );
    await assert.rejects(
      network.dispatchInbound(originalEnvelope, verifiedPeer({ linkId: "different-link" })),
      /CORE_NETWORK_REQUEST_LINK_ID_MISMATCH/,
    );
    await assert.rejects(
      network.dispatchInbound(
        inboundEnvelope({ recipientOrganizationId: "org_other" }),
        verifiedPeer(),
      ),
      /CORE_NETWORK_REQUEST_RECIPIENT_ORGANIZATION_MISMATCH/,
    );
    await assert.rejects(
      network.dispatchInbound(
        inboundEnvelope({ recipientBonniSerial: "BONNI-OTHER-001" }),
        verifiedPeer(),
      ),
      /CORE_NETWORK_REQUEST_RECIPIENT_SERIAL_MISMATCH/,
    );
    await assert.rejects(
      network.dispatchInbound(originalEnvelope, verifiedPeer({ sourceBonniSerial: undefined })),
      /CORE_NETWORK_REQUEST_SOURCE_SERIAL_INVALID/,
    );
    await assert.rejects(
      network.dispatchInbound(originalEnvelope, verifiedPeer({ serviceAccountId: undefined })),
      /CORE_NETWORK_REQUEST_SERVICE_ACCOUNT_ID_INVALID/,
    );

    const response = await network.dispatchInbound(originalEnvelope, verifiedPeer());
    assert.deepEqual(response, {
      accepted: true,
      requestId: "request-inbound-0001",
      sourceOrganizationId: "organization-source",
    });
    assert.equal(originalEnvelope.payload.nested.value, 1);
    assert.equal(handlerContext.peer.sourceBonniSerial, SOURCE_BONNI_SERIAL);
    assert.equal(handlerContext.peer.serviceAccountId, "service-account-network-link");
    assert.equal(handlerContext.peer.transportSecurity, "relay-e2ee");
    assert.equal(handlerContext.signal.aborted, false);

    await network.dispatchInbound(
      inboundEnvelope({
        requestId: "request-inbound-direct-0001",
        idempotencyKey: "idempotency-inbound-direct-0001",
      }),
      verifiedPeer({ transportSecurity: "direct-e2ee" }),
    );
    assert.equal(handlerContext.peer.transportSecurity, "direct-e2ee");

    assert.deepEqual(
      await network.dispatchInbound(
        inboundEnvelope({ recipientBonniSerial: undefined }),
        verifiedPeer(),
      ),
      {
        accepted: true,
        requestId: "request-inbound-0001",
        sourceOrganizationId: "organization-source",
      },
    );
  } finally {
    feature.dispose();
    attacker.dispose();
    network.dispose();
  }
});

test("a provider without an immutable local identity is rejected fail closed", () => {
  const network = createModuleNetworkRequestRuntime("addon.bonni-network");
  try {
    assert.throws(
      () => network.registerTransportProvider({ request: async () => ({ ok: true }) }),
      /CORE_NETWORK_REQUEST_TRANSPORT_PROVIDER_INVALID/,
    );
    assert.throws(
      () => network.registerTransportProvider(transportProvider(
        async () => ({ ok: true }),
        { localIdentity: { organizationId: "*", bonniSerial: LOCAL_BONNI_SERIAL } },
      )),
      /CORE_NETWORK_REQUEST_LOCAL_IDENTITY_INVALID/,
    );
  } finally {
    network.dispose();
  }
});

test("strict JSON rejects every value that would be coerced or lose information", async () => {
  const feature = createModuleNetworkRequestRuntime("app.json-test");
  const network = createModuleNetworkRequestRuntime("addon.bonni-network");
  let invalidResponse = false;

  try {
    feature.registerHandler({
      protocol: "test.json.v1",
      handler: async () => ({ ok: true }),
    });
    network.registerTransportProvider(transportProvider(async () => (
      invalidResponse ? { value: new Map([["key", "value"]]) } : { ok: true }
    )));

    const invalidPayloads = [
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: undefined },
      { value: new Date("2026-01-01T00:00:00.000Z") },
      { value: new Map([["key", "value"]]) },
      { value: new Set(["value"]) },
      { value: new Uint8Array([1, 2, 3]) },
      { value: 1n },
      Object.assign(Object.create(null), { value: undefined }),
      Array(1),
    ];
    const cyclic = {};
    cyclic.self = cyclic;
    invalidPayloads.push(cyclic);

    for (const payload of invalidPayloads) {
      await assert.rejects(
        feature.request(requestInput({ protocol: "test.json.v1", payload })),
        /CORE_NETWORK_REQUEST_JSON_REQUIRED/,
      );
    }

    invalidResponse = true;
    await assert.rejects(
      feature.request(requestInput({ protocol: "test.json.v1", payload: { valid: true } })),
      /CORE_NETWORK_REQUEST_JSON_REQUIRED/,
    );
  } finally {
    feature.dispose();
    network.dispose();
  }
});

test("foreign transport and handler errors are reduced to stable public codes", async () => {
  const outbound = createModuleNetworkRequestRuntime("app.error-outbound");
  const inbound = createModuleNetworkRequestRuntime("app.error-inbound");
  const network = createModuleNetworkRequestRuntime("addon.bonni-network");

  try {
    outbound.registerHandler({
      protocol: "test.error.outbound.v1",
      handler: async () => ({ ok: true }),
    });
    inbound.registerHandler({
      protocol: "test.error.inbound.v1",
      handler: async () => {
        throw new Error("SECRET_HANDLER_DATABASE_DETAIL");
      },
    });
    network.registerTransportProvider(transportProvider(async () => {
      throw new Error("SECRET_TRANSPORT_ENDPOINT_DETAIL");
    }));

    await assert.rejects(
      outbound.request(requestInput({ protocol: "test.error.outbound.v1" })),
      (error) => (
        error.message === "CORE_NETWORK_REQUEST_TRANSPORT_FAILED"
        && !error.message.includes("SECRET")
        && !String(error.stack).includes("SECRET_TRANSPORT")
      ),
    );
    await assert.rejects(
      network.dispatchInbound(
        inboundEnvelope({
          protocol: "test.error.inbound.v1",
          sourceModule: "app.error-inbound",
        }),
        verifiedPeer(),
      ),
      (error) => (
        error.message === "CORE_NETWORK_REQUEST_HANDLER_FAILED"
        && !error.message.includes("SECRET")
        && !String(error.stack).includes("SECRET_HANDLER")
      ),
    );
  } finally {
    outbound.dispose();
    inbound.dispose();
    network.dispose();
  }
});

test("dispose before invocation prevents stale provider and handler calls", async () => {
  const outbound = createModuleNetworkRequestRuntime("app.race-outbound");
  const networkOutbound = createModuleNetworkRequestRuntime("addon.bonni-network");
  let providerCalls = 0;

  outbound.registerHandler({
    protocol: "test.race.outbound.v1",
    handler: async () => ({ ok: true }),
  });
  networkOutbound.registerTransportProvider(transportProvider(async () => {
    providerCalls += 1;
    return { ok: true };
  }));
  const outboundPending = outbound.request(requestInput({ protocol: "test.race.outbound.v1" }));
  networkOutbound.dispose();
  await assert.rejects(outboundPending, /CORE_NETWORK_REQUEST_CANCELLED/);
  await Promise.resolve();
  assert.equal(providerCalls, 0);
  outbound.dispose();

  const inbound = createModuleNetworkRequestRuntime("app.race-inbound");
  const networkInbound = createModuleNetworkRequestRuntime("addon.bonni-network");
  let handlerCalls = 0;
  inbound.registerHandler({
    protocol: "test.race.inbound.v1",
    handler: async () => {
      handlerCalls += 1;
      return { ok: true };
    },
  });
  networkInbound.registerTransportProvider(transportProvider());
  const inboundPending = networkInbound.dispatchInbound(
    inboundEnvelope({
      protocol: "test.race.inbound.v1",
      sourceModule: "app.race-inbound",
    }),
    verifiedPeer(),
  );
  inbound.dispose();
  await assert.rejects(inboundPending, /CORE_NETWORK_REQUEST_CANCELLED/);
  await Promise.resolve();
  assert.equal(handlerCalls, 0);
  networkInbound.dispose();
});

test("dispose aborts provider and handler work already in flight", async () => {
  const outbound = createModuleNetworkRequestRuntime("app.abort-outbound");
  const networkOutbound = createModuleNetworkRequestRuntime("addon.bonni-network");
  let providerStarted;
  const providerStartedPromise = new Promise((resolve) => { providerStarted = resolve; });
  let providerAborted = false;

  outbound.registerHandler({
    protocol: "test.abort.outbound.v1",
    handler: async () => ({ ok: true }),
  });
  networkOutbound.registerTransportProvider(transportProvider(
    async (_envelope, context) => new Promise((_resolve, reject) => {
      providerStarted();
      context.signal.addEventListener("abort", () => {
        providerAborted = true;
        reject(new Error("foreign provider cancellation detail"));
      }, { once: true });
    }),
  ));
  const outboundPending = outbound.request(requestInput({ protocol: "test.abort.outbound.v1" }));
  await providerStartedPromise;
  outbound.dispose();
  await assert.rejects(outboundPending, /CORE_NETWORK_REQUEST_CANCELLED/);
  assert.equal(providerAborted, true);
  networkOutbound.dispose();

  const inbound = createModuleNetworkRequestRuntime("app.abort-inbound");
  const networkInbound = createModuleNetworkRequestRuntime("addon.bonni-network");
  let handlerStarted;
  const handlerStartedPromise = new Promise((resolve) => { handlerStarted = resolve; });
  let handlerAborted = false;
  inbound.registerHandler({
    protocol: "test.abort.inbound.v1",
    handler: async (_request, context) => new Promise((_resolve, reject) => {
      handlerStarted();
      context.signal.addEventListener("abort", () => {
        handlerAborted = true;
        reject(new Error("foreign handler cancellation detail"));
      }, { once: true });
    }),
  });
  networkInbound.registerTransportProvider(transportProvider());
  const inboundPending = networkInbound.dispatchInbound(
    inboundEnvelope({
      protocol: "test.abort.inbound.v1",
      sourceModule: "app.abort-inbound",
    }),
    verifiedPeer(),
  );
  await handlerStartedPromise;
  inbound.dispose();
  await assert.rejects(inboundPending, /CORE_NETWORK_REQUEST_CANCELLED/);
  assert.equal(handlerAborted, true);
  networkInbound.dispose();
});

test("outbound transport and inbound handlers are aborted on timeout", async () => {
  const outbound = createModuleNetworkRequestRuntime("app.timeout-outbound");
  const inbound = createModuleNetworkRequestRuntime("app.timeout-inbound");
  const network = createModuleNetworkRequestRuntime("addon.bonni-network");
  let outboundAborted = false;
  let inboundAborted = false;

  try {
    outbound.registerHandler({
      protocol: "test.timeout.outbound.v1",
      handler: async () => null,
    });
    inbound.registerHandler({
      protocol: "test.timeout.inbound.v1",
      handler: async (_request, context) => new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          inboundAborted = true;
          reject(new Error("handler aborted"));
        }, { once: true });
      }),
    });
    network.registerTransportProvider(transportProvider(
      async (_envelope, context) => new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          outboundAborted = true;
          reject(new Error("transport aborted"));
        }, { once: true });
      }),
    ));

    await assert.rejects(
      outbound.request(requestInput({
        protocol: "test.timeout.outbound.v1",
        timeoutMs: 100,
      })),
      /CORE_NETWORK_REQUEST_TIMEOUT/,
    );
    assert.equal(outboundAborted, true);

    await assert.rejects(
      network.dispatchInbound(inboundEnvelope({
        protocol: "test.timeout.inbound.v1",
        sourceModule: "app.timeout-inbound",
      }), verifiedPeer(), { timeoutMs: 100 }),
      /CORE_NETWORK_REQUEST_TIMEOUT/,
    );
    assert.equal(inboundAborted, true);
  } finally {
    outbound.dispose();
    inbound.dispose();
    network.dispose();
  }
});

test("oversized responses and expired requests are rejected", async () => {
  const feature = createModuleNetworkRequestRuntime("app.limit-test");
  const network = createModuleNetworkRequestRuntime("addon.bonni-network");

  try {
    feature.registerHandler({
      protocol: "test.limit.v1",
      handler: async () => ({ ok: true }),
    });
    network.registerTransportProvider(transportProvider(
      async () => ({ value: "x".repeat(CORE_NETWORK_REQUEST_MAX_RESPONSE_BYTES + 1) }),
    ));

    await assert.rejects(
      feature.request(requestInput({ protocol: "test.limit.v1" })),
      /CORE_NETWORK_REQUEST_RESPONSE_TOO_LARGE/,
    );
    await assert.rejects(
      feature.request(requestInput({
        protocol: "test.limit.v1",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      })),
      /CORE_NETWORK_REQUEST_EXPIRED/,
    );
  } finally {
    feature.dispose();
    network.dispose();
  }
});
