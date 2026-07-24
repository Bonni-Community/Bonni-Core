import "dotenv/config";
import { PrismaClient, AccountType, AuthProviderType } from "@prisma/client";
import bcrypt from "bcryptjs";

import { ensureLocalBootstrapAdminAccess } from "../src/platform/auth/bootstrap-admin-access.js";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("hamster", 10);

  const provider = await prisma.authProvider.upsert({
    where: { key: "local" },
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

  let person = await prisma.person.findFirst({ where: { displayName: "admin" } });
  if (!person) {
    person = await prisma.person.create({ data: { displayName: "admin" } });
  }

  const account = await prisma.account.upsert({
    where: { loginName: "admin" },
    update: {
      type: AccountType.ADMIN,
      passwordHash,
      authProviderId: provider.id,
      personId: person.id,
      isActive: true,
      isSandbox: false,
    },
    create: {
      type: AccountType.ADMIN,
      loginName: "admin",
      passwordHash,
      authProviderId: provider.id,
      personId: person.id,
      isActive: true,
      isSandbox: false,
    },
  });

  await ensureLocalBootstrapAdminAccess(prisma, {
    ...account,
    authProvider: provider,
    roles: [],
  });

  console.log("Admin Passwort gesetzt: admin / hamster");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
