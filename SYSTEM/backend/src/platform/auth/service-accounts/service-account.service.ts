import { AccountType, AuthProviderType } from "@prisma/client";

import { getPrismaClient } from "../../../core/database/database.js";

export type EnsureServiceAccountInput = {
  key: string;
  loginName: string;
  displayName: string;
  permissions: string[];
  enabled?: boolean;
};

function cleanText(value: unknown, maxLength: number) {
  return String(value || "").trim().slice(0, maxLength);
}

function slug(value: unknown, fallback = "service") {
  const normalized = cleanText(value, 160)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function uniquePermissions(values: unknown) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanText(value, 180).toLowerCase())
    .filter((value) => /^[a-z0-9][a-z0-9._:-]{2,179}$/.test(value)))]
    .sort();
}

function externalSubject(ownerModule: string, key: string) {
  return `urn:bonni:service:${slug(ownerModule)}:${slug(key)}`;
}

function roleKey(ownerModule: string, key: string) {
  return `service:${slug(ownerModule)}:${slug(key)}`.slice(0, 180);
}

export function describeServiceAccountIdentity(ownerModuleValue: string, keyValue: string) {
  const ownerModule = cleanText(ownerModuleValue, 160);
  const key = slug(keyValue, "service");
  if (!ownerModule) throw new Error("SERVICE_ACCOUNT_OWNER_REQUIRED");
  return {
    ownerModule,
    serviceKey: key,
    externalSubject: externalSubject(ownerModule, key),
    roleKey: roleKey(ownerModule, key),
  };
}

