import {
  AccountPersonLinkStatus,
  AccountType,
  ArchiveFolderKind,
  AuditCategory,
  AuditResult,
  PersonAccountRole,
  type Prisma,
} from "@prisma/client";

import { getPrismaClient } from "../../../core/database/database.js";
import { provisionAccountArchive } from "./archive-account.service.js";

type LinkServiceError = Error & { statusCode: number; code: string; details?: unknown };

const HUMAN_TYPES: AccountType[] = [AccountType.MEMBER, AccountType.ADMIN];

function linkError(statusCode: number, code: string, message: string, details?: unknown): LinkServiceError {
  return Object.assign(new Error(message), { statusCode, code, details });
}

function cleanLoginName(value: unknown) {
  return String(value || "").trim().toLowerCase().slice(0, 80);
}

async function humanAccount(database: ReturnType<typeof getPrismaClient> | Prisma.TransactionClient, accountId: string) {
  const account = await database.account.findUnique({
    where: { id: accountId },
    include: {
      person: {
        include: {
          accounts: {
            where: { isActive: true, type: { in: HUMAN_TYPES } },
            orderBy: [{ personAccountRole: "asc" }, { createdAt: "asc" }],
          },
        },
      },
    },
  });
  if (!account?.isActive || !HUMAN_TYPES.includes(account.type)) {
    throw linkError(403, "ACCOUNT_LINK_HUMAN_REQUIRED", "Nur menschliche aktive Accounts können verknüpft werden.");
  }
  if (!account.person) {
    throw linkError(409, "ACCOUNT_LINK_PERSON_REQUIRED", "Der Account ist noch keinem Benutzer zugeordnet.");
  }
  return account;
}

function publicAccount(account: {
  id: string;
  loginName: string;
  personAccountRole: PersonAccountRole;
  linkedAt: Date | null;
  person?: { displayName: string } | null;
}) {
  return {
    accountId: account.id,
    loginName: account.loginName,
    displayName: account.person?.displayName || account.loginName,
    role: account.personAccountRole,
    linkedAt: account.linkedAt?.toISOString() || null,
  };
}

function publicRequest(request: any, currentAccountId: string) {
  return {
    id: request.id,
    status: request.status,
    direction: request.targetAccountId === currentAccountId ? "incoming" : "outgoing",
    expiresAt: request.expiresAt.toISOString(),
    createdAt: request.createdAt.toISOString(),
    requester: publicAccount(request.requestedByAccount),
    target: publicAccount(request.targetAccount),
  };
}

async function expirePendingRequests(accountId: string) {
  const prisma = getPrismaClient();
  await prisma.accountPersonLinkRequest.updateMany({
    where: {
      status: AccountPersonLinkStatus.PENDING,
      expiresAt: { lte: new Date() },
      OR: [{ requestedByAccountId: accountId }, { targetAccountId: accountId }],
    },
    data: { status: AccountPersonLinkStatus.EXPIRED, completedAt: new Date() },
  });
}

const requestAccountInclude = {
  requestedByAccount: { include: { person: { select: { displayName: true } } } },
  targetAccount: { include: { person: { select: { displayName: true } } } },
} satisfies Prisma.AccountPersonLinkRequestInclude;

export async function getAccountLinkOverview(accountId: string) {
  const prisma = getPrismaClient();
  await expirePendingRequests(accountId);
  const account = await humanAccount(prisma, accountId);
  const requests = await prisma.accountPersonLinkRequest.findMany({
    where: {
      status: AccountPersonLinkStatus.PENDING,
      OR: [
        { primaryPersonId: account.personId! },
        { targetAccountId: accountId },
      ],
    },
    include: requestAccountInclude,
    orderBy: { createdAt: "desc" },
  });

  return {
    ok: true,
    person: {
      personId: account.person!.id,
      displayName: account.person!.displayName,
      currentAccountId: account.id,
      canInvite: account.personAccountRole === PersonAccountRole.PRIMARY,
      accounts: account.person!.accounts.map((entry) => publicAccount({
        ...entry,
        person: { displayName: account.person!.displayName },
      })),
    },
    incoming: requests
      .filter((request) => request.targetAccountId === accountId)
      .map((request) => publicRequest(request, accountId)),
    outgoing: requests
      .filter((request) => request.targetAccountId !== accountId)
      .map((request) => publicRequest(request, accountId)),
  };
}

