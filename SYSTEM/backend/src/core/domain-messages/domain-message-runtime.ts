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
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_DELIVERY_ATTEMPTS_ERROR = "DOMAIN_MESSAGE_MAX_ATTEMPTS_REACHED";
const DELIVERY_LEASE_MS = 5 * 60 * 1000;
const DRAIN_BATCH_SIZE = 100;
const MAX_DRAIN_BATCHES = 100;
const DEFAULT_RETRY_BACKOFF_MS = 30 * 1000;
const DEFAULT_RETRY_SWEEP_INTERVAL_MS = 5 * 1000;
const MIN_RETRY_TIMER_MS = 10;
const MAX_RETRY_TIMER_MS = 60 * 60 * 1000;

const durableSettlementProtocols = new Set<string>([
  "bonni.finance.kontor.account-operation.requested/v1",
  "bonni.finance.stueberl.account-operation.updated/v1",
  "bonni.finance.stueberl.settlement.updated/v2",
  "bonni.finance.kontor.receivable.requested/v2",
  "bonni.finance.kontor.receivable.requested/v1",
  "bonni.finance.kontor.cash-payment.reported/v1",
  "bonni.finance.kontor.card-payment.reported/v1",
  "bonni.finance.stueberl.settlement.updated/v1",
  "bonni.finance.kontor.hocket-settlement.released/v1",
  "bonni.finance.hocket.settlement.updated/v1",
]);

type DomainMessageRuntimeOptions = Readonly<{
  retryBackoffMs?: number;
  retrySweepIntervalMs?: number;
}>;

type ProtocolPolicy = Readonly<{
  protocol: string;
  sourceModule: string;
  sourceDomain: DataDomain;
  targetModule: string;
  targetDomain: DataDomain;
}>;

