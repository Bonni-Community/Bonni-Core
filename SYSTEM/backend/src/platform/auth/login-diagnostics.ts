import { getServerPrismaClient } from "../../core/database/database.js";

const prisma = getServerPrismaClient("core");
const CATEGORY = "CORE_LOGIN";
const RETENTION_MS = 72 * 60 * 60 * 1000;
const READ_LIMIT = 200;
const outcomes = [
  "LOGIN_SUCCESS",
  "INVALID_PASSWORD",
  "ACCOUNT_NOT_FOUND",
  "ACCOUNT_DISABLED",
  "PASSWORD_NOT_CONFIGURED",
  "PASSWORD_RECOVERY_LOCKED",
  "SERVICE_ACCOUNT_INTERACTIVE_LOGIN_FORBIDDEN",
] as const;

type LoginOutcome = typeof outcomes[number];

function retentionCutoff() {
  return new Date(Date.now() - RETENTION_MS);
}

/** Record only Core's outcome and the ID of an account found by Core. */
export async function recordLoginDiagnostic(outcome: LoginOutcome, accountId?: string) {
  const data = {
    category: CATEGORY,
    severity: outcome === "LOGIN_SUCCESS" ? "INFO" as const : "WARN" as const,
    event: outcome,
    accountId,
  };
  try {
    if (!accountId) {
      await prisma.securityLog.create({ data });
      return;
    }

    // The erasure transaction removes SecurityLog entries by account ID.
    // Recheck the account in a serializable write to avoid reintroducing a
    // reference if account erasure and login happen concurrently.
    await prisma.$transaction(async transaction => {
      const account = await transaction.account.findUnique({ where: { id: accountId }, select: { id: true } });
      if (account) await transaction.securityLog.create({ data });
    }, { isolationLevel: "Serializable" });
  } catch {
    // A failed diagnostic write must not change the authentication result.
  }
}

export async function readLoginDiagnostics() {
  const rows = await prisma.securityLog.findMany({
    where: { category: CATEGORY, event: { in: [...outcomes] }, createdAt: { gte: retentionCutoff() } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: READ_LIMIT + 1,
    select: { id: true, accountId: true, event: true, createdAt: true },
  });
  const displayed = rows.slice(0, READ_LIMIT);
  const accountIds = [...new Set(displayed.flatMap(row => row.accountId ? [row.accountId] : []))];
  const accounts = accountIds.length ? await prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, loginName: true },
  }) : [];
  const names = new Map(accounts.map(account => [account.id, account.loginName]));

  return {
    truncated: rows.length > READ_LIMIT,
    events: displayed.map(row => ({
      id: row.id,
      timestamp: row.createdAt.toISOString(),
      outcome: row.event,
      account: row.accountId ? names.get(row.accountId) ?? null : null,
    })),
  };
}

export function startLoginDiagnosticsCleanup() {
  function cleanup() {
    void prisma.securityLog.deleteMany({
      where: { category: CATEGORY, event: { in: [...outcomes] }, createdAt: { lt: retentionCutoff() } },
    }).catch(() => undefined);
  }
  cleanup();
  setInterval(cleanup, 60 * 60 * 1000).unref();
}
