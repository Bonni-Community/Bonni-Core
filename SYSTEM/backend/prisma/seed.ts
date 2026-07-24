import {
  PrismaClient,
  AccountType,
  AuthProviderType,
} from "@prisma/client";
import bcrypt from "bcryptjs";

import { createAccountId, createMemberId } from "../src/platform/security/crypto/id.js";

const prisma = new PrismaClient();

// Seed policy: only technical/system data.
// Business data like products, product categories, packaging nodes and packaging attributes
// must be created manually through the application.

type SeedUser = {
  loginName: string;
  displayName: string;
  password: string;
  roleKey: string;
  type: AccountType;
  isSandbox: boolean;
  memberCapabilities?: string[];
};

const users: SeedUser[] = [
  {
    loginName: "admin",
    displayName: "admin",
    password: "hamster",
    roleKey: "admin",
    type: AccountType.ADMIN,
    isSandbox: false,
  },
];

const permissions = [
  "system.admin",
  "system.settings.read",
  "system.settings.write",
  "auth.users.read",
  "auth.users.write",
  "stewardship.read",
  "stewardship.write",
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



const memberCapabilities = [
  {
    key: "TREASURER",
    label: "Treasurer",
  },
  {
    key: "STOREMAN",
    label: "Storeman",
  },
  {
    key: "MANAGER",
    label: "Manager",
  },
  {
    key: "HELPER",
    label: "Helper",
  },
];

const memberCapabilityPermissions = {
  MANAGER: [
    "members.read",
    "members.write",
    "products.read",
    "products.write",
    "stewardship.read",
    "stewardship.write",
  ],

  TREASURER: [
    "cashbook.read",
    "cashbook.write",
  ],

  STOREMAN: [
    "products.read",
    "products.write",
  ],

  HELPER: [
    "members.read",
  ],
};

async function seedAuthProvider() {
  const localProvider = await prisma.authProvider.upsert({
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

  const sandboxProvider = await prisma.authProvider.upsert({
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

async function seedPermissions() {
  for (const permissionKey of permissions) {
    await prisma.permission.upsert({
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

async function seedRoles() {
  for (const roleDefinition of roleDefinitions) {
    await prisma.role.upsert({
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
    const role = await prisma.role.findUniqueOrThrow({
      where: {
        key: roleDefinition.key,
      },
    });

    for (const permissionKey of roleDefinition.permissions) {
      const permission = await prisma.permission.findUniqueOrThrow({
        where: {
          key: permissionKey,
        },
      });

      await prisma.rolePermission.upsert({
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

async function seedMemberCapabilities() {
  for (const capability of memberCapabilities) {
    await prisma.memberCapability.upsert({
      where: {
        key: capability.key as any,
      },
      update: {
        label: capability.label,
      },
      create: {
        key: capability.key as any,
        label: capability.label,
      },
    });
  }
}

async function setMemberCapabilitiesForAccount(
  accountId: string,
  capabilityKeys: string[] = []
) {
  await prisma.accountMemberCapability.deleteMany({
    where: {
      accountId,
    },
  });

  if (!capabilityKeys.length) {
    return;
  }

  const capabilities = await prisma.memberCapability.findMany({
    where: {
      key: {
        in: capabilityKeys as any,
      },
    },
  });

  for (const capability of capabilities) {
    await prisma.accountMemberCapability.upsert({
      where: {
        accountId_capabilityId: {
          accountId,
          capabilityId: capability.id,
        },
      },
      update: {},
      create: {
        accountId,
        capabilityId: capability.id,
      },
    });
  }
}

async function seedUser(user: SeedUser, localProviderId: string) {
  let person = await prisma.person.findFirst({
    where: {
      displayName: user.displayName,
    },
  });

  if (!person) {
    person = await prisma.person.create({
      data: {
        displayName: user.displayName,
      },
    });
  } else {
    person = await prisma.person.update({
      where: {
        id: person.id,
      },
      data: {
        displayName: user.displayName,
      },
    });
  }

  if (user.type === AccountType.MEMBER) {
    await prisma.memberProfile.upsert({
      where: {
        personId: person.id,
      },
      update: {
        status: "MEMBER",
      },
      create: {
        id: createMemberId(),
        personId: person.id,
        status: "MEMBER",
        joinedAt: new Date(),
        notes: "Seed member",
      },
    });
  }

  const passwordHash = await bcrypt.hash(user.password, 10);

  let account = await prisma.account.findUnique({
    where: {
      loginName: user.loginName,
    },
  });

  if (!account) {
    account = await prisma.account.create({
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
  } else {
    account = await prisma.account.update({
      where: {
        id: account.id,
      },
      data: {
        type: user.type,
        passwordHash,
        authProviderId: localProviderId,
        personId: person.id,
        isActive: true,
        isSandbox: user.isSandbox,
      },
    });
  }

  const role = await prisma.role.findUniqueOrThrow({
    where: {
      key: user.roleKey,
    },
  });

  await prisma.accountRole.upsert({
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

  await setMemberCapabilitiesForAccount(
    account.id,
    user.memberCapabilities || []
  );

  return account;
}



const systemSettingDefaults = [
  { key: "system.displayName", value: "Bonni Core" },
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

async function seedSystemSettings() {
  for (const setting of systemSettingDefaults) {
    await prisma.systemSetting.upsert({
      where: { key: setting.key },
      update: {},
      create: {
        key: setting.key,
        value: setting.value,
      },
    });
  }
}

async function main() {
  console.log("Seed started");

  const { localProvider } = await seedAuthProvider();

  await seedPermissions();
  await seedRoles();
  await seedMemberCapabilities();
  await seedMemberCapabilityPermissions();
  await seedSystemSettings();


  for (const user of users) {
    await seedUser(user, localProvider.id);
  }

async function seedMemberCapabilityPermissions() {
  for (const [capabilityKey, permissionKeys] of Object.entries(
    memberCapabilityPermissions
  )) {
    const capability = await prisma.memberCapability.findUniqueOrThrow({
      where: {
        key: capabilityKey as any,
      },
    });

    for (const permissionKey of permissionKeys) {
      const permission = await prisma.permission.findUnique({
  where: {
    key: permissionKey,
  },
});

if (!permission) {
  console.log("FEHLENDE PERMISSION:", permissionKey);
  continue;
}

      await prisma.memberCapabilityPermission.upsert({
        where: {
          capabilityId_permissionId: {
            capabilityId: capability.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          capabilityId: capability.id,
          permissionId: permission.id,
        },
      });
    }
  }
}

  console.log("==================================");
  console.log("Seed finished");
  console.log("==================================");
  console.log("Logins:");
  console.log("admin / hamster");
  console.log("==================================");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
