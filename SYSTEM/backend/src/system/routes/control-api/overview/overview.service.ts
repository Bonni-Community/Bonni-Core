import os from "node:os";
import { statfsSync } from "node:fs";

import { getPrismaClient } from "../../../../core/database/database.js";
import { getRuntimeLiveStatus } from "../../../runtime/index.js";
import { getLicenseStatus } from "../../../../platform/module-manager/licensing/index.js";
import { capacityUsage, getCpuMeasurement, getMemoryStatus, resourcePercent } from "../monitoring/resource.service.js";

type RawCountRow = Record<string, unknown>;

function toNumber(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function round(value: number, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getCpuStatus() {
  const measured = getCpuMeasurement();
  const cores = Math.max(1, measured.cores);
  const loadAverage = os.loadavg();
  return {
    model: measured.model,
    cores,
    percent: measured.percent ?? resourcePercent(100 * (loadAverage[0] || 0) / cores),
    source: measured.percent === null ? "load-average" : measured.source,
    loadAverage: loadAverage.map(value => round(value, 2)),
  };
}

function getStorageStatus() {
  try {
    const stats = statfsSync(process.cwd());
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return {
      path: process.cwd(),
      ...capacityUsage(totalBytes, freeBytes),
      available: true,
    };
  } catch (error) {
    return {
      path: process.cwd(),
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      percent: 0,
      available: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function databaseVersionLabel(version: string | null) {
  if (!version) return "Nicht verfügbar";
  const match = version.match(/PostgreSQL\s+([^\s]+)/i);
  return match ? `PostgreSQL ${match[1]}` : version.split(",")[0] || version;
}

function licenseTypeLabel(type?: string) {
  if (type === "commercial") return "Commercial";
  if (type === "development") return "Development";
  if (type === "community") return "Community";
  return "Lizenz";
}

async function getLicenseSummary() {
  try {
    const status = await getLicenseStatus();
    const type = status.license?.licenseType || "community";

    return {
      active: status.active,
      valid: status.valid,
      type,
      label: status.valid ? licenseTypeLabel(type) : status.active ? "Lizenz prüfen" : "Community",
      customerName: status.license?.customerName,
      validUntil: status.license?.validUntil,
      reason: status.reason,
      checkedAt: status.checkedAt,
    };
  } catch (error) {
    return {
      active: false,
      valid: false,
      type: "unknown",
      label: "Lizenz n/v",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getDatabaseStatus(prisma: ReturnType<typeof getPrismaClient>) {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ version: string }>>(
      `SELECT version() AS "version"`,
    );
    const version = rows[0]?.version || null;

    return {
      online: true,
      version,
      label: databaseVersionLabel(version),
      message: "Datenbankverbindung OK",
    };
  } catch (error) {
    return {
      online: false,
      version: null,
      label: "Offline",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getActiveSessionCount(prisma: ReturnType<typeof getPrismaClient>) {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ activeSessions: unknown }>>(
      `SELECT COUNT(*)::int AS "activeSessions" FROM "Session" WHERE "endedAt" IS NULL`,
    );

    return toNumber(rows[0]?.activeSessions, 0);
  } catch {
    return null;
  }
}

async function getMemberProfileStats(prisma: ReturnType<typeof getPrismaClient>) {
  const rows = await prisma.$queryRawUnsafe<Array<RawCountRow>>(
    `SELECT
       COUNT(*)::int AS "created",
       COUNT(*) FILTER (WHERE "status" = 'MEMBER' AND "leftAt" IS NULL)::int AS "active"
     FROM "MemberProfile"`,
  );

  const created = toNumber(rows[0]?.created, 0);
  const active = toNumber(rows[0]?.active, 0);

  return {
    created,
    active,
    inactive: Math.max(0, created - active),
    source: "MemberProfile",
  };
}

async function getMemberAccountStats(prisma: ReturnType<typeof getPrismaClient>) {
  const rows = await prisma.$queryRawUnsafe<Array<RawCountRow>>(
    `SELECT
       COUNT(*) FILTER (WHERE "type" = 'MEMBER')::int AS "created",
       COUNT(*) FILTER (WHERE "type" = 'MEMBER' AND "isActive" = true)::int AS "active"
     FROM "Account"`,
  );

  const created = toNumber(rows[0]?.created, 0);
  const active = toNumber(rows[0]?.active, 0);

  return {
    created,
    active,
    inactive: Math.max(0, created - active),
    source: "Account",
  };
}

async function getMemberStats(prisma: ReturnType<typeof getPrismaClient>) {
  const activeSessions = await getActiveSessionCount(prisma);

  try {
    const profileStats = await getMemberProfileStats(prisma);
    return {
      ...profileStats,
      activeSessions,
      available: true,
    };
  } catch (profileError) {
    try {
      const accountStats = await getMemberAccountStats(prisma);
      return {
        ...accountStats,
        activeSessions,
        available: true,
      };
    } catch (accountError) {
      const message = accountError instanceof Error
        ? accountError.message
        : profileError instanceof Error
          ? profileError.message
          : "Member-Statistik nicht verfügbar";

      return {
        created: 0,
        active: 0,
        inactive: 0,
        activeSessions,
        source: "none",
        available: false,
        message,
      };
    }
  }
}

function createShellLines(input: {
  backendOnline: boolean;
  uptimeSeconds: number;
  databaseLabel: string;
  databaseOnline: boolean;
  membersCreated: number;
  membersActive: number;
  cpuPercent: number;
  ramPercent: number;
}) {
  return [
    "system ~ # status --summary",
    `Backend: ${input.backendOnline ? "online" : "offline"} | Uptime: ${input.uptimeSeconds}s`,
    `Datenbank: ${input.databaseOnline ? "online" : "offline"} | ${input.databaseLabel}`,
    `Member: ${input.membersCreated} erstellt | ${input.membersActive} aktiv`,
    `CPU: ${input.cpuPercent}% | RAM: ${input.ramPercent}%`,
    "system ~ # health --check",
    input.databaseOnline ? "Datenbankverbindung OK" : "Datenbankverbindung FEHLER",
    "system ~ #",
  ];
}

export async function getSystemOverview() {
  const checkedAt = new Date();
  const live = getRuntimeLiveStatus();
  const prisma = getPrismaClient();
  const [database, members, license] = await Promise.all([
    getDatabaseStatus(prisma),
    getMemberStats(prisma),
    getLicenseSummary(),
  ]);
  const cpu = getCpuStatus();
  const memory = getMemoryStatus();
  const storage = getStorageStatus();

  return {
    ok: true,
    area: "overview",
    checkedAt: checkedAt.toISOString(),
    backend: {
      online: true,
      version: live.runtime.version,
      startedAt: live.runtime.startedAt,
      uptimeSeconds: live.runtime.uptimeSeconds,
      pid: live.runtime.pid,
      node: process.version,
    },
    database,
    license,
    members,
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpu,
      memory,
      storage,
    },
    shell: createShellLines({
      backendOnline: true,
      uptimeSeconds: live.runtime.uptimeSeconds,
      databaseLabel: database.label,
      databaseOnline: database.online,
      membersCreated: members.created,
      membersActive: members.active,
      cpuPercent: cpu.percent,
      ramPercent: memory.percent,
    }),
  };
}
