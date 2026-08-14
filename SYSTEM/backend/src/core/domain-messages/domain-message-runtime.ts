import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import { env } from "../config/env.js";
import { dataDomainForModule, type DataDomain } from "../database/data-domains.js";
import { getVerifiedRequestIdentity } from "../../platform/auth/request-identity/request-identity-context.js";

export const DOMAIN_MESSAGE_CONTRACT_VERSION = "bonni.domain-messages/v1" as const;

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const DELIVERY_LEASE_MS = 5 * 60 * 1000;

type ProtocolPolicy = Readonly<{
  protocol: string;
  sourceModule: string;
  sourceDomain: DataDomain;
  targetModule: string;
  targetDomain: DataDomain;
}>;

const protocolPolicies: readonly ProtocolPolicy[] = Object.freeze([
  Object.freeze({
    protocol: "bonni.finance.pos.cash-transfer.requested/v1",
    sourceModule: "app.stueberlapp",
    sourceDomain: "stueberl",
    targetModule: "app.posapp",
    targetDomain: "pos",
  }),
  Object.freeze({
    protocol: "bonni.finance.stueberl.cash-transfer.completed/v1",
    sourceModule: "app.posapp",
    sourceDomain: "pos",
    targetModule: "app.stueberlapp",
    targetDomain: "stueberl",
  }),
  Object.freeze({
    protocol: "bonni.finance.stueberl.accounting.completed/v1",
    sourceModule: "app.posapp",
    sourceDomain: "pos",
    targetModule: "app.stueberlapp",
    targetDomain: "stueberl",
  }),
  Object.freeze({
    protocol: "bonni.finance.kontor.invoice.requested/v1",
    sourceModule: "app.posapp",
    sourceDomain: "pos",
    targetModule: "app.kontorapp",
    targetDomain: "kontor",
  }),
  Object.freeze({
    protocol: "bonni.finance.pos.invoice.completed/v1",
    sourceModule: "app.kontorapp",
    sourceDomain: "kontor",
    targetModule: "app.posapp",
    targetDomain: "pos",
  }),
  Object.freeze({
    protocol: "bonni.finance.kontor.subledger.reported/v1",
    sourceModule: "app.stueberlapp",
    sourceDomain: "stueberl",
    targetModule: "app.kontorapp",
    targetDomain: "kontor",
  }),
  Object.freeze({
    protocol: "bonni.finance.kontor.subledger.reported/v1",
    sourceModule: "app.hocketapp",
    sourceDomain: "hocket",
    targetModule: "app.kontorapp",
    targetDomain: "kontor",
  }),
  Object.freeze({
    protocol: "bonni.finance.kontor.subledger.reported/v1",
    sourceModule: "app.posapp",
    sourceDomain: "pos",
    targetModule: "app.kontorapp",
    targetDomain: "kontor",
  }),
]);

type DomainMessageHandlerInput = Readonly<{
  messageId: string;
  correlationId: string;
  protocol: string;
  sourceDomain: DataDomain;
  sourceRecordId: string | null;
  initiatedByAccountId: string | null;
  payloadHash: string;
  payload: Readonly<Record<string, unknown>>;
}>;

type DomainMessageHandlerResult = Readonly<{
  targetRecordId?: string | null;
  result?: unknown;
}> | void;

type DomainMessageHandler = (
  input: DomainMessageHandlerInput,
) => Promise<DomainMessageHandlerResult>;

type RegisteredHandler = {
  moduleKey: string;
  handler: DomainMessageHandler;
};

const handlers = new Map<string, RegisteredHandler>();
const deliveries = new Map<string, Promise<void>>();

function policyForPublishing(moduleKey: string, protocol: string) {
  const policy = protocolPolicies.find((entry) => (
    entry.sourceModule === moduleKey && entry.protocol === protocol
  ));
  if (!policy) throw new Error(`DOMAIN_MESSAGE_PROTOCOL_PUBLISH_DENIED:${moduleKey}:${protocol}`);
  return policy;
}

