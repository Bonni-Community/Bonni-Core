import {
  AccountType,
  AuthProviderType,
  ClubMembershipStatus,
  MemberStatus,
  type Prisma,
} from "@prisma/client";
import { hashExactLocalPassword } from "../../core/modules/identity/local-password-policy.js";
import { advanceTwoFactorAfterPasswordChange } from "../../core/modules/security/two-factor/password-change.js";
import { transitionAccountSecurity } from "../../core/modules/security/two-factor/account-security-transition.js";

import {
  disconnectPrismaClients,
  getDatabaseTargetPrismaClient,
  getServerPrismaClient,
} from "../../core/database/database.js";
import { resolveBootstrapAdminPassword } from "../../platform/auth/bootstrap-admin-password.js";
import { BOOTSTRAP_ADMIN_LOGIN_NAME } from "../../platform/auth/system-account-policy.js";
import { createAccountId, createMemberId } from "../../platform/security/crypto/id.js";

// Seed policy: only technical/system data.
// Business data like products, product categories, packaging nodes and packaging attributes
// must be created manually through the application.

type SeedUser = {
  loginName: string;
  displayName: string;
  password: string;
  replaceExistingPassword?: boolean;
  roleKey: string;
  type: AccountType;
  isSandbox: boolean;
};

type SeedDatabase = Prisma.TransactionClient;

function needsPersonalMemberProfile(type: AccountType) {
  return type === AccountType.MEMBER || type === AccountType.ADMIN;
}

function personalMemberProfileData(personId: string, type: AccountType) {
  return {
    id: createMemberId(),
    personId,
    status: MemberStatus.MEMBER,
    membershipStatus: ClubMembershipStatus.ACTIVE_MEMBER,
    joinedAt: new Date(),
    notes: type === AccountType.ADMIN
      ? "Bonni Core bootstrap administrator"
      : "Seed member",
  };
}

function personalMemberProfileUpdate(type: AccountType) {
  if (type !== AccountType.ADMIN) return {};

  return {
    status: MemberStatus.MEMBER,
    membershipStatus: ClubMembershipStatus.ACTIVE_MEMBER,
    leftAt: null,
  };
}

const permissions = [
  "system.admin",
  "system.settings.read",
  "system.settings.write",
  "auth.users.read",
  "auth.users.write",
  "package-manager.read",
  "package-manager.write",
];

const roleDefinitions = [
  {
    key: "admin",
    label: "Administrator",
    permissions,
  },
];
async function seedAuthProvider(database: SeedDatabase) {
  const localProvider = await database.authProvider.upsert({
    where: {
      key: "local",
    },
    update: {
      type: AuthProviderType.LOCAL,
      name: "Local Login",
      active: true,
    },
    create: {
      key: "local",
      type: AuthProviderType.LOCAL,
      name: "Local Login",
      active: true,
    },
  });

  const sandboxProvider = await database.authProvider.upsert({
    where: {
      key: "sandbox",
    },
    update: {
      type: AuthProviderType.SANDBOX,
      name: "Sandbox Login",
      active: true,
    },
    create: {
      key: "sandbox",
      type: AuthProviderType.SANDBOX,
      name: "Sandbox Login",
      active: true,
    },
  });

  return {
    localProvider,
    sandboxProvider,
  };
}

async function seedPermissions(database: SeedDatabase) {
  for (const permissionKey of permissions) {
    await database.permission.upsert({
      where: {
        key: permissionKey,
      },
      update: {
        label: permissionKey,
      },
      create: {
        key: permissionKey,
        label: permissionKey,
      },
    });
  }
}

async function seedRoles(database: SeedDatabase) {
  for (const roleDefinition of roleDefinitions) {
    await database.role.upsert({
      where: {
        key: roleDefinition.key,
      },
      update: {
        label: roleDefinition.label,
      },
      create: {
        key: roleDefinition.key,
        label: roleDefinition.label,
      },
    });
  }

  for (const roleDefinition of roleDefinitions) {
    const role = await database.role.findUniqueOrThrow({
      where: {
        key: roleDefinition.key,
      },
    });

    for (const permissionKey of roleDefinition.permissions) {
      const permission = await database.permission.findUniqueOrThrow({
        where: {
          key: permissionKey,
        },
      });

      await database.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: permission.id,
        },
      });
    }
  }
}

