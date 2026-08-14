import assert from "node:assert/strict";
import test from "node:test";

import { createModuleDomainMessageRuntime } from "../dist/core/domain-messages/index.js";

function clone(value) {
  return structuredClone(value);
}

function coreMessagePrisma() {
  const messages = [];
  const attempts = [];
  let sequence = 0;

  const domainMessage = {
    async findUnique({ where }) {
      return messages.find((entry) => (
        (where.id && entry.id === where.id)
        || (where.idempotencyKey && entry.idempotencyKey === where.idempotencyKey)
      )) || null;
    },
    async create({ data }) {
      const now = new Date();
      const record = {
        id: `message-${++sequence}`,
        status: "PENDING",
        targetRecordId: null,
        deliveredAt: null,
        rejectedAt: null,
        failedAt: null,
        lastErrorCode: null,
        createdAt: now,
        updatedAt: now,
        ...clone(data),
      };
      messages.push(record);
      return record;
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const entry of messages) {
        if (where.id && entry.id !== where.id) continue;
        if (where.protocol && entry.protocol !== where.protocol) continue;
        if (where.status && entry.status !== where.status) continue;
        if (where.updatedAt?.lt && !(entry.updatedAt < where.updatedAt.lt)) continue;
        Object.assign(entry, clone(data), { updatedAt: new Date() });
        count += 1;
      }
      return { count };
    },
    async update({ where, data }) {
      const entry = messages.find((record) => record.id === where.id);
      if (!entry) throw new Error("MESSAGE_NOT_FOUND");
      Object.assign(entry, clone(data), { updatedAt: new Date() });
      return entry;
    },
    async findMany({ where, orderBy, take, select } = {}) {
      let result = [...messages];
      if (where?.protocol) result = result.filter((entry) => entry.protocol === where.protocol);
      if (where?.status) result = result.filter((entry) => entry.status === where.status);
      if (where?.correlationId) result = result.filter((entry) => entry.correlationId === where.correlationId);
      if (where?.OR) {
        result = result.filter((entry) => where.OR.some((condition) => (
          Object.entries(condition).every(([key, value]) => entry[key] === value)
        )));
      }
      if (orderBy?.createdAt === "asc") result.sort((left, right) => left.createdAt - right.createdAt);
      if (take) result = result.slice(0, take);
      if (select?.id) return result.map(({ id }) => ({ id }));
      return result;
    },
  };

  const domainMessageAttempt = {
    async count({ where }) {
      return attempts.filter((entry) => entry.messageId === where.messageId).length;
    },
    async create({ data }) {
      if (attempts.some((entry) => (
        entry.messageId === data.messageId && entry.attemptNumber === data.attemptNumber
      ))) throw new Error("ATTEMPT_DUPLICATE");
      const record = { id: `attempt-${attempts.length + 1}`, createdAt: new Date(), ...clone(data) };
      attempts.push(record);
      return record;
    },
  };

  return {
    messages,
    attempts,
    domainMessage,
    domainMessageAttempt,
    async $transaction(operations) {
      return Promise.all(operations);
    },
  };
}

async function until(predicate, message) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("financial domain messages are encrypted, allow-listed, idempotent and evidenced", async () => {
  const prisma = coreMessagePrisma();
  const source = createModuleDomainMessageRuntime("app.stueberlapp", prisma);
  const target = createModuleDomainMessageRuntime("app.posapp", prisma);
  const unrelated = createModuleDomainMessageRuntime("app.meetapp", prisma);
  const protocol = "bonni.finance.pos.cash-transfer.requested/v1";
  const correlationId = "finance-correlation-0001";
  const payload = {
    sourceRequestId: "stueberl-transfer-0001",
    amount: "120.50",
    currency: "EUR",
    requestedTransferType: "CASH",
    purpose: "Barauslage Sommerfest",
  };

  const published = await source.publish({
    protocol,
    correlationId,
    idempotencyKey: "cash-transfer-0001",
    sourceRecordId: payload.sourceRequestId,
    payload,
  });
  assert.equal(prisma.messages.length, 1);
  assert.equal(prisma.messages[0].status, "PENDING");
  assert.match(prisma.messages[0].payloadCiphertext, /^bdm1\./);
  assert.doesNotMatch(prisma.messages[0].payloadCiphertext, /Barauslage|120\.50/);
  assert.equal(published.payloadCiphertext, undefined, "ciphertext is never exposed through the module port");

  let received;
  const release = target.subscribe(protocol, async (input) => {
    received = input;
    return { targetRecordId: "pos-transfer-0001", result: { status: "COMPLETED" } };
  });
  await until(() => prisma.messages[0].status === "DELIVERED", "message was not delivered");

  assert.deepEqual(received.payload, payload);
  assert.equal(received.correlationId, correlationId);
  assert.equal(prisma.messages[0].targetRecordId, "pos-transfer-0001");
  assert.equal(prisma.messages[0].payloadCiphertext, null, "delivered plaintext material is erased");
  assert.equal(prisma.attempts.length, 1);
  assert.equal(prisma.attempts[0].decision, "DELIVERED");
  assert.equal(prisma.attempts[0].remoteIdentity, "app.posapp");
  assert.match(prisma.attempts[0].resultHash, /^[a-f0-9]{64}$/);

  const repeated = await source.publish({
    protocol,
    correlationId,
    idempotencyKey: "cash-transfer-0001",
    sourceRecordId: payload.sourceRequestId,
    payload,
  });
  assert.equal(repeated.id, published.id);
  assert.equal(prisma.messages.length, 1);
  assert.equal(prisma.attempts.length, 1);

  await assert.rejects(
    source.publish({
      protocol,
      correlationId,
      idempotencyKey: "cash-transfer-0001",
      sourceRecordId: payload.sourceRequestId,
      payload: { ...payload, amount: "999.00" },
    }),
    /DOMAIN_MESSAGE_IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    unrelated.publish({
      protocol,
      idempotencyKey: "forbidden",
      payload,
    }),
    /DOMAIN_MESSAGE_PROTOCOL_PUBLISH_DENIED/,
  );

  const trail = await source.listByCorrelation(correlationId);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].status, "DELIVERED");
  assert.equal(trail[0].payloadCiphertext, undefined);

  release();
  source.dispose();
  target.dispose();
  unrelated.dispose();
});

test("Kontor accepts allow-listed subledger reports from Bonni finance apps", async () => {
  const prisma = coreMessagePrisma();
  const kontor = createModuleDomainMessageRuntime("app.kontorapp", prisma);
  const sources = ["app.stueberlapp", "app.hocketapp", "app.posapp"];
  const protocol = "bonni.finance.kontor.subledger.reported/v1";
  const received = [];
  const release = kontor.subscribe(protocol, async (input) => {
    received.push(input);
    return { targetRecordId: `kontor-${input.sourceRecordId}` };
  });

  for (const [index, sourceKey] of sources.entries()) {
    const source = createModuleDomainMessageRuntime(sourceKey, prisma);
    await source.publish({
      protocol,
      correlationId: `subledger-correlation-${index}`,
      idempotencyKey: `subledger-report-${index}`,
      sourceRecordId: `source-${index}`,
      payload: { amount: `${index + 1}.00`, currency: "EUR" },
    });
    source.dispose();
  }

  await until(() => received.length === sources.length, "subledger reports were not delivered");
  assert.deepEqual(received.map((entry) => entry.sourceDomain), ["stueberl", "hocket", "pos"]);
  assert.ok(prisma.messages.every((entry) => entry.status === "DELIVERED"));

  release();
  kontor.dispose();
});
