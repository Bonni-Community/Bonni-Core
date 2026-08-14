import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveBootstrapAdminPassword } from "../dist/platform/auth/bootstrap-admin-password.js";
import {
  BOOTSTRAP_ADMIN_LOGIN_NAME,
  isBootstrapAdminLoginName,
  isForbiddenInteractiveLoginName,
} from "../dist/platform/auth/system-account-policy.js";
import { normalizeLoginError } from "../dist/core/errors/login-error.js";
import { resolveDatabaseBootstrapAction } from "../scripts/runtime/database-bootstrap-policy.mjs";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("fresh installation uses admin/hamster without resetting an existing password", () => {
  assert.deepEqual(resolveBootstrapAdminPassword(undefined), {
    password: "hamster",
    replaceExistingPassword: false,
    usesStandardPassword: true,
  });
});

test("the first login is fixed to admin and root is forbidden", () => {
  assert.equal(BOOTSTRAP_ADMIN_LOGIN_NAME, "admin");
  assert.equal(isBootstrapAdminLoginName(" ADMIN "), true);
  assert.equal(isForbiddenInteractiveLoginName("root"), true);
  assert.equal(isForbiddenInteractiveLoginName(" ROOT "), true);
  assert.equal(isForbiddenInteractiveLoginName("member"), false);
});

test("user mutations protect admin and reject root", async () => {
  const mutations = await readFile(
    path.join(
      backendRoot,
      "src",
      "platform",
      "auth",
      "users",
      "users.mutations.service.ts",
    ),
    "utf8",
  );
  const authRoutes = await readFile(
    path.join(backendRoot, "src", "platform", "auth", "routes", "auth.routes.ts"),
    "utf8",
  );

  assert.match(mutations, /LOCAL_MEMBER_LOGIN_FORBIDDEN/);
  assert.match(mutations, /BOOTSTRAP_ADMIN_LOGIN_IMMUTABLE/);
  assert.match(mutations, /BOOTSTRAP_ADMIN_DEACTIVATION_FORBIDDEN/);
  assert.match(mutations, /BOOTSTRAP_ADMIN_DELETE_FORBIDDEN/);
  assert.match(authRoutes, /LOGIN_NAME_FORBIDDEN/);
});

test("explicit hamster can repair the bootstrap password", () => {
  assert.deepEqual(resolveBootstrapAdminPassword("hamster"), {
    password: "hamster",
    replaceExistingPassword: true,
    usesStandardPassword: true,
  });
});

test("an explicitly configured strong password replaces the bootstrap password", () => {
  assert.deepEqual(resolveBootstrapAdminPassword("Bonni!Bootstrap!2026"), {
    password: "Bonni!Bootstrap!2026",
    replaceExistingPassword: true,
    usesStandardPassword: false,
  });
});

test("other weak bootstrap passwords remain blocked", () => {
  assert.throws(
    () => resolveBootstrapAdminPassword("weak"),
    /BONNI_BOOTSTRAP_ADMIN_PASSWORD_WEAK/,
  );
});

test("setup bootstraps every isolated database before generating and seeding", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(backendRoot, "package.json"), "utf8"),
  );
  const setupScript = await readFile(
    path.join(backendRoot, "scripts", "setup", "setup-system.mjs"),
    "utf8",
  );
  assert.equal(
    packageJson.scripts.setup,
    "node scripts/setup/setup-system.mjs",
  );
  assert.match(packageJson.scripts.build, /npm run build:code/);
  assert.match(packageJson.scripts["build:code"], /npm run seed:typecheck/);
  assert.match(setupScript, /Backend-Abhängigkeiten installieren\/aktualisieren/);
  assert.match(setupScript, /Frontend-Abhängigkeiten installieren\/aktualisieren/);
  assert.match(setupScript, /"run", "maintenance:cleanup"/);
  assert.match(setupScript, /"run",\s*"database:bootstrap"/);
  assert.match(setupScript, /"run",\s*"prisma:generate"/);
  assert.match(setupScript, /"run",\s*"seed"/);
  assert.match(setupScript, /"run",\s*"build:code"/);
  assert.match(setupScript, /await publishFrontend\(\)/);
  assert.match(setupScript, /Systemstart: npm start/);
  assert.match(setupScript, /Standardzugang einer neuen Installation: admin \/ hamster/);
  assert.ok(
    setupScript.indexOf('"database:bootstrap"') < setupScript.indexOf('"seed"'),
  );
});

test("the explicit admin repair command resets only through the guarded seed", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(backendRoot, "package.json"), "utf8"),
  );
  const repairScript = await readFile(
    path.join(backendRoot, "scripts", "auth", "repair-bootstrap-admin.mjs"),
    "utf8",
  );

  assert.equal(
    packageJson.scripts["admin:repair"],
    "node scripts/auth/repair-bootstrap-admin.mjs",
  );
  assert.match(
    repairScript,
    /await import\(\s*"\.\.\/\.\.\/dist\/system\/database\/seed-system\.js"\s*\)/,
  );
  assert.match(repairScript, /await import\("dotenv\/config"\)/);
  assert.match(repairScript, /await ensureJwtSecret\(\)/);
  assert.match(repairScript, /BONNI_BOOTSTRAP_ADMIN_PASSWORD\s*=\s*"hamster"/);
  assert.match(repairScript, /await seedSystemDatabase\(\)/);
  assert.doesNotMatch(repairScript, /\btsx\b|force-reset|deleteMany|delete\(/);
});

