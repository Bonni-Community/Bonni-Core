import assert from "node:assert/strict";
import test from "node:test";

import { registerDomainMessageHandlers as registerKontor } from "../../app/kontorapp/backend/src/modules/domain-messages.js";

const CASH_REQUESTED = "bonni.finance.pos.cash-transfer.requested/v1";
const CASH_COMPLETED = "bonni.finance.stueberl.cash-transfer.completed/v1";
const ACCOUNTING_COMPLETED = "bonni.finance.stueberl.accounting.completed/v1";
const INVOICE_REQUESTED = "bonni.finance.kontor.invoice.requested/v1";
const INVOICE_COMPLETED = "bonni.finance.pos.invoice.completed/v1";

async function loadOptionalPos(t) {
  try {
    return (await import("../../app/posapp/backend/src/registerFeatureModule.js")).default;
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip("Die optionale POS-App ist in diesem Bonni-Core/Kontor-Quellpaket nicht enthalten.");
      return null;
    }
    throw error;
  }
}

function messageBus() {
  const handlers = new Map();
  const messages = new Map();
  let sequence = 0;
  return {
    contractVersion: "bonni.domain-messages/v1",
    messages,
    subscribe(protocol, handler) {
      handlers.set(protocol, handler);
      return () => handlers.delete(protocol);
    },
    async publish(input) {
      const previous = messages.get(input.idempotencyKey);
      if (previous) return previous.public;
      const message = {
        public: { id: `message-${++sequence}`, correlationId: input.correlationId, protocol: input.protocol },
        input: structuredClone(input),
      };
      messages.set(input.idempotencyKey, message);
      const handler = handlers.get(input.protocol);
      if (handler) {
        message.result = await handler({
          messageId: message.public.id,
          correlationId: input.correlationId,
          protocol: input.protocol,
          sourceDomain: input.protocol === CASH_REQUESTED ? "stueberl" : input.protocol === INVOICE_REQUESTED ? "pos" : "kontor",
          sourceRecordId: input.sourceRecordId || null,
          initiatedByAccountId: "account-manager",
          payloadHash: "a".repeat(64),
          payload: input.payload,
        });
      }
      return message.public;
    },
    async inject(input) {
      const handler = handlers.get(input.protocol);
      if (!handler) throw new Error(`HANDLER_MISSING:${input.protocol}`);
      return handler(input);
    },
  };
}

function posPrisma() {
  const cashTransfers = [];
  const invoiceRequests = [];
  let cashSequence = 0;
  let invoiceSequence = 0;
  const delegate = (records, idPrefix, nextId) => ({
    async findUnique({ where }) {
      const [key, value] = Object.entries(where)[0];
      return records.find((entry) => entry[key] === value) || null;
    },
    async create({ data }) {
      const now = new Date();
      const record = { id: `${idPrefix}-${nextId()}`, createdAt: now, updatedAt: now, ...structuredClone(data) };
      records.push(record);
      return record;
    },
    async update({ where, data }) {
      const record = records.find((entry) => entry.id === where.id);
      if (!record) throw new Error(`${idPrefix.toUpperCase()}_NOT_FOUND`);
      Object.assign(record, structuredClone(data), { updatedAt: new Date() });
      return record;
    },
  });
  return {
    cashTransfers,
    invoiceRequests,
    posCashTransfer: delegate(cashTransfers, "cash", () => ++cashSequence),
    posKontorInvoiceRequest: delegate(invoiceRequests, "invoice-request", () => ++invoiceSequence),
  };
}