export async function requestAccountLink(accountId: string, targetLoginNameValue: unknown) {
  const prisma = getPrismaClient();
  const current = await humanAccount(prisma, accountId);
  if (current.personAccountRole !== PersonAccountRole.PRIMARY) {
    throw linkError(403, "ACCOUNT_LINK_PRIMARY_REQUIRED", "Nur der Hauptaccount kann einen weiteren Sub-Account einladen.");
  }

  const targetLoginName = cleanLoginName(targetLoginNameValue);
  if (!targetLoginName) throw linkError(400, "ACCOUNT_LINK_TARGET_REQUIRED", "Bitte den Loginnamen des zweiten Accounts eingeben.");
  const target = await prisma.account.findUnique({
    where: { loginName: targetLoginName },
    include: { person: { include: { accounts: true } } },
  });
  if (!target?.isActive || !HUMAN_TYPES.includes(target.type) || !target.person) {
    throw linkError(404, "ACCOUNT_LINK_TARGET_NOT_FOUND", "Der zweite menschliche Account wurde nicht gefunden.");
  }
  if (target.id === accountId || target.personId === current.personId) {
    throw linkError(409, "ACCOUNT_LINK_ALREADY_LINKED", "Dieser Account gehört bereits zum selben Benutzer.");
  }
  if (target.personAccountRole !== PersonAccountRole.PRIMARY || target.person.accounts.length !== 1) {
    throw linkError(
      409,
      "ACCOUNT_LINK_TARGET_GROUPED",
      "Der Zielaccount gehört bereits zu einer Account-Gruppe. Gruppen können nicht automatisch zusammengeführt werden.",
    );
  }

  const pending = await prisma.accountPersonLinkRequest.findFirst({
    where: {
      status: AccountPersonLinkStatus.PENDING,
      expiresAt: { gt: new Date() },
      OR: [
        { primaryPersonId: current.personId!, targetAccountId: target.id },
        { primaryPersonId: target.personId!, targetAccountId: current.id },
      ],
    },
  });
  if (pending) throw linkError(409, "ACCOUNT_LINK_ALREADY_PENDING", "Für diese Accounts wartet bereits eine Bestätigung.");

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const request = await prisma.$transaction(async (transaction) => {
    const created = await transaction.accountPersonLinkRequest.create({
      data: {
        primaryPersonId: current.personId!,
        requestedByAccountId: current.id,
        targetAccountId: target.id,
        requesterApprovedAt: new Date(),
        expiresAt,
      },
      include: requestAccountInclude,
    });
    await transaction.auditLog.create({
      data: {
        category: AuditCategory.ACCESS,
        event: "ACCOUNT_LINK_REQUESTED",
        result: AuditResult.SUCCESS,
        accountId: current.id,
        targetType: "AccountPersonLinkRequest",
        targetId: created.id,
        metadataJson: { targetAccountId: target.id, expiresAt: expiresAt.toISOString() },
      },
    });
    return created;
  });
  return { ok: true, request: publicRequest(request, accountId) };
}

async function assertTargetArchiveCanMove(
  transaction: Prisma.TransactionClient,
  targetPersonId: string,
) {
  const [customFolders, activeGrants, ownedMember] = await Promise.all([
    transaction.archiveFolder.count({
      where: {
        ownerPersonId: targetPersonId,
        deletedAt: null,
        kind: { in: [ArchiveFolderKind.CUSTOM, ArchiveFolderKind.APP] },
      },
    }),
    transaction.archiveFolderGrant.count({
      where: {
        revokedAt: null,
        OR: [
          { granteePersonId: targetPersonId },
          { folder: { ownerPersonId: targetPersonId } },
        ],
      },
    }),
    transaction.memberProfile.findUnique({
      where: { personId: targetPersonId },
      include: { account: true },
    }),
  ]);
  if (customFolders || activeGrants) {
    throw linkError(
      409,
      "ACCOUNT_LINK_ARCHIVE_NOT_EMPTY",
      "Der Zielaccount besitzt bereits eigene Archivdaten oder Freigaben. Diese müssen vor dem Verknüpfen kontrolliert übertragen werden.",
      { customFolders, activeGrants },
    );
  }
  return ownedMember;
}

