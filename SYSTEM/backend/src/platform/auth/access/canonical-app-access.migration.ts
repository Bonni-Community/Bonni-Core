import type { Prisma } from "@prisma/client";

import { prisma } from "../../../core/database/database.js";

type AppDefinition = {
  appKey: "app.stueberlapp" | "app.kontorapp";
  slug: "app-stueberlapp" | "app-kontorapp";
  name: "StüberlApp" | "KontorApp";
  functions: Record<string, string>;
  labels: Record<string, string>;
};

type CanonicalAssignment = {
  app: AppDefinition;
  functionKey: string;
};

const APPS: AppDefinition[] = [
  {
    appKey: "app.stueberlapp",
    slug: "app-stueberlapp",
    name: "StüberlApp",
    functions: {
      open: "member",
      access: "member",
      zugriff: "member",
      member: "member",
      mitglied: "member",
      admin: "manager",
      administrator: "manager",
      manager: "manager",
      storeman: "storeman",
      warehouse: "storeman",
      lager: "storeman",
      treasurer: "treasurer",
      billing: "treasurer",
      accounting: "treasurer",
      cashier: "treasurer",
      kasse: "treasurer",
      helper: "helper",
      bar: "barkeeper",
      barkeeper: "barkeeper",
      bartender: "barkeeper",
      theke: "barkeeper",
      "bierdeckel-manage": "barkeeper",
      terminal: "terminal",
      table: "terminal",
      tisch: "terminal",
      kitchen: "kuche",
      kueche: "kuche",
      kuche: "kuche",
      koch: "kuche",
      cook: "kuche",
    },
    labels: {
      member: "Member",
      manager: "Manager",
      storeman: "Storeman",
      treasurer: "Treasurer",
      helper: "Helper",
      barkeeper: "Barkeeper",
      terminal: "Terminal",
      kuche: "Küche",
    },
  },
  {
    appKey: "app.kontorapp",
    slug: "app-kontorapp",
    name: "KontorApp",
    functions: {
      open: "member",
      access: "member",
      zugriff: "member",
      member: "member",
      mitglied: "member",
      admin: "manager",
      administrator: "manager",
      manager: "manager",
    },
    labels: {
      member: "Member",
      manager: "Manager",
    },
  },
];