function kontorPrisma() {
  const requests = [];
  const entries = [];
  const invoices = [];
  const audits = [];
  const subledgers = [];
  const subledgerItems = [];
  const counters = new Map();
  return {
    requests,
    entries,
    invoices,
    audits,
    subledgers,
    subledgerItems,
    kontorSubledger: {
      async upsert({ where, update, create }) {
        let record = subledgers.find((entry) => entry.key === where.key);
        if (record) {
          Object.assign(record, structuredClone(update));
          return record;
        }
        record = { id: `subledger-${subledgers.length + 1}`, ...structuredClone(create) };
        subledgers.push(record);
        return record;
      },
    },
    kontorInboundInvoiceRequest: {
      async findUnique({ where }) {
        return requests.find((entry) => entry.correlationId === where.correlationId) || null;
      },
      async update({ where, data }) {
        const request = requests.find((entry) => entry.id === where.id);
        Object.assign(request, structuredClone(data));
        return request;
      },
    },
    async $transaction(callback) {
      return callback({
        kontorCounter: {
          async upsert({ where }) {
            const value = (counters.get(where.key) || 0) + 1;
            counters.set(where.key, value);
            return { key: where.key, value };
          },
        },
        kontorPosInvoice: {
          async create({ data }) {
            const record = { id: `pos-invoice-${invoices.length + 1}`, ...structuredClone(data) };
            invoices.push(record);
            return record;
          },
        },
        kontorFinanceEntry: {
          async create({ data }) {
            const record = { id: `finance-${entries.length + 1}`, ...structuredClone(data) };
            entries.push(record);
            return record;
          },
        },
        kontorSubledgerItem: {
          async upsert({ where, update, create }) {
            const key = where.subledgerId_sourceModuleKey_sourceExternalId;
            let record = subledgerItems.find((entry) => (
              entry.subledgerId === key.subledgerId
              && entry.sourceModuleKey === key.sourceModuleKey
              && entry.sourceExternalId === key.sourceExternalId
            ));
            if (record) {
              Object.assign(record, structuredClone(update));
              return record;
            }
            record = { id: `subledger-item-${subledgerItems.length + 1}`, ...structuredClone(create) };
            subledgerItems.push(record);
            return record;
          },
          async create({ data }) {
            const record = { id: `subledger-item-${subledgerItems.length + 1}`, ...structuredClone(data) };
            subledgerItems.push(record);
            return record;
          },
        },
        kontorInboundInvoiceRequest: {
          async create({ data }) {
            const record = { id: `kontor-request-${requests.length + 1}`, ...structuredClone(data) };
            requests.push(record);
            return record;
          },
        },
        kontorAuditEntry: {
          async create({ data }) {
            const record = { id: `audit-${audits.length + 1}`, ...structuredClone(data) };
            audits.push(record);
            return record;
          },
        },
      });
    },
  };
}