const protocolPolicies: readonly ProtocolPolicy[] = Object.freeze([
  Object.freeze({
    protocol: "bonni.finance.kontor.account-operation.requested/v1",
    sourceModule: "app.stueberlapp",
    sourceDomain: "stueberl",
    targetModule: "app.kontorapp",
    targetDomain: "kontor",
  }),
  Object.freeze({
    protocol: "bonni.finance.stueberl.account-operation.updated/v1",
    sourceModule: "app.kontorapp",
    sourceDomain: "kontor",
    targetModule: "app.stueberlapp",
    targetDomain: "stueberl",
  }),
  Object.freeze({
    protocol: "bonni.finance.stueberl.settlement.updated/v2",
    sourceModule: "app.kontorapp",
    sourceDomain: "kontor",
    targetModule: "app.stueberlapp",
    targetDomain: "stueberl",
  }),
  Object.freeze({
    protocol: "bonni.finance.stueberl.history.requested/v1",
    sourceModule: "app.kontorapp", sourceDomain: "kontor",
    targetModule: "app.stueberlapp", targetDomain: "stueberl",
  }),
  Object.freeze({
    protocol: "bonni.finance.kontor.history.page/v1",
    sourceModule: "app.stueberlapp", sourceDomain: "stueberl",
    targetModule: "app.kontorapp", targetDomain: "kontor",
  }),
  Object.freeze({
    protocol: "bonni.finance.kontor.receivable.requested/v2",
    sourceModule: "app.stueberlapp", sourceDomain: "stueberl",
    targetModule: "app.kontorapp", targetDomain: "kontor",
  }),
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
    sourceModule: "app.posapp",
    sourceDomain: "pos",
    targetModule: "app.kontorapp",
    targetDomain: "kontor",
  }),
  Object.freeze({
    protocol: "bonni.finance.kontor.receivable.requested/v1",
    sourceModule: "app.stueberlapp",
    sourceDomain: "stueberl",
    targetModule: "app.kontorapp",
    targetDomain: "kontor",
  }),
  Object.freeze({
    protocol: "bonni.finance.kontor.cash-payment.reported/v1",
    sourceModule: "app.stueberlapp",
    sourceDomain: "stueberl",
    targetModule: "app.kontorapp",
    targetDomain: "kontor",
  }),
  Object.freeze({
    protocol: "bonni.finance.kontor.card-payment.reported/v1",
    sourceModule: "app.jeldapp",
    sourceDomain: "pos",
    targetModule: "app.kontorapp",
    targetDomain: "kontor",
  }),
  Object.freeze({
    protocol: "bonni.finance.stueberl.settlement.updated/v1",
    sourceModule: "app.kontorapp",
    sourceDomain: "kontor",
    targetModule: "app.stueberlapp",
    targetDomain: "stueberl",
  }),
  Object.freeze({
    protocol: "bonni.finance.kontor.hocket-settlement.released/v1",
    sourceModule: "app.hocketapp",
    sourceDomain: "hocket",
    targetModule: "app.kontorapp",
    targetDomain: "kontor",
  }),
  Object.freeze({
    protocol: "bonni.finance.hocket.settlement.updated/v1",
    sourceModule: "app.kontorapp",
    sourceDomain: "kontor",
    targetModule: "app.hocketapp",
    targetDomain: "hocket",
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

function isDurableSettlementProtocol(protocol: string) {
  return durableSettlementProtocols.has(protocol);
}

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

function canonicalPayload(payload: unknown, protocol?: string) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("DOMAIN_MESSAGE_PAYLOAD_OBJECT_REQUIRED");
  }
  const serialized = JSON.stringify(canonicalize(payload));
  const limit = ["bonni.finance.kontor.receivable.requested/v2", "bonni.finance.kontor.history.page/v1"].includes(protocol || "") ? 512 * 1024 : MAX_PAYLOAD_BYTES;
  if (Buffer.byteLength(serialized, "utf8") > limit) {
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

async function deliverMessage(
  prisma: PrismaClient,
  messageId: string,
  expectedHandler?: RegisteredHandler,
) {
  const running = deliveries.get(messageId);
  if (running) return running;

  const delivery = (async () => {
    const initial = await prisma.domainMessage.findUnique({ where: { id: messageId } });
    if (!initial || initial.status !== "PENDING") return;
    if (initial.expiresAt.getTime() <= Date.now()) {
      await prisma.domainMessage.updateMany({
        where: { id: messageId, status: "PENDING" },
        data: {
          status: "EXPIRED",
          payloadCiphertext: null,
          failedAt: new Date(),
          lastErrorCode: "DOMAIN_MESSAGE_EXPIRED",
        },
      });
      return;
    }

    const registered = handlers.get(initial.protocol);
    if (!registered || (expectedHandler && registered !== expectedHandler)) return;
    const claimed = await prisma.domainMessage.updateMany({
      where: { id: messageId, status: "PENDING" },
      data: { status: "DELIVERING", lastErrorCode: null },
    });
    if (claimed.count !== 1) return;
    if (handlers.get(initial.protocol) !== registered) {
      await prisma.domainMessage.updateMany({
        where: { id: messageId, status: "DELIVERING" },
        data: { status: "PENDING", lastErrorCode: "DOMAIN_MESSAGE_HANDLER_REVOKED" },
      });
      return;
    }

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
      const exhausted = !rejected
        && !isDurableSettlementProtocol(initial.protocol)
        && attemptNumber >= MAX_DELIVERY_ATTEMPTS;
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
            ? {
                status: "REJECTED",
                payloadCiphertext: null,
                rejectedAt: new Date(),
                lastErrorCode: code,
              }
            : {
                status: "FAILED",
                ...(exhausted ? { payloadCiphertext: null } : {}),
                failedAt: new Date(),
                lastErrorCode: exhausted ? MAX_DELIVERY_ATTEMPTS_ERROR : code,
              },
        }),
      ]);
    }
  })().finally(() => deliveries.delete(messageId));

  deliveries.set(messageId, delivery);
  return delivery;
}