function permissionLabel(permission: string) {
  return permission
    .split(/[.:_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .slice(0, 180);
}

export async function ensureOwnedServiceAccount(
  ownerModuleValue: string,
  input: EnsureServiceAccountInput,
) {
  const ownerModule = cleanText(ownerModuleValue, 160);
  const key = slug(input.key, "adapter");
  const loginName = cleanText(input.loginName, 80).toLowerCase();
  const displayName = cleanText(input.displayName, 160) || loginName;
  const permissions = uniquePermissions(input.permissions);
  const enabled = input.enabled !== false;
  const identity = describeServiceAccountIdentity(ownerModule, key);
  const subject = identity.externalSubject;
  const managedRoleKey = identity.roleKey;

  if (!ownerModule) throw new Error("SERVICE_ACCOUNT_OWNER_REQUIRED");
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(loginName)) {
    throw new Error("SERVICE_ACCOUNT_LOGIN_INVALID");
  }

  const prisma = getPrismaClient();
  const candidates = await prisma.account.findMany({
    where: { OR: [{ loginName }, { externalSubject: subject }] },
  });
  const byLogin = candidates.find((account) => account.loginName === loginName) || null;
  const bySubject = candidates.find((account) => account.externalSubject === subject) || null;
  if (byLogin && bySubject && byLogin.id !== bySubject.id) {
    throw new Error("SERVICE_ACCOUNT_IDENTITY_CONFLICT");
  }
  const existing = bySubject || byLogin;
  if (existing && (
    existing.type !== AccountType.SERVICE
    || existing.externalSubject !== subject
    || Boolean(existing.personId)
  )) {
    throw new Error("SERVICE_ACCOUNT_LOGIN_CONFLICT");
  }

  const result = await prisma.$transaction(async (transaction) => {
    const provider = await transaction.authProvider.upsert({
      where: { key: "bonni-internal" },
      update: { active: true, name: "Bonni Core Internal Services" },
      create: {
        key: "bonni-internal",
        type: AuthProviderType.LOCAL,
        name: "Bonni Core Internal Services",
        active: true,
      },
    });

    const account = existing
      ? await transaction.account.update({
          where: { id: existing.id },
          data: {
            type: AccountType.SERVICE,
            loginName,
            authProviderId: provider.id,
            externalSubject: subject,
            passwordHash: null,
            email: null,
            personId: null,
            isActive: enabled,
            isSandbox: false,
          },
        })
      : await transaction.account.create({
          data: {
            type: AccountType.SERVICE,
            loginName,
            authProviderId: provider.id,
            externalSubject: subject,
            passwordHash: null,
            email: null,
            personId: null,
            isActive: enabled,
            isSandbox: false,
          },
        });

    const role = await transaction.role.upsert({
      where: { key: managedRoleKey },
      update: { label: `${displayName} (verwaltet)` },
      create: { key: managedRoleKey, label: `${displayName} (verwaltet)` },
    });

    const permissionRows = [];
    for (const permissionKey of permissions) {
      permissionRows.push(await transaction.permission.upsert({
        where: { key: permissionKey },
        update: { label: permissionLabel(permissionKey) },
        create: { key: permissionKey, label: permissionLabel(permissionKey) },
      }));
    }

    await transaction.rolePermission.deleteMany({
      where: {
        roleId: role.id,
        ...(permissionRows.length ? { permissionId: { notIn: permissionRows.map((row) => row.id) } } : {}),
      },
    });
    for (const permission of permissionRows) {
      await transaction.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }

    const otherRoles = await transaction.accountRole.findMany({
      where: { accountId: account.id, roleId: { not: role.id } },
      select: { roleId: true },
    });
    if (otherRoles.length) {
      await transaction.accountRole.deleteMany({
        where: { accountId: account.id, roleId: { in: otherRoles.map((entry) => entry.roleId) } },
      });
    }
    await transaction.accountRole.upsert({
      where: { accountId_roleId: { accountId: account.id, roleId: role.id } },
      update: {},
      create: { accountId: account.id, roleId: role.id },
    });

    // A service principal is called only through an in-process capability.
    // Revoke historical browser credentials defensively if the login name was
    // ever created by an older implementation.
    await transaction.session.deleteMany({ where: { accountId: account.id } });
    await transaction.refreshToken.updateMany({
      where: { accountId: account.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return {
      id: account.id,
      loginName: account.loginName,
      type: account.type,
      isActive: account.isActive,
      interactiveLogin: false,
      passwordConfigured: false,
      ownerModule,
      serviceKey: key,
      role: managedRoleKey,
      permissions,
    };
  });

  await prisma.auditLog.create({
    data: {
      category: "SYSTEM",
      event: existing ? "SERVICE_ACCOUNT_RECONCILED" : "SERVICE_ACCOUNT_CREATED",
      result: "SUCCESS",
      accountId: result.id,
      targetType: "SERVICE_ACCOUNT",
      targetId: result.id,
      severity: "INFO",
      metadataJson: {
        ownerModule,
        serviceKey: key,
        loginName,
        enabled,
        interactiveLogin: false,
        permissions,
      },
    },
  }).catch(() => undefined);

  return result;
}

export async function getOwnedServiceAccount(ownerModuleValue: string, keyValue: string) {
  const ownerModule = cleanText(ownerModuleValue, 160);
  const key = slug(keyValue, "adapter");
  const subject = describeServiceAccountIdentity(ownerModule, key).externalSubject;
  const prisma = getPrismaClient();
  const account = await prisma.account.findFirst({
    where: { externalSubject: subject, type: AccountType.SERVICE },
    include: {
      roles: {
        include: {
          role: {
            include: {
              permissions: { include: { permission: true } },
            },
          },
        },
      },
    },
  });
  if (!account) return null;

  return {
    id: account.id,
    loginName: account.loginName,
    type: account.type,
    isActive: account.isActive,
    interactiveLogin: false,
    passwordConfigured: Boolean(account.passwordHash),
    ownerModule,
    serviceKey: key,
    roles: account.roles.map((entry) => entry.role.key),
    permissions: [...new Set(account.roles.flatMap((entry) => (
      entry.role.permissions.map((link) => link.permission.key)
    )))].sort(),
  };
}

export function createModuleServiceAccountRuntime(ownerModuleValue: string) {
  const ownerModule = cleanText(ownerModuleValue, 160);
  return Object.freeze({
    ensure: (input: EnsureServiceAccountInput) => ensureOwnedServiceAccount(ownerModule, input),
    get: (key: string) => getOwnedServiceAccount(ownerModule, key),
  });
}
