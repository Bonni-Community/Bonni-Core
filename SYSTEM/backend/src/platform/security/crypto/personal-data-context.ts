import type { PrismaClient } from "@prisma/client";

import type { PersonalDataEncryptionContext } from "./personal-data.js";

export const PERSONAL_DATA_ENCRYPTION_EXCLUDED_ACCOUNT_TYPES = ["ADMIN"] as const;
export const PERSONAL_DATA_ENCRYPTION_EXCLUDED_ROLE_KEYS = ["admin", "ADMIN"] as const;

export type PersonalDataAccountLike = {
  id: string;
  type?: string | null;
  roles?: Array<{
    role?: {
      key?: string | null;
    } | null;
  }> | null;
};

export type PersonalDataMemberLike = {
  id: string;
  personId?: string | null;
};

export type PersonalDataContextResolveStatus =
  | "READY"
  | "PERSON_NOT_FOUND"
  | "MEMBER_MISSING"
  | "ACCOUNT_MISSING"
  | "ACCOUNT_AMBIGUOUS"
  | "ACCOUNT_NOT_LINKED_TO_PERSON"
  | "ACCOUNT_NOT_FOUND"
  | "ADMIN_ACCOUNT_EXCLUDED";

export type PersonalDataContextResolveResult =
  | {
      status: "READY";
      context: Required<Pick<PersonalDataEncryptionContext, "accountId" | "memberId">>;
      accountId: string;
      memberId: string;
      personId: string;
      ignoredAdminAccountIds: string[];
    }
  | {
      status: Exclude<PersonalDataContextResolveStatus, "READY">;
      context: null;
      accountId?: string | null;
      memberId?: string | null;
      personId?: string | null;
      ignoredAdminAccountIds: string[];
      message: string;
    };

const accountInclude = {
  roles: {
    include: {
      role: true,
    },
  },
} as const;

/**
 * Admin accounts are identity-administration accounts and must never be used as
 * the accountId part of the personal-data encryption key.
 */
export function isPersonalDataEncryptionExcludedAccount(account: PersonalDataAccountLike | null | undefined): boolean {
  if (!account) {
    return false;
  }

  if (PERSONAL_DATA_ENCRYPTION_EXCLUDED_ACCOUNT_TYPES.includes(String(account.type || "") as any)) {
    return true;
  }

  const roleKeys = account.roles
    ?.map((entry) => entry.role?.key)
    .filter((key): key is string => Boolean(key))
    .map((key) => key.trim()) ?? [];

  return roleKeys.some((key) => PERSONAL_DATA_ENCRYPTION_EXCLUDED_ROLE_KEYS.includes(key as any));
}

export function assertPersonalDataEncryptionAccountAllowed(account: PersonalDataAccountLike | null | undefined): void {
  if (isPersonalDataEncryptionExcludedAccount(account)) {
    throw Object.assign(new Error("PERSONAL_DATA_ADMIN_ACCOUNT_EXCLUDED"), {
      statusCode: 409,
      details: {
        accountId: account?.id ?? null,
      },
    });
  }
}

/**
 * Resolve the only key context that is allowed for encrypting a person's clear
 * person fields:
 *
 *   Server-Master-Key + accountId + memberId
 *
 * The account must be a real member/user account linked to the same Person.
 * Admin accounts are ignored/excluded on purpose.
 */
