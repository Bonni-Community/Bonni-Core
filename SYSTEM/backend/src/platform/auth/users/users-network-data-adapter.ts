import { AccountType } from "@prisma/client";

import {
  coreDataAdapterRegistry,
  type CoreDataActor,
  type CoreDataAdapterOperation,
} from "../../../core/data-adapters/index.js";
import { getPrismaClient } from "../../../core/database/database.js";

const DOMAIN_ID = "bonni.users";
export const NETWORK_USER_ACCOUNT_TYPES = [AccountType.MEMBER, AccountType.ADMIN];
let registered = false;

function maxVersion(...values: Array<Date | null | undefined>) {
  return Math.max(1, ...values.map((value) => value instanceof Date ? value.getTime() : 0));
}

export function accountNetworkOperation(account: any): CoreDataAdapterOperation {
  const version = maxVersion(account.updatedAt, account.person?.updatedAt, account.person?.member?.updatedAt);
  return {
    entityId: `account:${account.id}`,
    action: "upsert",
    version,
    occurredAt: new Date(version).toISOString(),
    payload: {
      kind: "account",
      homeAccountId: account.id,
      homeMemberId: account.person?.member?.id || null,
      displayName: account.person?.displayName || account.loginName,
      loginName: account.loginName,
      accountType: account.type,
      active: Boolean(account.isActive),
      roleKeys: (account.roles || []).map((entry: any) => entry.role?.key).filter(Boolean).sort(),
    },
  };
}

async function queryOperations(filters: { accountIds?: string[]; memberIds?: string[] } = {}) {
  const prisma = getPrismaClient();
  const accountIds = [...new Set((filters.accountIds || []).filter(Boolean))];
  const memberIds = [...new Set((filters.memberIds || []).filter(Boolean))];
  const targeted = accountIds.length > 0 || memberIds.length > 0;

  const accountFilters: any[] = [];
  if (accountIds.length) accountFilters.push({ id: { in: accountIds } });
  if (memberIds.length) accountFilters.push({ person: { member: { id: { in: memberIds } } } });

  const accounts = await prisma.account.findMany({
    where: {
      type: { in: NETWORK_USER_ACCOUNT_TYPES },
      isSandbox: false,
      ...(targeted ? { OR: accountFilters } : {}),
    },
    include: {
      person: { include: { member: true } },
      roles: { include: { role: true } },
    },
    orderBy: { id: "asc" },
  });

  return accounts.map(accountNetworkOperation);
}

export function registerUsersNetworkDataAdapter() {
  if (registered) return;
  coreDataAdapterRegistry.register({
    domainId: DOMAIN_ID,
    name: "Benutzer",
    description: "Sichere Benutzerkonten und Rollenreferenzen ohne Passwörter, MFA, Sitzungen, Bank- oder Kontaktdaten.",
    protocolVersion: "1.0",
    sourceModule: "core.auth.users",
    exportSnapshot: () => queryOperations(),
  });
  registered = true;
}

export async function publishUsersNetworkRecords(
  filters: { accountIds?: Array<string | null | undefined>; memberIds?: Array<string | null | undefined> },
  actor: CoreDataActor | null,
) {
  registerUsersNetworkDataAdapter();
  const operations = await queryOperations({
    accountIds: (filters.accountIds || []).filter((value): value is string => Boolean(value)),
    memberIds: (filters.memberIds || []).filter((value): value is string => Boolean(value)),
  });
  if (!operations.length) return { published: 0 };

  return coreDataAdapterRegistry.publishLocal({
    domainId: DOMAIN_ID,
    operations,
    sourceModule: "core.auth.users",
    actor,
  });
}

export async function publishUserAccountDeletion(
  accountId: string,
  actor: CoreDataActor | null,
) {
  registerUsersNetworkDataAdapter();
  const occurredAt = new Date().toISOString();
  return coreDataAdapterRegistry.publishLocal({
    domainId: DOMAIN_ID,
    operations: [{
      entityId: `account:${accountId}`,
      action: "delete",
      version: Date.now(),
      occurredAt,
      payload: null,
    }],
    sourceModule: "core.auth.users",
    actor,
    occurredAt,
  });
}
