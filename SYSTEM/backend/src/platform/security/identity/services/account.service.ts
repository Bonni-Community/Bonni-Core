import { prisma } from "../../../../core/core.js";

export async function getMe(accountId: string) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: {
      person: true,
      roles: {
        include: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: true
                }
              }
            }
          }
        }
      }
    }
  });

  if (!account || !account.isActive) {
    throw Object.assign(new Error("ACCOUNT_NOT_FOUND"), { statusCode: 404 });
  }

  const roles = account.roles.map((entry) => entry.role.key);
  const permissions = [
    ...new Set(
      account.roles.flatMap((entry) =>
        entry.role.permissions.map((permissionEntry) => permissionEntry.permission.key)
      )
    )
  ];

  return {
    id: account.id,
    loginName: account.loginName,
    email: account.email,
    type: account.type,
    person: account.person,
    roles,
    permissions
  };
}

export async function listAccounts() {
  return prisma.account.findMany({
    select: {
      id: true,
      loginName: true,
      email: true,
      type: true,
      isActive: true,
      isSandbox: true,
      lastLoginAt: true,
      createdAt: true
    },
    orderBy: { createdAt: "desc" }
  });
}

export async function listRoles() {
  return prisma.role.findMany({
    include: {
      permissions: {
        include: {
          permission: true
        }
      }
    },
    orderBy: { key: "asc" }
  });
}

export async function listPermissions() {
  return prisma.permission.findMany({
    orderBy: { key: "asc" }
  });
}