export async function resolvePersonalDataEncryptionContextByPersonId(
  prisma: PrismaClient,
  personId: string,
  options: { accountId?: string | null } = {},
): Promise<PersonalDataContextResolveResult> {
  const normalizedPersonId = personId?.trim();
  const explicitAccountId = options.accountId?.trim() || null;

  if (!normalizedPersonId) {
    return rejected("PERSON_NOT_FOUND", "PersonID fehlt.", { personId: normalizedPersonId });
  }

  const person = await prisma.person.findUnique({
    where: { id: normalizedPersonId },
    include: {
      member: true,
      accounts: {
        include: accountInclude,
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!person) {
    return rejected("PERSON_NOT_FOUND", "Person wurde nicht gefunden.", { personId: normalizedPersonId });
  }

  const member = person.member as PersonalDataMemberLike | null;
  const accounts = person.accounts as PersonalDataAccountLike[];

  if (!member?.id) {
    return rejected("MEMBER_MISSING", "Für diese Person existiert noch kein Member.", {
      personId: person.id,
    });
  }

  const ignoredAdminAccountIds = accounts
    .filter((account: PersonalDataAccountLike) => isPersonalDataEncryptionExcludedAccount(account))
    .map((account: PersonalDataAccountLike) => account.id);

  if (explicitAccountId) {
    const account = accounts.find((entry: PersonalDataAccountLike) => entry.id === explicitAccountId);

    if (!account) {
      const externalAccount = await prisma.account.findUnique({
        where: { id: explicitAccountId },
        include: accountInclude,
      });

      if (!externalAccount) {
        return rejected("ACCOUNT_NOT_FOUND", "Der angegebene Account wurde nicht gefunden.", {
          personId: person.id,
          memberId: member.id,
          accountId: explicitAccountId,
          ignoredAdminAccountIds,
        });
      }

      if (isPersonalDataEncryptionExcludedAccount(externalAccount)) {
        return rejected("ADMIN_ACCOUNT_EXCLUDED", "Admin-Accounts werden von der Personendaten-Verschlüsselung ausgenommen.", {
          personId: person.id,
          memberId: member.id,
          accountId: explicitAccountId,
          ignoredAdminAccountIds: [...new Set([...ignoredAdminAccountIds, externalAccount.id])],
        });
      }

      return rejected("ACCOUNT_NOT_LINKED_TO_PERSON", "Der angegebene Account ist nicht mit dieser Person verknüpft.", {
        personId: person.id,
        memberId: member.id,
        accountId: explicitAccountId,
        ignoredAdminAccountIds,
      });
    }

    if (isPersonalDataEncryptionExcludedAccount(account)) {
      return rejected("ADMIN_ACCOUNT_EXCLUDED", "Admin-Accounts werden von der Personendaten-Verschlüsselung ausgenommen.", {
        personId: person.id,
        memberId: member.id,
        accountId: explicitAccountId,
        ignoredAdminAccountIds,
      });
    }

    return ready(person.id, explicitAccountId, member.id, ignoredAdminAccountIds);
  }

  const usableAccounts = accounts.filter((account: PersonalDataAccountLike) => !isPersonalDataEncryptionExcludedAccount(account));

  if (!usableAccounts.length) {
    return rejected("ACCOUNT_MISSING", "Für diese Person ist noch kein verschlüsselbarer Member-Account verknüpft.", {
      personId: person.id,
      memberId: member.id,
      ignoredAdminAccountIds,
    });
  }

  if (usableAccounts.length > 1) {
    return rejected("ACCOUNT_AMBIGUOUS", "Mehrere Member-Accounts gefunden. Bitte accountId explizit angeben.", {
      personId: person.id,
      memberId: member.id,
      ignoredAdminAccountIds,
    });
  }

  return ready(person.id, usableAccounts[0].id, member.id, ignoredAdminAccountIds);
}

export async function resolvePersonalDataEncryptionContextByMemberId(
  prisma: PrismaClient,
  memberId: string,
  options: { accountId?: string | null } = {},
): Promise<PersonalDataContextResolveResult> {
  const normalizedMemberId = memberId?.trim();

  if (!normalizedMemberId) {
    return rejected("MEMBER_MISSING", "MemberID fehlt.", { memberId: normalizedMemberId });
  }

  const member = await prisma.memberProfile.findUnique({
    where: { id: normalizedMemberId },
    select: { id: true, personId: true },
  });

  if (!member?.personId) {
    return rejected("MEMBER_MISSING", "Member wurde nicht gefunden.", { memberId: normalizedMemberId });
  }

  return resolvePersonalDataEncryptionContextByPersonId(prisma, member.personId, options);
}

export function assertPersonalDataEncryptionContextReady(
  result: PersonalDataContextResolveResult,
): asserts result is Extract<PersonalDataContextResolveResult, { status: "READY" }> {
  if (result.status !== "READY") {
    throw Object.assign(new Error(result.status), {
      statusCode: result.status === "ADMIN_ACCOUNT_EXCLUDED" ? 409 : 422,
      details: {
        accountId: result.accountId ?? null,
        memberId: result.memberId ?? null,
        personId: result.personId ?? null,
        ignoredAdminAccountIds: result.ignoredAdminAccountIds,
        message: result.message,
      },
    });
  }
}

function ready(
  personId: string,
  accountId: string,
  memberId: string,
  ignoredAdminAccountIds: string[],
): Extract<PersonalDataContextResolveResult, { status: "READY" }> {
  return {
    status: "READY",
    context: { accountId, memberId },
    accountId,
    memberId,
    personId,
    ignoredAdminAccountIds,
  };
}

function rejected(
  status: Exclude<PersonalDataContextResolveStatus, "READY">,
  message: string,
  values: {
    accountId?: string | null;
    memberId?: string | null;
    personId?: string | null;
    ignoredAdminAccountIds?: string[];
  } = {},
): Extract<PersonalDataContextResolveResult, { context: null }> {
  return {
    status,
    context: null,
    accountId: values.accountId ?? null,
    memberId: values.memberId ?? null,
    personId: values.personId ?? null,
    ignoredAdminAccountIds: values.ignoredAdminAccountIds ?? [],
    message,
  };
}