async function seedUser(
  database: SeedDatabase,
  user: SeedUser,
  localProviderId: string,
) {
  let account = await database.account.findUnique({
    where: {
      loginName: user.loginName,
    },
  });
  let created = false;
  let passwordUpdated = false;

  if (!account) {
    const person = await database.person.create({
      data: {
        displayName: user.displayName,
      },
    });

    if (needsPersonalMemberProfile(user.type)) {
      await database.memberProfile.create({
        data: personalMemberProfileData(person.id, user.type),
      });
    }

    const passwordHash = await hashExactLocalPassword(user.password, 10);
    account = await database.account.create({
      data: {
        id: createAccountId(),
        type: user.type,
        loginName: user.loginName,
        passwordHash,
        authProviderId: localProviderId,
        personId: person.id,
        isActive: true,
        isSandbox: user.isSandbox,
      },
    });
    created = true;
  } else {
    let personId = account.personId;
    if (!personId) {
      const person = await database.person.create({
        data: {
          displayName: user.displayName,
        },
      });
      personId = person.id;
    }

    if (needsPersonalMemberProfile(user.type)) {
      await database.memberProfile.upsert({
        where: {
          personId,
        },
        update: personalMemberProfileUpdate(user.type),
        create: personalMemberProfileData(personId, user.type),
      });
    }

    const accountPatch = {
      authProviderId: localProviderId,
      personId,
      isSandbox: user.isSandbox,
    };
    const eligibilityChanged = account.type !== user.type || account.isActive !== true;
    if (eligibilityChanged) {
      await transitionAccountSecurity(database, {
        accountId: account.id,
        previousRevision: account.credentialRevision,
        previousType: account.type,
        previousIsActive: account.isActive,
        nextType: user.type,
        nextIsActive: true,
        twoFactorProviderId: account.twoFactorProviderId,
        accountData: accountPatch,
      });
      account = await database.account.findUniqueOrThrow({ where: { id: account.id } });
    } else {
      account = await database.account.update({
        where: { id: account.id },
        data: accountPatch,
      });
    }
    if (user.replaceExistingPassword) {
      if (account.passwordRecoveryLockedAt) {
        throw new Error("BOOTSTRAP_ADMIN_PASSWORD_RECOVERY_LOCKED");
      }
      const previousCredentialRevision = account.credentialRevision;
      const previousTwoFactorProviderId = account.twoFactorProviderId;
      const passwordHash = await hashExactLocalPassword(user.password, 10);
      const updated = await database.account.updateMany({
        where: {
          id: account.id,
          credentialRevision: previousCredentialRevision,
          passwordRecoveryLockedAt: null,
        },
        data: {
          passwordHash,
          credentialRevision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error("BOOTSTRAP_ADMIN_CREDENTIALS_CHANGED");
      }
      account = await database.account.findUniqueOrThrow({ where: { id: account.id } });
      await advanceTwoFactorAfterPasswordChange(database, {
        accountId: account.id,
        previousRevision: previousCredentialRevision,
        nextRevision: previousCredentialRevision + 1,
        twoFactorProviderId: previousTwoFactorProviderId,
      });
      const now = new Date();
      await database.session.updateMany({
        where: { accountId: account.id, endedAt: null },
        data: { endedAt: now },
      });
      await database.refreshToken.updateMany({
        where: { accountId: account.id, revokedAt: null },
        data: { revokedAt: now },
      });
    }
    passwordUpdated = user.replaceExistingPassword === true;
  }

  const role = await database.role.findUniqueOrThrow({
    where: {
      key: user.roleKey,
    },
  });

  await database.accountRole.upsert({
    where: {
      accountId_roleId: {
        accountId: account.id,
        roleId: role.id,
      },
    },
    update: {},
    create: {
      accountId: account.id,
      roleId: role.id,
    },
  });

  return {
    account,
    created,
    passwordUpdated,
  };
}

const systemSettingDefaults = [
  { key: "system.displayName", value: "Bonni Core" },
  {
    key: "system.branding",
    value: {
      schemaVersion: "bonni.branding/v1",
      revision: 0,
      displayName: "Bonni Core",
      logoAltText: "Bonni Logo",
      logo: null,
      updatedByAccountId: null,
    },
  },
  { key: "system.maintenanceMode", value: false },
  { key: "system.language", value: "de" },
  { key: "auth.mode", value: "LOCAL" },
  { key: "auth.oidc.enabled", value: false },
  { key: "auth.jwt.expiresIn", value: "8h" },
  { key: "runtime.database.operationMode", value: "server-only" },
  { key: "featureModules.installMode", value: "closed-runcontainer" },
  { key: "featureModules.requireRestartAfterInstall", value: true },
  { key: "update.inboxRoot", value: "UPDATE" },
];

async function seedSystemSettings(database: SeedDatabase) {
  for (const setting of systemSettingDefaults) {
    await database.systemSetting.upsert({
      where: { key: setting.key },
      update: {},
      create: {
        key: setting.key,
        value: setting.value,
      },
    });
  }
}

async function main(database: SeedDatabase) {
  console.log("Seed started");

  const { localProvider } = await seedAuthProvider(database);

  await seedPermissions(database);
  await seedRoles(database);
  await seedSystemSettings(database);

  const bootstrapPassword = resolveBootstrapAdminPassword(
    process.env.BONNI_BOOTSTRAP_ADMIN_PASSWORD,
  );
  const adminResult = await seedUser(database, {
    loginName: BOOTSTRAP_ADMIN_LOGIN_NAME,
    displayName: "Administrator",
    password: bootstrapPassword.password,
    replaceExistingPassword: bootstrapPassword.replaceExistingPassword,
    roleKey: "admin",
    type: AccountType.ADMIN,
    isSandbox: false,
  }, localProvider.id);

  if (adminResult.created) {
    console.log(
      bootstrapPassword.usesStandardPassword
        ? "Bootstrap-Administrator admin wurde mit dem Standardkennwort angelegt."
        : "Bootstrap-Administrator admin wurde mit dem konfigurierten Kennwort angelegt.",
    );
  } else if (adminResult.passwordUpdated) {
    console.log("Das Kennwort des vorhandenen Bootstrap-Administrators wurde explizit aktualisiert.");
  } else {
    console.log("Vorhandener Bootstrap-Administrator beibehalten; Kennwort wurde nicht verändert.");
  }

  console.log("Seed finished");
}

async function verifyBootstrapAdministrator(database: SeedDatabase) {
  const administrator = await database.account.findUnique({
    where: {
      loginName: BOOTSTRAP_ADMIN_LOGIN_NAME,
    },
    include: {
      roles: {
        include: {
          role: true,
        },
      },
    },
  });

  if (!administrator) {
    throw new Error("BOOTSTRAP_ADMIN_MISSING_AFTER_SEED");
  }
  if (!administrator.isActive) {
    throw new Error("BOOTSTRAP_ADMIN_INACTIVE_AFTER_SEED");
  }
  if (administrator.type !== AccountType.ADMIN) {
    throw new Error("BOOTSTRAP_ADMIN_TYPE_INVALID_AFTER_SEED");
  }
  if (!administrator.roles.some(({ role }) => role.key === "admin")) {
    throw new Error("BOOTSTRAP_ADMIN_ROLE_MISSING_AFTER_SEED");
  }
  if (!administrator.personId) {
    throw new Error("BOOTSTRAP_ADMIN_PERSON_MISSING_AFTER_SEED");
  }

  const memberProfile = await database.memberProfile.findUnique({
    where: {
      personId: administrator.personId,
    },
    select: {
      id: true,
      status: true,
    },
  });

  if (!memberProfile || memberProfile.status !== MemberStatus.MEMBER) {
    throw new Error("BOOTSTRAP_ADMIN_MEMBER_PROFILE_MISSING_AFTER_SEED");
  }

  console.log(
    "Bootstrap-Administrator admin ist als sichtbares Mitglied im Core-Schema vorhanden, aktiv und besitzt die Administratorrolle.",
  );
}

async function verifyCentralLoginDatabase() {
  const administrator = await getServerPrismaClient("core").account.findUnique({
    where: {
      loginName: BOOTSTRAP_ADMIN_LOGIN_NAME,
    },
    select: {
      id: true,
      isActive: true,
      passwordHash: true,
    },
  });

  if (!administrator) {
    throw new Error("BOOTSTRAP_ADMIN_NOT_VISIBLE_TO_LOGIN");
  }
  if (!administrator.isActive || !administrator.passwordHash) {
    throw new Error("BOOTSTRAP_ADMIN_NOT_LOGIN_READY");
  }

  console.log(
    "Zentrale Anmeldung sieht den aktiven Bootstrap-Administrator im Core-Schema.",
  );
}

export async function seedSystemDatabase() {
  // Seed and login must use the exact same isolated Core connection. A raw
  // PrismaClient would use DATABASE_URL directly and could silently target
  // `public`, while the running application correctly reads from `core`.
  const prisma = getDatabaseTargetPrismaClient("normal", "core");

  try {
    await prisma.$transaction(
      async (transaction) => {
        await main(transaction);
        await verifyBootstrapAdministrator(transaction);
      },
      {
        maxWait: 10_000,
        timeout: 30_000,
      },
    );
    // Use the same routed server client as /api/identity/auth/login. Setup
    // must never report success if seed and login point to different targets.
    await verifyCentralLoginDatabase();
  } finally {
    await disconnectPrismaClients();
  }
}
