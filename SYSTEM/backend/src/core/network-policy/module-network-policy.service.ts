import type { PrismaClient } from "@prisma/client";

const EXPOSURES = new Set(["DISABLED", "LOCAL", "INTERNAL", "PUBLIC"]);
const DIRECTIONS = new Set(["INBOUND", "OUTBOUND"]);
const DECISIONS = new Set(["ALLOW", "DENY"]);

export type ModuleNetworkAuthorization = {
  moduleKey: string;
  direction: "INBOUND" | "OUTBOUND";
  protocol?: string | null;
  remoteHost?: string | null;
  remotePort?: number | null;
  route?: string | null;
  secure: boolean;
  sameOrganization?: boolean;
  accountId?: string | null;
  ipAddress?: string | null;
};

export type ModuleNetworkPolicyAuthorizer = (
  input: ModuleNetworkAuthorization,
) => Promise<void>;

class ModuleNetworkPolicyFailure extends Error {
  readonly statusCode = 403;

  constructor(readonly code: string) {
    super(code);
    this.name = "ModuleNetworkPolicyFailure";
  }
}

function normalizedModuleKey(value: unknown) {
  const key = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,159}$/.test(key)) {
    throw new ModuleNetworkPolicyFailure("MODULE_NETWORK_POLICY_KEY_INVALID");
  }
  return key;
}

function normalizedStringList(value: unknown, maximumEntries = 100) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumEntries) {
    throw new ModuleNetworkPolicyFailure("MODULE_NETWORK_POLICY_LIST_INVALID");
  }
  return [...new Set(value.map((entry) => String(entry ?? "").trim().toLowerCase()).filter(Boolean))]
    .map((entry) => {
      if (entry.length > 240 || /[\s\0]/.test(entry)) {
        throw new ModuleNetworkPolicyFailure("MODULE_NETWORK_POLICY_LIST_INVALID");
      }
      return entry;
    });
}

function jsonStringList(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").trim().toLowerCase()).filter(Boolean)
    : [];
}

function optionalText(value: unknown, maximumLength: number) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maximumLength) : null;
}

function hostMatches(allowedHosts: string[], remoteHost: string | null) {
  if (!allowedHosts.length) return true;
  if (!remoteHost) return false;
  const normalized = remoteHost.toLowerCase();
  return allowedHosts.some((allowed) => allowed === normalized);
}

function protocolMatches(allowedProtocols: string[], protocol: string | null) {
  if (!allowedProtocols.length) return true;
  if (!protocol) return false;
  return allowedProtocols.includes(protocol.toLowerCase());
}

async function recordObservation(
  prisma: PrismaClient,
  input: ModuleNetworkAuthorization,
  decision: "ALLOW" | "DENY",
  reason: string,
) {
  if (!DIRECTIONS.has(input.direction) || !DECISIONS.has(decision)) {
    throw new ModuleNetworkPolicyFailure("MODULE_NETWORK_OBSERVATION_INVALID");
  }
  await prisma.moduleNetworkObservation.create({
    data: {
      moduleKey: normalizedModuleKey(input.moduleKey),
      direction: input.direction,
      protocol: optionalText(input.protocol, 120),
      remoteHost: optionalText(input.remoteHost, 240),
      remotePort: Number.isInteger(input.remotePort) ? Number(input.remotePort) : null,
      route: optionalText(input.route, 500),
      decision,
      reason,
      accountId: optionalText(input.accountId, 160),
      ipAddress: optionalText(input.ipAddress, 160),
    },
  });
}

export function createModuleNetworkPolicyAuthorizer(
  prisma: PrismaClient,
): ModuleNetworkPolicyAuthorizer {
  return async (input) => {
    const moduleKey = normalizedModuleKey(input.moduleKey);
    const normalizedInput = { ...input, moduleKey };
    const policy = await prisma.moduleNetworkPolicy.findUnique({ where: { moduleKey } });

    let denialReason = "";
    if (!policy) {
      denialReason = "POLICY_NOT_CONFIGURED";
    } else if (policy.requireTls && !input.secure) {
      denialReason = "TLS_REQUIRED";
    } else if (!protocolMatches(jsonStringList(policy.allowedProtocols), optionalText(input.protocol, 120))) {
      denialReason = "PROTOCOL_NOT_ALLOWED";
    } else if (!hostMatches(jsonStringList(policy.allowedHosts), optionalText(input.remoteHost, 240))) {
      denialReason = "REMOTE_HOST_NOT_ALLOWED";
    } else if (input.direction === "OUTBOUND" && !policy.outboundEnabled) {
      denialReason = "OUTBOUND_DISABLED";
    } else if (input.direction === "INBOUND" && policy.exposure === "DISABLED") {
      denialReason = "INBOUND_DISABLED";
    } else if (input.direction === "INBOUND" && policy.exposure === "LOCAL" && !input.sameOrganization) {
      denialReason = "LOCAL_ONLY";
    }

    if (denialReason) {
      await recordObservation(prisma, normalizedInput, "DENY", denialReason);
      throw new ModuleNetworkPolicyFailure(`MODULE_NETWORK_DENIED:${denialReason}`);
    }

    await recordObservation(prisma, normalizedInput, "ALLOW", "POLICY_ALLOWED");
  };
}

