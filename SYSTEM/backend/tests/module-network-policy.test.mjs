import assert from "node:assert/strict";
import test from "node:test";

import {
  createModuleNetworkPolicyAuthorizer,
  listModuleNetworkObservations,
  listModuleNetworkPolicies,
  updateModuleNetworkPolicy,
} from "../dist/core/network-policy/index.js";

function fakePrisma() {
  const modules = [
    { key: "app.hocketapp", name: "HocketApp", kind: "APP", status: "ENABLED", deletedAt: null },
  ];
  const policies = [];
  const observations = [];
  let sequence = 0;
  return {
    installedModule: {
      async findUnique({ where }) { return modules.find((entry) => entry.key === where.key) || null; },
      async findMany() { return modules.map(({ deletedAt, ...entry }) => entry); },
    },
    moduleNetworkPolicy: {
      async findUnique({ where }) { return policies.find((entry) => entry.moduleKey === where.moduleKey) || null; },
      async findMany() { return structuredClone(policies); },
      async upsert({ where, create, update }) {
        const found = policies.find((entry) => entry.moduleKey === where.moduleKey);
        if (found) Object.assign(found, structuredClone(update));
        else policies.push(structuredClone(create));
        return structuredClone(found || policies.at(-1));
      },
    },
    moduleNetworkObservation: {
      async create({ data }) {
        const entry = { id: `observation-${++sequence}`, observedAt: new Date(), ...structuredClone(data) };
        observations.push(entry);
        return structuredClone(entry);
      },
      async findMany({ where, take }) {
        return observations
          .filter((entry) => (!where.moduleKey || entry.moduleKey === where.moduleKey)
            && (!where.decision || entry.decision === where.decision))
          .slice(-take)
          .reverse()
          .map((entry) => structuredClone(entry));
      },
    },
    state: { policies, observations },
  };
}

test("module network policy is fail-closed and every decision is recorded", async () => {
  const prisma = fakePrisma();
  const authorize = createModuleNetworkPolicyAuthorizer(prisma);
  const request = {
    moduleKey: "app.hocketapp",
    direction: "OUTBOUND",
    protocol: "hocket.plan.v1",
    remoteHost: "org-remote",
    secure: true,
  };

  await assert.rejects(authorize(request), /MODULE_NETWORK_DENIED:POLICY_NOT_CONFIGURED/);
  assert.equal(prisma.state.observations.at(-1).decision, "DENY");

  await updateModuleNetworkPolicy(prisma, "app.hocketapp", {
    exposure: "INTERNAL",
    outboundEnabled: true,
    requireTls: true,
    allowedHosts: ["org-remote"],
    allowedProtocols: ["hocket.plan.v1"],
  }, "account-admin");
  await authorize(request);
  assert.equal(prisma.state.observations.at(-1).decision, "ALLOW");

  await assert.rejects(
    authorize({ ...request, remoteHost: "org-foreign" }),
    /MODULE_NETWORK_DENIED:REMOTE_HOST_NOT_ALLOWED/,
  );
  assert.equal(prisma.state.observations.at(-1).reason, "REMOTE_HOST_NOT_ALLOWED");

  const listed = await listModuleNetworkPolicies(prisma);
  assert.equal(listed[0].configured, true);
  assert.deepEqual(listed[0].allowedProtocols, ["hocket.plan.v1"]);
  const denied = await listModuleNetworkObservations(prisma, { decision: "DENY", limit: 10 });
  assert.equal(denied.length, 2);
});

test("LOCAL inbound policy accepts only the same organization and TLS remains mandatory", async () => {
  const prisma = fakePrisma();
  await updateModuleNetworkPolicy(prisma, "app.hocketapp", {
    exposure: "LOCAL",
    outboundEnabled: false,
    requireTls: true,
    allowedHosts: [],
    allowedProtocols: [],
  }, "account-admin");
  const authorize = createModuleNetworkPolicyAuthorizer(prisma);
  const request = {
    moduleKey: "app.hocketapp",
    direction: "INBOUND",
    protocol: "hocket.plan.v1",
    remoteHost: "org-local",
    secure: true,
    sameOrganization: true,
  };
  await authorize(request);
  await assert.rejects(authorize({ ...request, sameOrganization: false }), /LOCAL_ONLY/);
  await assert.rejects(authorize({ ...request, secure: false }), /TLS_REQUIRED/);
});