function policyForReceiving(moduleKey: string, protocol: string) {
  const policy = protocolPolicies.find((entry) => (
    entry.targetModule === moduleKey && entry.protocol === protocol
  ));
  if (!policy) throw new Error(`DOMAIN_MESSAGE_PROTOCOL_RECEIVE_DENIED:${moduleKey}:${protocol}`);
  return policy;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function canonicalPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("DOMAIN_MESSAGE_PAYLOAD_OBJECT_REQUIRED");
  }
  const serialized = JSON.stringify(canonicalize(payload));
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("DOMAIN_MESSAGE_PAYLOAD_TOO_LARGE");
  }
  return serialized;
}

function payloadHash(serialized: string) {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function encryptionKey(targetDomain: DataDomain, protocol: string) {
  return createHash("sha256")
    .update(env.MASTER_KEY, "utf8")
    .update("bonni:domain-message:v1", "utf8")
    .update(targetDomain, "utf8")
    .update(protocol, "utf8")
    .digest();
}

function payloadAad(input: {
  correlationId: string;
  protocol: string;
  sourceDomain: string;
  targetDomain: string;
}) {
  return Buffer.from([
    "bonni:domain-message:v1",
    input.correlationId,
    input.protocol,
    input.sourceDomain,
    input.targetDomain,
  ].join("\u0000"), "utf8");
}

function encryptPayload(serialized: string, metadata: Parameters<typeof payloadAad>[0]) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(metadata.targetDomain as DataDomain, metadata.protocol), iv);
  cipher.setAAD(payloadAad(metadata));
  const encrypted = Buffer.concat([cipher.update(serialized, "utf8"), cipher.final()]);
  return ["bdm1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptPayload(ciphertext: string, metadata: Parameters<typeof payloadAad>[0]) {
  const [version, iv, tag, encrypted] = ciphertext.split(".");
  if (version !== "bdm1" || !iv || !tag || !encrypted) {
    throw new Error("DOMAIN_MESSAGE_CIPHERTEXT_INVALID");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(metadata.targetDomain as DataDomain, metadata.protocol),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(payloadAad(metadata));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function cleanKey(value: unknown, label: string, maxLength = 200) {
  const result = String(value || "").trim();
  if (!result || result.length > maxLength || !/^[A-Za-z0-9._:/-]+$/.test(result)) {
    throw new Error(`DOMAIN_MESSAGE_${label}_INVALID`);
  }
  return result;
}

function publicMessage(message: Record<string, any>) {
  return Object.freeze({
    id: message.id,
    correlationId: message.correlationId,
    protocol: message.protocol,
    sourceDomain: message.sourceDomain,
    targetDomain: message.targetDomain,
    sourceRecordId: message.sourceRecordId,
    targetRecordId: message.targetRecordId,
    payloadHash: message.payloadHash,
    status: message.status,
    initiatedByAccountId: message.initiatedByAccountId,
    expiresAt: message.expiresAt,
    deliveredAt: message.deliveredAt,
    rejectedAt: message.rejectedAt,
    failedAt: message.failedAt,
    lastErrorCode: message.lastErrorCode,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  });
}

async function deliverMessage(prisma: PrismaClient, messageId: string) {
  const running = deliveries.get(messageId);
  if (running) return running;

  const delivery = (async () => {
    const initial = await prisma.domainMessage.findUnique({ where: { id: messageId } });
    if (!initial || initial.status !== "PENDING") return;
    if (initial.expiresAt.getTime() <= Date.now()) {
      await prisma.domainMessage.updateMany({
        where: { id: messageId, status: "PENDING" },
        data: { status: "EXPIRED", failedAt: new Date(), lastErrorCode: "DOMAIN_MESSAGE_EXPIRED" },
      });
      return;
    }

    const registered = handlers.get(initial.protocol);
    if (!registered) return;
    const claimed = await prisma.domainMessage.updateMany({
      where: { id: messageId, status: "PENDING" },
      data: { status: "DELIVERING", lastErrorCode: null },
    });
    if (claimed.count !== 1) return;

    const attemptNumber = await prisma.domainMessageAttempt.count({ where: { messageId } }) + 1;
    try {
      if (!initial.payloadCiphertext) throw new Error("DOMAIN_MESSAGE_PAYLOAD_MISSING");
      const serialized = decryptPayload(initial.payloadCiphertext, initial);
      if (payloadHash(serialized) !== initial.payloadHash) {
        throw new Error("DOMAIN_MESSAGE_PAYLOAD_HASH_MISMATCH");
      }
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      const result = await registered.handler(Object.freeze({
        messageId: initial.id,
        correlationId: initial.correlationId,
        protocol: initial.protocol,
        sourceDomain: initial.sourceDomain as DataDomain,
        sourceRecordId: initial.sourceRecordId,
        initiatedByAccountId: initial.initiatedByAccountId,
        payloadHash: initial.payloadHash,
        payload: Object.freeze(parsed),
      }));
      const resultSerialized = JSON.stringify(canonicalize(result?.result ?? null));
      await prisma.$transaction([
        prisma.domainMessageAttempt.create({
          data: {
            messageId,
            attemptNumber,
            decision: "DELIVERED",
            resultCode: "OK",
            resultHash: payloadHash(resultSerialized),
            remoteIdentity: registered.moduleKey,
          },
        }),
        prisma.domainMessage.update({
          where: { id: messageId },
          data: {
            status: "DELIVERED",
            targetRecordId: result?.targetRecordId || null,
            payloadCiphertext: null,
            deliveredAt: new Date(),
            lastErrorCode: null,
          },
        }),
      ]);
    } catch (error) {
      const code = String((error as { code?: unknown })?.code || (error as Error)?.message || "DOMAIN_MESSAGE_HANDLER_FAILED").slice(0, 180);
      const rejected = Number((error as { statusCode?: unknown })?.statusCode || 0) >= 400
        && Number((error as { statusCode?: unknown })?.statusCode || 0) < 500;
      await prisma.$transaction([
        prisma.domainMessageAttempt.create({
          data: {
            messageId,
            attemptNumber,
            decision: rejected ? "REJECTED" : "FAILED",
            resultCode: code,
            remoteIdentity: registered.moduleKey,
          },
        }),
        prisma.domainMessage.update({
          where: { id: messageId },
          data: rejected
            ? { status: "REJECTED", rejectedAt: new Date(), lastErrorCode: code }
            : { status: "FAILED", failedAt: new Date(), lastErrorCode: code },
        }),
      ]);
    }
  })().finally(() => deliveries.delete(messageId));

  deliveries.set(messageId, delivery);
  return delivery;
}

async function drainProtocol(prisma: PrismaClient, protocol: string) {
  await prisma.domainMessage.updateMany({
    where: {
      protocol,
      status: "DELIVERING",
      updatedAt: { lt: new Date(Date.now() - DELIVERY_LEASE_MS) },
    },
    data: { status: "PENDING", lastErrorCode: "DELIVERY_LEASE_RECOVERED" },
  });
  const pending = await prisma.domainMessage.findMany({
    where: { protocol, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true },
  });
  for (const message of pending) await deliverMessage(prisma, message.id);
}

export function createModuleDomainMessageRuntime(moduleKey: string, prisma: PrismaClient) {
  const sourceDomain = dataDomainForModule(moduleKey);
  const ownedSubscriptions = new Set<string>();

  return Object.freeze({
    contractVersion: DOMAIN_MESSAGE_CONTRACT_VERSION,
    async publish(input: {
      protocol: string;
      correlationId?: string;
      idempotencyKey: string;
      sourceRecordId?: string | null;
      payload: Record<string, unknown>;
      retentionSeconds?: number;
    }) {
      const protocol = cleanKey(input.protocol, "PROTOCOL", 180);
      const policy = policyForPublishing(moduleKey, protocol);
      if (policy.sourceDomain !== sourceDomain) throw new Error("DOMAIN_MESSAGE_SOURCE_DOMAIN_MISMATCH");
      const correlationId = input.correlationId
        ? cleanKey(input.correlationId, "CORRELATION_ID")
        : randomUUID();
      const rawIdempotencyKey = cleanKey(input.idempotencyKey, "IDEMPOTENCY_KEY");
      const idempotencyKey = createHash("sha256")
        .update(moduleKey)
        .update("\u0000")
        .update(rawIdempotencyKey)
        .digest("hex");
      const serialized = canonicalPayload(input.payload);
      const hash = payloadHash(serialized);
      const identity = getVerifiedRequestIdentity();
      const retentionSeconds = Math.min(
        Math.max(Number(input.retentionSeconds || 7 * 24 * 60 * 60), 60),
        MAX_RETENTION_SECONDS,
      );
      const metadata = {
        correlationId,
        protocol,
        sourceDomain,
        targetDomain: policy.targetDomain,
      };

      const existing = await prisma.domainMessage.findUnique({ where: { idempotencyKey } });
      if (existing) {
        if (existing.payloadHash !== hash || existing.protocol !== protocol) {
          throw Object.assign(new Error("DOMAIN_MESSAGE_IDEMPOTENCY_CONFLICT"), { statusCode: 409 });
        }
        void deliverMessage(prisma, existing.id);
        return publicMessage(existing as unknown as Record<string, any>);
      }

      const message = await prisma.domainMessage.create({
        data: {
          correlationId,
          idempotencyKey,
          protocol,
          sourceDomain,
          targetDomain: policy.targetDomain,
          sourceRecordId: input.sourceRecordId ? cleanKey(input.sourceRecordId, "SOURCE_RECORD_ID") : null,
          payloadCiphertext: encryptPayload(serialized, metadata),
          payloadHash: hash,
          initiatedByAccountId: identity?.accountId || null,
          expiresAt: new Date(Date.now() + retentionSeconds * 1000),
        },
      });
      void deliverMessage(prisma, message.id);
      return publicMessage(message as unknown as Record<string, any>);
    },
    subscribe(protocolValue: string, handler: DomainMessageHandler) {
      const protocol = cleanKey(protocolValue, "PROTOCOL", 180);
      policyForReceiving(moduleKey, protocol);
      if (typeof handler !== "function") throw new Error("DOMAIN_MESSAGE_HANDLER_REQUIRED");
      const existing = handlers.get(protocol);
      if (existing && existing.moduleKey !== moduleKey) {
        throw new Error(`DOMAIN_MESSAGE_HANDLER_ALREADY_REGISTERED:${protocol}`);
      }
      handlers.set(protocol, { moduleKey, handler });
      ownedSubscriptions.add(protocol);
      void drainProtocol(prisma, protocol);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        if (handlers.get(protocol)?.moduleKey === moduleKey) handlers.delete(protocol);
        ownedSubscriptions.delete(protocol);
      };
    },
    async get(messageId: string) {
      const id = cleanKey(messageId, "MESSAGE_ID");
      const message = await prisma.domainMessage.findUnique({ where: { id } });
      if (!message || (message.sourceDomain !== sourceDomain && message.targetDomain !== sourceDomain)) {
        return null;
      }
      return publicMessage(message as unknown as Record<string, any>);
    },
    async listByCorrelation(correlationIdValue: string) {
      const correlationId = cleanKey(correlationIdValue, "CORRELATION_ID");
      const messages = await prisma.domainMessage.findMany({
        where: {
          correlationId,
          OR: [{ sourceDomain }, { targetDomain: sourceDomain }],
        },
        orderBy: { createdAt: "asc" },
      });
      return messages.map((message) => publicMessage(message as unknown as Record<string, any>));
    },
    dispose() {
      for (const protocol of ownedSubscriptions) {
        if (handlers.get(protocol)?.moduleKey === moduleKey) handlers.delete(protocol);
      }
      ownedSubscriptions.clear();
    },
  });
}