async function drainProtocol(
  prisma: PrismaClient,
  protocol: string,
  isActive: () => boolean = () => true,
  expectedHandler?: RegisteredHandler,
) {
  if (!isActive()) return;
  await prisma.domainMessage.updateMany({
    where: {
      protocol,
      status: "DELIVERING",
      updatedAt: { lt: new Date(Date.now() - DELIVERY_LEASE_MS) },
    },
    data: { status: "PENDING", lastErrorCode: "DELIVERY_LEASE_RECOVERED" },
  });
  if (!isActive()) return;
  // Drain more than one page, but keep a hard per-run bound. The bound stops a
  // continuously producing publisher (or a handler removed mid-drain) from
  // keeping the module subscription call alive forever.
  for (let batch = 0; batch < MAX_DRAIN_BATCHES; batch += 1) {
    if (!isActive()) return;
    const pending = await prisma.domainMessage.findMany({
      where: { protocol, status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: DRAIN_BATCH_SIZE,
      select: { id: true },
    });
    if (pending.length === 0) return;
    for (const message of pending) {
      if (!isActive()) return;
      await deliverMessage(prisma, message.id, expectedHandler);
    }
    if (pending.length < DRAIN_BATCH_SIZE) return;
  }
}

async function retryFailedProtocol(
  prisma: PrismaClient,
  protocol: string,
  retryBackoffMs: number,
  isActive: () => boolean,
  expectedHandler?: RegisteredHandler,
) {
  if (!isActive()) return;
  const now = new Date();
  const eligibleBefore = new Date(now.getTime() - retryBackoffMs);
  const durable = isDurableSettlementProtocol(protocol);
  await prisma.domainMessage.updateMany({
    where: { protocol, status: "FAILED", expiresAt: { lte: now } },
    data: {
      status: "EXPIRED",
      payloadCiphertext: null,
      failedAt: now,
      lastErrorCode: "DOMAIN_MESSAGE_EXPIRED",
    },
  });
  if (!isActive()) return;
  const candidates = await prisma.domainMessage.findMany({
    where: {
      protocol,
      status: "FAILED",
      failedAt: { lte: eligibleBefore },
      expiresAt: { gt: now },
      ...(durable ? {} : { lastErrorCode: { not: MAX_DELIVERY_ATTEMPTS_ERROR } }),
    },
    orderBy: { failedAt: "asc" },
    take: DRAIN_BATCH_SIZE,
    select: { id: true },
  });
  for (const candidate of candidates) {
    if (!isActive()) return;
    const attemptCount = await prisma.domainMessageAttempt.count({
      where: { messageId: candidate.id },
    });
    if (!isActive()) return;
    if (!durable && attemptCount >= MAX_DELIVERY_ATTEMPTS) {
      await prisma.domainMessage.updateMany({
        where: { id: candidate.id, status: "FAILED" },
        data: {
          payloadCiphertext: null,
          lastErrorCode: MAX_DELIVERY_ATTEMPTS_ERROR,
        },
      });
      continue;
    }
    if (!isActive()) return;
    const claimed = await prisma.domainMessage.updateMany({
      where: {
        id: candidate.id,
        protocol,
        status: "FAILED",
        failedAt: { lte: eligibleBefore },
        expiresAt: { gt: now },
      },
      data: { status: "PENDING", failedAt: null, lastErrorCode: null },
    });
    if (claimed.count === 1 && isActive()) {
      await deliverMessage(prisma, candidate.id, expectedHandler);
    }
  }
}

function retryTimerMs(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), MIN_RETRY_TIMER_MS), MAX_RETRY_TIMER_MS);
}

type DomainMessagePublishInput = Readonly<{
  protocol: string;
  correlationId?: string;
  idempotencyKey: string;
  sourceRecordId?: string | null;
  payload: Record<string, unknown>;
  retentionSeconds?: number;
}>;

type PendingDomainMessageSubscription = {
  protocol: string;
  registration: RegisteredHandler;
  stopDelivery?: () => void;
  released: boolean;
};