export async function approveAccountLink(accountId: string, requestId: string) {
  const prisma = getPrismaClient();
  await humanAccount(prisma, accountId);

  return prisma.$transaction(async (transaction) => {
    const request = await transaction.accountPersonLinkRequest.findUnique({
      where: { id: requestId },
      include: {
        requestedByAccount: { include: { person: true } },
        targetAccount: { include: { person: { include: { accounts: true } } } },
        primaryPerson: true,
      },
    });
    if (!request || request.targetAccountId !== accountId) {
      throw linkError(404, "ACCOUNT_LINK_REQUEST_NOT_FOUND", "Die Verknüpfungsanfrage wurde nicht gefunden.");
    }
    if (request.status !== AccountPersonLinkStatus.PENDING) {
      throw linkError(409, "ACCOUNT_LINK_REQUEST_CLOSED", "Die Verknüpfungsanfrage ist nicht mehr offen.");
    }
    if (request.expiresAt <= new Date()) {
      throw linkError(410, "ACCOUNT_LINK_REQUEST_EXPIRED", "Die Verknüpfungsanfrage ist abgelaufen.");
    }
    const oldPerson = request.targetAccount.person;
    if (!request.targetAccount.personId || !oldPerson || request.targetAccount.personAccountRole !== PersonAccountRole.PRIMARY) {
      throw linkError(409, "ACCOUNT_LINK_TARGET_CHANGED", "Der Zielaccount wurde zwischenzeitlich anders zugeordnet.");
    }
    if (oldPerson.accounts.length !== 1) {
      throw linkError(409, "ACCOUNT_LINK_TARGET_GROUPED", "Der Zielaccount gehört bereits zu einer Account-Gruppe.");
    }
    if (request.requestedByAccount.personId !== request.primaryPersonId) {
      throw linkError(409, "ACCOUNT_LINK_REQUESTER_CHANGED", "Der anfragende Account wurde zwischenzeitlich anders zugeordnet.");
    }

    const targetMember = await assertTargetArchiveCanMove(transaction, oldPerson.id);
    const primaryMember = await transaction.memberProfile.findUnique({
      where: { personId: request.primaryPersonId },
      include: { account: true },
    });
    if (targetMember?.account && primaryMember?.account) {
      throw linkError(
        409,
        "ACCOUNT_LINK_FINANCE_REVIEW_REQUIRED",
        "Beide Benutzer besitzen bereits ein Mitgliedskonto. Die finanziellen Daten müssen vor der Verknüpfung manuell geprüft werden.",
      );
    }

    const snapshot = {
      oldPersonId: oldPerson.id,
      displayName: oldPerson.displayName,
      memberId: targetMember?.id || null,
      memberNumber: targetMember?.memberNumber || null,
    };

    await transaction.archiveFolderGrant.deleteMany({
      where: { folder: { ownerPersonId: oldPerson.id } },
    });
    await transaction.archiveFolder.deleteMany({
      where: { ownerPersonId: oldPerson.id, parentId: { not: null } },
    });
    await transaction.archiveFolder.deleteMany({ where: { ownerPersonId: oldPerson.id } });

    const updatedTarget = await transaction.account.update({
      where: { id: request.targetAccountId },
      data: {
        personId: request.primaryPersonId,
        personAccountRole: PersonAccountRole.SUB_ACCOUNT,
        linkedAt: new Date(),
      },
    });

    if (targetMember && !primaryMember) {
      await transaction.memberProfile.update({
        where: { id: targetMember.id },
        data: { personId: request.primaryPersonId },
      });
    } else if (targetMember && primaryMember) {
      if (targetMember.account && !primaryMember.account) {
        await transaction.memberAccount.update({
          where: { id: targetMember.account.id },
          data: { memberId: primaryMember.id },
        });
      }
      await transaction.memberPresenceLog.updateMany({
        where: { memberId: targetMember.id },
        data: { memberId: primaryMember.id },
      });
      const oldMemberNumber = targetMember.memberNumber;
      if (oldMemberNumber) {
        await transaction.memberProfile.update({
          where: { id: targetMember.id },
          data: { memberNumber: null },
        });
      }
      await transaction.memberProfile.delete({ where: { id: targetMember.id } });
      if (!primaryMember.memberNumber && oldMemberNumber) {
        await transaction.memberProfile.update({
          where: { id: primaryMember.id },
          data: { memberNumber: oldMemberNumber },
        });
      }
    }

    await transaction.person.update({
      where: { id: request.primaryPersonId },
      data: {
        email: request.primaryPerson.email || oldPerson.email,
        phone: request.primaryPerson.phone || oldPerson.phone,
        nickname: request.primaryPerson.nickname || oldPerson.nickname,
        firstName: request.primaryPerson.firstName || oldPerson.firstName,
        lastName: request.primaryPerson.lastName || oldPerson.lastName,
      },
    });
    await transaction.person.delete({ where: { id: oldPerson.id } });

    await provisionAccountArchive(transaction, {
      id: updatedTarget.id,
      type: updatedTarget.type,
      loginName: request.requestedByAccount.loginName,
      personId: request.primaryPersonId,
    });

    const completed = await transaction.accountPersonLinkRequest.update({
      where: { id: request.id },
      data: {
        status: AccountPersonLinkStatus.ACCEPTED,
        targetApprovedAt: new Date(),
        completedAt: new Date(),
        metadataJson: snapshot,
      },
    });
    await transaction.auditLog.create({
      data: {
        category: AuditCategory.ACCESS,
        event: "ACCOUNT_LINK_ACCEPTED",
        result: AuditResult.SUCCESS,
        accountId,
        targetType: "Account",
        targetId: updatedTarget.id,
        metadataJson: { primaryPersonId: request.primaryPersonId, previousIdentity: snapshot },
      },
    });

    return {
      ok: true,
      linked: true,
      requestId: completed.id,
      personId: request.primaryPersonId,
      account: {
        accountId: updatedTarget.id,
        loginName: updatedTarget.loginName,
        role: updatedTarget.personAccountRole,
      },
    };
  });
}