export async function listModuleNetworkPolicies(prisma: PrismaClient) {
  const [modules, policies] = await Promise.all([
    prisma.installedModule.findMany({
      where: { deletedAt: null },
      select: { key: true, name: true, kind: true, status: true },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    }),
    prisma.moduleNetworkPolicy.findMany({ orderBy: { moduleKey: "asc" } }),
  ]);
  const byKey = new Map(policies.map((policy) => [policy.moduleKey, policy]));
  const moduleKeys = new Set(modules.map((module) => module.key));

  return [
    ...modules.map((module) => {
      const policy = byKey.get(module.key);
      return {
        ...module,
        exposure: policy?.exposure || "DISABLED",
        outboundEnabled: policy?.outboundEnabled || false,
        allowedHosts: jsonStringList(policy?.allowedHosts),
        allowedProtocols: jsonStringList(policy?.allowedProtocols),
        requireTls: policy?.requireTls ?? true,
        changedByAccountId: policy?.changedByAccountId || null,
        changedAt: policy?.changedAt || null,
        configured: Boolean(policy),
      };
    }),
    ...policies
      .filter((policy) => !moduleKeys.has(policy.moduleKey))
      .map((policy) => ({
        key: policy.moduleKey,
        name: policy.moduleKey,
        kind: "UNKNOWN",
        status: "UNINSTALLED",
        exposure: policy.exposure,
        outboundEnabled: policy.outboundEnabled,
        allowedHosts: jsonStringList(policy.allowedHosts),
        allowedProtocols: jsonStringList(policy.allowedProtocols),
        requireTls: policy.requireTls,
        changedByAccountId: policy.changedByAccountId,
        changedAt: policy.changedAt,
        configured: true,
      })),
  ];
}

export async function updateModuleNetworkPolicy(
  prisma: PrismaClient,
  moduleKeyValue: unknown,
  input: Record<string, unknown>,
  changedByAccountId: string,
) {
  const moduleKey = normalizedModuleKey(moduleKeyValue);
  const module = await prisma.installedModule.findUnique({ where: { key: moduleKey }, select: { key: true } });
  if (!module) throw new ModuleNetworkPolicyFailure("MODULE_NETWORK_MODULE_NOT_FOUND");

  const exposure = String(input.exposure ?? "DISABLED").trim().toUpperCase();
  if (!EXPOSURES.has(exposure)) {
    throw new ModuleNetworkPolicyFailure("MODULE_NETWORK_EXPOSURE_INVALID");
  }
  if (typeof input.outboundEnabled !== "boolean" || typeof input.requireTls !== "boolean") {
    throw new ModuleNetworkPolicyFailure("MODULE_NETWORK_POLICY_BOOLEAN_INVALID");
  }
  const allowedHosts = normalizedStringList(input.allowedHosts) || [];
  const allowedProtocols = normalizedStringList(input.allowedProtocols) || [];
  const changedAt = new Date();

  return prisma.moduleNetworkPolicy.upsert({
    where: { moduleKey },
    create: {
      moduleKey,
      exposure: exposure as "DISABLED" | "LOCAL" | "INTERNAL" | "PUBLIC",
      outboundEnabled: input.outboundEnabled,
      allowedHosts,
      allowedProtocols,
      requireTls: input.requireTls,
      changedByAccountId,
      changedAt,
    },
    update: {
      exposure: exposure as "DISABLED" | "LOCAL" | "INTERNAL" | "PUBLIC",
      outboundEnabled: input.outboundEnabled,
      allowedHosts,
      allowedProtocols,
      requireTls: input.requireTls,
      changedByAccountId,
      changedAt,
    },
  });
}

export async function listModuleNetworkObservations(
  prisma: PrismaClient,
  input: { moduleKey?: unknown; decision?: unknown; limit?: unknown } = {},
) {
  const moduleKey = input.moduleKey ? normalizedModuleKey(input.moduleKey) : undefined;
  const decision = input.decision ? String(input.decision).trim().toUpperCase() : undefined;
  if (decision && !DECISIONS.has(decision)) {
    throw new ModuleNetworkPolicyFailure("MODULE_NETWORK_DECISION_INVALID");
  }
  const limit = Math.max(1, Math.min(500, Number(input.limit) || 100));
  return prisma.moduleNetworkObservation.findMany({
    where: {
      ...(moduleKey ? { moduleKey } : {}),
      ...(decision ? { decision } : {}),
    },
    orderBy: { observedAt: "desc" },
    take: limit,
  });
}