function runtimeStateError(code: string) {
  return Object.assign(new Error(code), { code, statusCode: 503 });
}

function idempotencyConflict(): never {
  throw Object.assign(new Error("DOMAIN_MESSAGE_IDEMPOTENCY_CONFLICT"), {
    code: "DOMAIN_MESSAGE_IDEMPOTENCY_CONFLICT",
    statusCode: 409,
  });
}

function isUniqueConstraintError(error: unknown) {
  return String((error as { code?: unknown })?.code || "") === "P2002";
}

async function publishDomainMessage(
  moduleKey: string,
  prisma: PrismaClient,
  sourceDomain: DataDomain,
  input: DomainMessagePublishInput,
) {
  const protocol = cleanKey(input.protocol, "PROTOCOL", 180);
  const policy = policyForPublishing(moduleKey, protocol);
  if (policy.sourceDomain !== sourceDomain) throw new Error("DOMAIN_MESSAGE_SOURCE_DOMAIN_MISMATCH");
  const requestedCorrelationId = input.correlationId
    ? cleanKey(input.correlationId, "CORRELATION_ID")
    : null;
  const sourceRecordId = input.sourceRecordId
    ? cleanKey(input.sourceRecordId, "SOURCE_RECORD_ID")
    : null;
  const rawIdempotencyKey = cleanKey(input.idempotencyKey, "IDEMPOTENCY_KEY");
  const idempotencyKey = createHash("sha256")
    .update(moduleKey)
    .update("\u0000")
    .update(rawIdempotencyKey)
    .digest("hex");
  const serialized = canonicalPayload(input.payload, input.protocol);
  const hash = payloadHash(serialized);
  const durable = isDurableSettlementProtocol(protocol);

  const reuseExisting = async (existing: Record<string, any>) => {
    if (
      existing.payloadHash !== hash
      || existing.protocol !== protocol
      || existing.sourceDomain !== sourceDomain
      || existing.targetDomain !== policy.targetDomain
      || (existing.sourceRecordId ?? null) !== sourceRecordId
      || (requestedCorrelationId !== null && existing.correlationId !== requestedCorrelationId)
    ) {
      idempotencyConflict();
    }
    let current = existing;
    if (existing.status === "FAILED") {
      if (existing.expiresAt.getTime() <= Date.now()) {
        await prisma.domainMessage.updateMany({
          where: { id: existing.id, status: "FAILED" },
          data: {
            status: "EXPIRED",
            payloadCiphertext: null,
            failedAt: new Date(),
            lastErrorCode: "DOMAIN_MESSAGE_EXPIRED",
          },
        });
        current = await prisma.domainMessage.findUnique({ where: { id: existing.id } }) || existing;
      } else {
        const attemptCount = await prisma.domainMessageAttempt.count({
          where: { messageId: existing.id },
        });
        if ((durable || attemptCount < MAX_DELIVERY_ATTEMPTS) && existing.payloadCiphertext) {
          await prisma.domainMessage.updateMany({
            where: { id: existing.id, status: "FAILED" },
            data: { status: "PENDING", failedAt: null, lastErrorCode: null },
          });
          current = await prisma.domainMessage.findUnique({ where: { id: existing.id } }) || existing;
        } else {
          await prisma.domainMessage.updateMany({
            where: { id: existing.id, status: "FAILED" },
            data: {
              payloadCiphertext: null,
              lastErrorCode: MAX_DELIVERY_ATTEMPTS_ERROR,
            },
          });
          current = await prisma.domainMessage.findUnique({ where: { id: existing.id } }) || existing;
        }
      }
    }
    void deliverMessage(prisma, current.id).catch(() => undefined);
    return publicMessage(current as Record<string, any>);
  };

  const existing = await prisma.domainMessage.findUnique({ where: { idempotencyKey } });
  if (existing) return reuseExisting(existing as unknown as Record<string, any>);

  const correlationId = requestedCorrelationId || randomUUID();
  const identity = getVerifiedRequestIdentity();
  const retentionSeconds = durable
    ? MAX_RETENTION_SECONDS
    : Math.min(
        Math.max(Number(input.retentionSeconds || 7 * 24 * 60 * 60), 60),
        MAX_RETENTION_SECONDS,
      );
  const metadata = {
    correlationId,
    protocol,
    sourceDomain,
    targetDomain: policy.targetDomain,
  };

  let message;
  try {
    message = await prisma.domainMessage.create({
      data: {
        correlationId,
        idempotencyKey,
        protocol,
        sourceDomain,
        targetDomain: policy.targetDomain,
        sourceRecordId,
        payloadCiphertext: encryptPayload(serialized, metadata),
        payloadHash: hash,
        initiatedByAccountId: identity?.accountId || null,
        expiresAt: new Date(Date.now() + retentionSeconds * 1000),
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await prisma.domainMessage.findUnique({ where: { idempotencyKey } });
    if (!raced) throw error;
    return reuseExisting(raced as unknown as Record<string, any>);
  }
  void deliverMessage(prisma, message.id).catch(() => undefined);
  return publicMessage(message as unknown as Record<string, any>);
}

function startSubscriptionDelivery(
  prisma: PrismaClient,
  protocol: string,
  registration: RegisteredHandler,
  retryBackoffMs: number,
  retrySweepIntervalMs: number,
  ownerActive: () => boolean,
) {
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const isActive = () => (
    running
    && ownerActive()
    && handlers.get(protocol) === registration
  );
  const schedule = () => {
    if (!isActive()) return;
    timer = setTimeout(() => {
      timer = null;
      void retryFailedProtocol(
        prisma,
        protocol,
        retryBackoffMs,
        isActive,
        registration,
      )
        .then(() => (
          isActive()
            ? drainProtocol(prisma, protocol, isActive, registration)
            : undefined
        ))
        .catch(() => undefined)
        .finally(() => {
          if (isActive()) schedule();
        });
    }, retrySweepIntervalMs);
    timer.unref?.();
  };
  void drainProtocol(prisma, protocol, isActive, registration).catch(() => undefined);
  schedule();
  return () => {
    if (!running) return;
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

function createDomainMessageRuntimeController(
  moduleKey: string,
  prisma: PrismaClient,
  options: DomainMessageRuntimeOptions,
  initiallyActive: boolean,
) {
  const sourceDomain = dataDomainForModule(moduleKey);
  const subscriptions = new Map<string, PendingDomainMessageSubscription>();
  const retryBackoffMs = retryTimerMs(options.retryBackoffMs, DEFAULT_RETRY_BACKOFF_MS);
  const retrySweepIntervalMs = retryTimerMs(
    options.retrySweepIntervalMs,
    DEFAULT_RETRY_SWEEP_INTERVAL_MS,
  );
  let active = initiallyActive;
  let disposed = false;

  const ensureUsable = () => {
    if (disposed) throw runtimeStateError("DOMAIN_MESSAGE_RUNTIME_DISPOSED");
  };
  const ensureActive = () => {
    ensureUsable();
    if (!active) throw runtimeStateError("DOMAIN_MESSAGE_RUNTIME_NOT_ACTIVE");
  };

  const releaseSubscription = (entry: PendingDomainMessageSubscription) => {
    if (entry.released) return;
    entry.released = true;
    if (subscriptions.get(entry.protocol) === entry) subscriptions.delete(entry.protocol);
    entry.stopDelivery?.();
    entry.stopDelivery = undefined;
    if (handlers.get(entry.protocol) === entry.registration) handlers.delete(entry.protocol);
  };

  const registerSubscription = (entry: PendingDomainMessageSubscription) => {
    if (handlers.has(entry.protocol)) {
      throw new Error(`DOMAIN_MESSAGE_HANDLER_ALREADY_REGISTERED:${entry.protocol}`);
    }
    handlers.set(entry.protocol, entry.registration);
  };

  const startSubscription = (entry: PendingDomainMessageSubscription) => {
    entry.stopDelivery = startSubscriptionDelivery(
      prisma,
      entry.protocol,
      entry.registration,
      retryBackoffMs,
      retrySweepIntervalMs,
      () => active && !disposed && subscriptions.get(entry.protocol) === entry,
    );
  };

  const activate = () => {
    ensureUsable();
    if (active) return;
    const entries = [...subscriptions.values()].filter((entry) => !entry.released);
    for (const entry of entries) {
      if (handlers.has(entry.protocol)) {
        throw new Error(`DOMAIN_MESSAGE_HANDLER_ALREADY_REGISTERED:${entry.protocol}`);
      }
    }
    const registered: PendingDomainMessageSubscription[] = [];
    try {
      for (const entry of entries) {
        registerSubscription(entry);
        registered.push(entry);
      }
      active = true;
      for (const entry of entries) startSubscription(entry);
    } catch (error) {
      active = false;
      for (const entry of registered.reverse()) {
        entry.stopDelivery?.();
        entry.stopDelivery = undefined;
        if (handlers.get(entry.protocol) === entry.registration) handlers.delete(entry.protocol);
      }
      throw error;
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    active = false;
    for (const entry of [...subscriptions.values()].reverse()) releaseSubscription(entry);
    subscriptions.clear();
  };

  const runtime = Object.freeze({
    contractVersion: DOMAIN_MESSAGE_CONTRACT_VERSION,
    async publish(input: DomainMessagePublishInput) {
      ensureActive();
      return publishDomainMessage(moduleKey, prisma, sourceDomain, input);
    },
    subscribe(protocolValue: string, handler: DomainMessageHandler) {
      ensureUsable();
      const protocol = cleanKey(protocolValue, "PROTOCOL", 180);
      policyForReceiving(moduleKey, protocol);
      if (typeof handler !== "function") throw new Error("DOMAIN_MESSAGE_HANDLER_REQUIRED");
      if (subscriptions.has(protocol)) {
        throw new Error(`DOMAIN_MESSAGE_HANDLER_ALREADY_REGISTERED:${protocol}`);
      }
      let entry: PendingDomainMessageSubscription;
      const registration: RegisteredHandler = {
        moduleKey,
        handler: async (input) => {
          if (
            !active
            || disposed
            || subscriptions.get(protocol) !== entry
            || handlers.get(protocol) !== registration
          ) {
            throw runtimeStateError("DOMAIN_MESSAGE_RUNTIME_NOT_ACTIVE");
          }
          return handler(input);
        },
      };
      entry = { protocol, registration, released: false };
      subscriptions.set(protocol, entry);
      try {
        if (active) {
          registerSubscription(entry);
          startSubscription(entry);
        }
      } catch (error) {
        releaseSubscription(entry);
        throw error;
      }
      return () => releaseSubscription(entry);
    },
    async get(messageId: string) {
      ensureActive();
      const id = cleanKey(messageId, "MESSAGE_ID");
      const message = await prisma.domainMessage.findUnique({ where: { id } });
      if (!message || (message.sourceDomain !== sourceDomain && message.targetDomain !== sourceDomain)) {
        return null;
      }
      return publicMessage(message as unknown as Record<string, any>);
    },
    async listByCorrelation(correlationIdValue: string) {
      ensureActive();
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
    dispose,
  });

  return Object.freeze({ runtime, activate, dispose });
}

export function createStagedModuleDomainMessageRuntime(
  moduleKey: string,
  prisma: PrismaClient,
  options: DomainMessageRuntimeOptions = {},
) {
  return createDomainMessageRuntimeController(moduleKey, prisma, options, false);
}

export function createModuleDomainMessageRuntime(
  moduleKey: string,
  prisma: PrismaClient,
  options: DomainMessageRuntimeOptions = {},
) {
  return createDomainMessageRuntimeController(moduleKey, prisma, options, true).runtime;
}