test("the production bootstrap seeds a missing admin without requiring tsx", async () => {
  const runtimeBootstrap = await readFile(
    path.join(
      backendRoot,
      "scripts",
      "runtime",
      "bootstrap-production-database.mjs",
    ),
    "utf8",
  );
  const composeRuntime = await readFile(
    path.join(backendRoot, "docker-compose.runtime.yml"),
    "utf8",
  );
  const dockerfile = await readFile(
    path.join(backendRoot, "Dockerfile"),
    "utf8",
  );
  const systemSeed = await readFile(
    path.join(backendRoot, "src", "system", "database", "seed-system.ts"),
    "utf8",
  );
  const tsconfig = JSON.parse(
    await readFile(path.join(backendRoot, "tsconfig.json"), "utf8"),
  );

  assert.match(
    runtimeBootstrap,
    /import \{ seedSystemDatabase \} from "\.\.\/\.\.\/dist\/system\/database\/seed-system\.js"/,
  );
  assert.match(runtimeBootstrap, /resolveDatabaseBootstrapAction\(accountState\)/);
  assert.match(runtimeBootstrap, /await seedSystemDatabase\(\)/);
  assert.match(runtimeBootstrap, /if \(!seededState\.adminExists\)/);
  assert.match(runtimeBootstrap, /const CORE_SCHEMA = "core"/);
  assert.doesNotMatch(runtimeBootstrap, /table_schema = 'public'/);
  assert.doesNotMatch(runtimeBootstrap, /\btsx\b/);
  assert.ok(tsconfig.files.includes("src/system/database/seed-system.ts"));
  assert.match(systemSeed, /await prisma\.\$transaction\(/);
  assert.match(
    systemSeed,
    /getDatabaseTargetPrismaClient\("normal", "core"\)/,
  );
  assert.match(systemSeed, /verifyBootstrapAdministrator\(transaction\)/);
  assert.match(systemSeed, /verifyCentralLoginDatabase\(\)/);
  assert.match(systemSeed, /BOOTSTRAP_ADMIN_NOT_VISIBLE_TO_LOGIN/);
  assert.match(systemSeed, /BOOTSTRAP_ADMIN_MISSING_AFTER_SEED/);
  assert.match(systemSeed, /BOOTSTRAP_ADMIN_INACTIVE_AFTER_SEED/);
  assert.match(systemSeed, /BOOTSTRAP_ADMIN_ROLE_MISSING_AFTER_SEED/);
  assert.match(systemSeed, /needsPersonalMemberProfile\(user\.type\)/);
  assert.match(systemSeed, /type === AccountType\.MEMBER \|\| type === AccountType\.ADMIN/);
  assert.match(systemSeed, /BOOTSTRAP_ADMIN_MEMBER_PROFILE_MISSING_AFTER_SEED/);
  assert.doesNotMatch(systemSeed, /new PrismaClient\(/);
  assert.match(dockerfile, /COPY System\/backend\/tsconfig\.seed\.json \.\//);
  assert.match(
    composeRuntime,
    /BONNI_BOOTSTRAP_ADMIN_PASSWORD: \$\{BONNI_BOOTSTRAP_ADMIN_PASSWORD:-\}/,
  );
});

test("npm start verifies the bootstrap administrator in the running backend process", async () => {
  const runServer = await readFile(
    path.join(backendRoot, "src", "system", "server", "run-server.ts"),
    "utf8",
  );

  assert.match(
    runServer,
    /import \{ seedSystemDatabase \} from "\.\.\/database\/seed-system\.js"/,
  );
  assert.match(runServer, /await seedSystemDatabase\(\)/);
  assert.ok(
    runServer.indexOf("await seedSystemDatabase()")
      < runServer.indexOf("const app = await createPlatformApp()"),
  );
  assert.match(runServer, /Central login bootstrap completed/);
});

test("the production bootstrap seeds automatically only when safe or explicitly requested", () => {
  assert.equal(
    resolveDatabaseBootstrapAction({
      accountTableExists: true,
      accountCount: 0,
      adminExists: false,
    }),
    "seed",
  );
  assert.equal(
    resolveDatabaseBootstrapAction({
      accountTableExists: true,
      accountCount: 4,
      adminExists: true,
    }),
    "skip",
  );
  assert.equal(
    resolveDatabaseBootstrapAction({
      accountTableExists: true,
      accountCount: 4,
      adminExists: true,
      repairRequested: true,
    }),
    "seed",
  );
  assert.equal(
    resolveDatabaseBootstrapAction({
      accountTableExists: true,
      accountCount: 3,
      adminExists: false,
      repairRequested: true,
    }),
    "seed",
  );
  assert.throws(
    () => resolveDatabaseBootstrapAction({
      accountTableExists: true,
      accountCount: 3,
      adminExists: false,
    }),
    /Es bestehen Benutzerkonten, aber kein `admin`/,
  );
  assert.throws(
    () => resolveDatabaseBootstrapAction({
      accountTableExists: false,
      accountCount: 0,
      adminExists: false,
    }),
    /Account-Tabelle fehlt/,
  );
});

test("a weak JWT secret produces an actionable login error", () => {
  assert.deepEqual(
    normalizeLoginError({
      code: "JWT_SECRET_MISSING_OR_WEAK",
      message: "JWT_SECRET_MISSING_OR_WEAK",
    }),
    {
      status: 500,
      code: "JWT_SECRET_MISSING_OR_WEAK",
      message:
        "JWT_SECRET fehlt oder ist unsicher. Bitte in System/backend/.env "
        + "einen zufälligen Wert mit mindestens 32 Zeichen setzen und das Backend neu starten.",
    },
  );
});
