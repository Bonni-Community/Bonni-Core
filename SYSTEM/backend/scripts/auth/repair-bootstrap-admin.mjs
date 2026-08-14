import { ensureJwtSecret } from "./ensure-jwt-secret.mjs";

await ensureJwtSecret();
await import("dotenv/config");
const { seedSystemDatabase } = await import(
  "../../dist/system/database/seed-system.js"
);

console.log(
  "[bonni-core] Repariere ausschließlich den lokalen Bootstrap-Administrator `admin`.",
);

const previousPassword = process.env.BONNI_BOOTSTRAP_ADMIN_PASSWORD;
process.env.BONNI_BOOTSTRAP_ADMIN_PASSWORD = "hamster";

try {
  await seedSystemDatabase();
  console.log(
    "[bonni-core] Admin-Reparatur abgeschlossen. Anmeldung: admin / hamster",
  );
} finally {
  if (previousPassword === undefined) {
    delete process.env.BONNI_BOOTSTRAP_ADMIN_PASSWORD;
  } else {
    process.env.BONNI_BOOTSTRAP_ADMIN_PASSWORD = previousPassword;
  }
}
