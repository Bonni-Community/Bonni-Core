import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.session.updateMany({
    where: {
      endedAt: null,
    },
    data: {
      endedAt: new Date(),
    },
  });

  console.log("Open sessions closed:", result.count);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