test("Stueberl CASH request is recorded by POS, invoiced to Kontor and fully correlated", async (t) => {
  const registerPos = await loadOptionalPos(t);
  if (!registerPos) return;
  const expectedInvoiceNumber = `POS-${new Date().getUTCFullYear()}-000001`;
  const bus = messageBus();
  const pos = posPrisma();
  const kontor = kontorPrisma();
  const stueberlCompletions = [];
  const stueberlAccountingCompletions = [];

  bus.subscribe(CASH_COMPLETED, async (input) => {
    stueberlCompletions.push(input);
    return { targetRecordId: "stueberl-request-1" };
  });
  bus.subscribe(ACCOUNTING_COMPLETED, async (input) => {
    stueberlAccountingCompletions.push(input);
    return { targetRecordId: "stueberl-request-1" };
  });
  registerKontor({ prisma: kontor, domainMessages: bus });
  const releasePos = await registerPos({
    services: {
      database: {
        mode: "scoped-v1",
        moduleKey: "app.posapp",
        allowedDelegates: [
          "posCashTransfer", "posDevice", "posFiscalEvidence", "posKontorInvoiceRequest",
          "posPayment", "posReceipt", "posTransaction", "posTransactionLine",
        ],
        client: pos,
      },
      domainMessages: bus,
    },
    logger: {},
  });

  await bus.inject({
    messageId: "message-stueberl-1",
    correlationId: "correlation-1",
    protocol: CASH_REQUESTED,
    sourceDomain: "stueberl",
    sourceRecordId: "stueberl-request-1",
    initiatedByAccountId: "account-manager",
    payloadHash: "a".repeat(64),
    payload: {
      sourceRequestId: "stueberl-request-1",
      amount: "120.50",
      currency: "EUR",
      requestedTransferType: "CASH",
      purpose: "Barauslage Sommerfest",
      recipientMemberId: "member-1",
    },
  });

  assert.equal(pos.cashTransfers.length, 1);
  assert.equal(pos.cashTransfers[0].transferType, "CASH");
  assert.equal(pos.cashTransfers[0].status, "COMPLETED");
  assert.equal(pos.cashTransfers[0].purpose, "Barauslage Sommerfest");
  assert.equal(pos.cashTransfers[0].requestMessageId, "message-stueberl-1");
  assert.equal(pos.cashTransfers[0].acceptedByAccountId, "module:app.posapp");
  assert.equal(stueberlCompletions.length, 1);
  assert.equal(stueberlCompletions[0].payload.transferType, "CASH");

  assert.equal(pos.invoiceRequests.length, 1);
  assert.equal(pos.invoiceRequests[0].status, "COMPLETED");
  assert.equal(pos.invoiceRequests[0].kontorInvoiceId, "pos-invoice-1");
  assert.equal(pos.invoiceRequests[0].kontorInvoiceNumber, expectedInvoiceNumber);
  assert.equal(kontor.requests.length, 1);
  assert.equal(kontor.requests[0].sourceDomain, "pos");
  assert.equal(kontor.requests[0].requestMessageId, "message-2");
  assert.equal(kontor.requests[0].completionMessageId, "message-3");
  assert.equal(kontor.entries.length, 1);
  assert.equal(kontor.entries[0].entryType, "EXPENSE");
  assert.equal(kontor.entries[0].paymentMethod, "CASH");
  assert.equal(kontor.entries[0].reference, "correlation-1");
  assert.equal(kontor.subledgers.length, 1);
  assert.equal(kontor.entries[0].subledgerId, kontor.subledgers[0].id);
  assert.equal(kontor.subledgerItems.length, 1);
  assert.equal(kontor.subledgerItems[0].financeEntryId, "finance-1");
  assert.equal(kontor.subledgerItems[0].movementType, "TRANSFER_OUT");
  assert.equal(kontor.invoices.length, 1);
  assert.equal(kontor.invoices[0].financeEntryId, "finance-1");
  assert.equal(kontor.invoices[0].invoiceNumber, expectedInvoiceNumber);
  assert.equal(kontor.requests[0].generatedInvoiceId, "pos-invoice-1");
  assert.equal(kontor.audits.length, 1);
  assert.equal(kontor.audits[0].metadata.transferType, "CASH");
  assert.equal(stueberlAccountingCompletions.length, 1);
  assert.equal(stueberlAccountingCompletions[0].payload.kontorInvoiceNumber, expectedInvoiceNumber);
  assert.equal(stueberlAccountingCompletions[0].payload.transferType, "CASH");

  const protocols = [...bus.messages.values()].map(({ input }) => input.protocol);
  assert.deepEqual(protocols, [CASH_COMPLETED, INVOICE_REQUESTED, INVOICE_COMPLETED, ACCOUNTING_COMPLETED]);
  assert.ok(pos.cashTransfers[0].completionMessageId);
  assert.ok(pos.invoiceRequests[0].domainMessageId);
  assert.ok(pos.invoiceRequests[0].completionMessageId);

  releasePos();
});

test("POS rejects every Stueberl transfer form except CASH", async (t) => {
  const registerPos = await loadOptionalPos(t);
  if (!registerPos) return;
  const bus = messageBus();
  const pos = posPrisma();
  const releasePos = await registerPos({
    services: {
      database: {
        mode: "scoped-v1",
        moduleKey: "app.posapp",
        allowedDelegates: [
          "posCashTransfer", "posDevice", "posFiscalEvidence", "posKontorInvoiceRequest",
          "posPayment", "posReceipt", "posTransaction", "posTransactionLine",
        ],
        client: pos,
      },
      domainMessages: bus,
    },
    logger: {},
  });

  await assert.rejects(bus.inject({
    messageId: "message-forbidden",
    correlationId: "correlation-forbidden",
    protocol: CASH_REQUESTED,
    sourceDomain: "stueberl",
    sourceRecordId: "stueberl-request-forbidden",
    initiatedByAccountId: "account-manager",
    payloadHash: "b".repeat(64),
    payload: {
      amount: "10.00",
      currency: "EUR",
      requestedTransferType: "SEPA",
      purpose: "Unzulässige Zahlungsart",
    },
  }), /POS_ONLY_CASH_TRANSFER_SUPPORTED/);
  assert.equal(pos.cashTransfers.length, 0);
  assert.equal(pos.invoiceRequests.length, 0);
  releasePos();
});