export async function rejectAccountLink(accountId: string, requestId: string) {
  const prisma = getPrismaClient();
  await humanAccount(prisma, accountId);
  const request = await prisma.accountPersonLinkRequest.findUnique({ where: { id: requestId } });
  if (!request || (request.targetAccountId !== accountId && request.requestedByAccountId !== accountId)) {
    throw linkError(404, "ACCOUNT_LINK_REQUEST_NOT_FOUND", "Die Verknüpfungsanfrage wurde nicht gefunden.");
  }
  if (request.status !== AccountPersonLinkStatus.PENDING) {
    throw linkError(409, "ACCOUNT_LINK_REQUEST_CLOSED", "Die Verknüpfungsanfrage ist nicht mehr offen.");
  }
  const status = request.targetAccountId === accountId
    ? AccountPersonLinkStatus.REJECTED
    : AccountPersonLinkStatus.CANCELLED;
  await prisma.$transaction(async (transaction) => {
    await transaction.accountPersonLinkRequest.update({
      where: { id: request.id },
      data: { status, completedAt: new Date() },
    });
    await transaction.auditLog.create({
      data: {
        category: AuditCategory.ACCESS,
        event: status === AccountPersonLinkStatus.REJECTED ? "ACCOUNT_LINK_REJECTED" : "ACCOUNT_LINK_CANCELLED",
        result: AuditResult.SUCCESS,
        accountId,
        targetType: "AccountPersonLinkRequest",
        targetId: request.id,
      },
    });
  });
  return { ok: true, closed: true, status };
}