function slug(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function appForValue(value: string) {
  const normalized = slug(value);
  return APPS.find((app) => (
    normalized === slug(app.appKey)
    || normalized === app.slug
    || normalized === slug(app.name)
  )) || null;
}

function canonicalAssignment(appValue: string, functionValue: string): CanonicalAssignment | null {
  const app = appForValue(appValue);
  if (!app) return null;

  const functionKey = app.functions[slug(functionValue)];
  return functionKey ? { app, functionKey } : null;
}

function assignmentFromTechnicalKey(value: unknown): CanonicalAssignment | null {
  const key = String(value || "").trim().toLowerCase();
  if (!key) return null;

  const accessRole = key.match(/^access:app:(app-[a-z0-9-]+):([a-z0-9.-]+)$/);
  if (accessRole) return canonicalAssignment(accessRole[1], accessRole[2]);

  const managedPermission = key.match(/^module\.(app-[a-z0-9-]+)\.([a-z0-9.-]+)$/);
  if (managedPermission) return canonicalAssignment(managedPermission[1], managedPermission[2]);

  const oldPermission = key.match(/^(app\.[a-z0-9-]+)\.([a-z0-9.-]+)$/);
  if (oldPermission) return canonicalAssignment(oldPermission[1], oldPermission[2]);

  return null;
}

function assignmentFromRoleLabel(value: unknown): CanonicalAssignment | null {
  const match = String(value || "").trim().match(/^App\s*:\s*(.*?)\s*·\s*(.+)$/i);
  return match ? canonicalAssignment(match[1], match[2]) : null;
}

function roleKey(assignment: CanonicalAssignment) {
  return `access:app:${assignment.app.slug}:${assignment.functionKey}`;
}

function permissionKey(assignment: CanonicalAssignment) {
  return `module.${assignment.app.slug}.${assignment.functionKey}`;
}

function assignmentId(assignment: CanonicalAssignment) {
  return `${assignment.app.slug}:${assignment.functionKey}`;
}

async function ensureAssignment(
  transaction: Prisma.TransactionClient,
  accountId: string,
  assignment: CanonicalAssignment,
) {
  const label = `App: ${assignment.app.name} · ${assignment.app.labels[assignment.functionKey]}`;
  const role = await transaction.role.upsert({
    where: { key: roleKey(assignment) },
    update: { label },
    create: { key: roleKey(assignment), label },
  });
  const permission = await transaction.permission.upsert({
    where: { key: permissionKey(assignment) },
    update: { label },
    create: { key: permissionKey(assignment), label },
  });

  await transaction.rolePermission.upsert({
    where: {
      roleId_permissionId: {
        roleId: role.id,
        permissionId: permission.id,
      },
    },
    update: {},
    create: { roleId: role.id, permissionId: permission.id },
  });
  await transaction.accountRole.upsert({
    where: { accountId_roleId: { accountId, roleId: role.id } },
    update: {},
    create: { accountId, roleId: role.id },
  });
}

/**
 * Überführt frühere App-Rechte einmalig in die einzige aktuelle
 * Schlüsselfamilie. Danach werden alte App-Berechtigungen weder ausgewertet
 * noch in der Datenbank behalten.
 */
export async function migrateCanonicalAppAccessKeys() {
  return prisma.$transaction(async (transaction) => {
    const accounts = await transaction.account.findMany({
      select: {
        id: true,
        roles: {
          select: {
            role: {
              select: {
                id: true,
                key: true,
                label: true,
                permissions: {
                  select: { permission: { select: { key: true } } },
                },
              },
            },
          },
        },
      },
    });

    const obsoleteRoleIds = new Set<string>();
    let migratedAssignments = 0;

    for (const account of accounts) {
      const assignments = new Map<string, CanonicalAssignment>();

      for (const accountRole of account.roles) {
        const role = accountRole.role;
        const fromRole = assignmentFromTechnicalKey(role.key) || assignmentFromRoleLabel(role.label);
        if (fromRole) {
          assignments.set(assignmentId(fromRole), fromRole);
          if (role.key !== roleKey(fromRole)) obsoleteRoleIds.add(role.id);
        }

        for (const rolePermission of role.permissions) {
          const fromPermission = assignmentFromTechnicalKey(rolePermission.permission.key);
          if (fromPermission) assignments.set(assignmentId(fromPermission), fromPermission);
        }
      }

      for (const assignment of assignments.values()) {
        await ensureAssignment(transaction, account.id, assignment);
        migratedAssignments += 1;
      }
    }

    const oldPermissions = await transaction.permission.findMany({
      where: {
        OR: [
          { key: { startsWith: "app.stueberlapp." } },
          { key: { startsWith: "app.kontorapp." } },
        ],
      },
      select: { id: true },
    });
    const oldPermissionIds = oldPermissions.map((permission) => permission.id);
    const oldRoleIds = [...obsoleteRoleIds];

    if (oldRoleIds.length) {
      await transaction.accountRole.deleteMany({ where: { roleId: { in: oldRoleIds } } });
      await transaction.rolePermission.deleteMany({ where: { roleId: { in: oldRoleIds } } });
      await transaction.role.deleteMany({ where: { id: { in: oldRoleIds } } });
    }

    if (oldPermissionIds.length) {
      await transaction.rolePermission.deleteMany({ where: { permissionId: { in: oldPermissionIds } } });
      await transaction.memberCapabilityPermission.deleteMany({ where: { permissionId: { in: oldPermissionIds } } });
      await transaction.permission.deleteMany({ where: { id: { in: oldPermissionIds } } });
    }

    return {
      migratedAssignments,
      removedLegacyRoles: oldRoleIds.length,
      removedLegacyPermissions: oldPermissionIds.length,
    };
  });
}
