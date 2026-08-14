import { seedSystemDatabase } from "../src/system/database/seed-system.js";

try {
  await seedSystemDatabase();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
