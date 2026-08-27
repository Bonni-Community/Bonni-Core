import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulesRoot = path.join(backendRoot, "src/core/modules");
const coreModules = [
  "identity",
  "security",
  "authorization",
  "organization",
  "platform",
  "system",
  "governance",
];

test("the seven Core ownership modules are live from the canonical Core barrel", async () => {
  for (const moduleName of coreModules) {
    assert.equal((await stat(path.join(modulesRoot, moduleName, "README.md"))).isFile(), true);
    assert.equal((await stat(path.join(modulesRoot, moduleName, "index.ts"))).isFile(), true);
  }
  const moduleBarrel = await readFile(path.join(modulesRoot, "index.ts"), "utf8");
  const coreBarrel = await readFile(path.join(backendRoot, "src/core/core.ts"), "utf8");
  for (const moduleName of coreModules) {
    assert.match(moduleBarrel, new RegExp(`\\./${moduleName}/index\\.js`, "u"));
  }
  assert.match(coreBarrel, /\.\/modules\/index\.js/u);
});

test("Core Security is the only TOTP owner and legacy platform files are compatibility adapters", async () => {
  const canonicalService = await readFile(
    path.join(modulesRoot, "security/two-factor/service.ts"),
    "utf8",
  );
  assert.match(canonicalService, /adminCreateEnrollment/u);
  assert.match(canonicalService, /setupTotp/u);
  assert.match(canonicalService, /confirmTotp/u);
  assert.match(canonicalService, /lastAcceptedTotpCounter/u);

  const wrappers = [
    "src/platform/security/two-factor/services/two-factor.service.ts",
    "src/platform/security/two-factor/schemas/two-factor.schemas.ts",
    "src/platform/security/two-factor/routes/two-factor.routes.ts",
    "src/platform/security/two-factor/module-two-factor-runtime.ts",
    "src/platform/security/two-factor/two-factor-provider-registry.ts",
  ];
  for (const relative of wrappers) {
    const source = await readFile(path.join(backendRoot, relative), "utf8");
    assert.match(source, /Compatibility surface/u);
    assert.doesNotMatch(source, /bcrypt|generateTotpSecret|securityTwoFactorCredential\.create/u);
    assert.ok(source.split("\n").length <= 5, `${relative} contains duplicate business logic`);
  }

  const routes = await readFile(path.join(backendRoot, "src/system/routes/registerCoreRoutes.ts"), "utf8");
  assert.match(routes, /core\/modules\/security\/two-factor/u);
});

test("package and lock both carry the runtime QR dependency", async () => {
  const packageJson = JSON.parse(await readFile(path.join(backendRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(backendRoot, "package-lock.json"), "utf8"));
  assert.equal(packageJson.dependencies.qrcode, "^1.5.4");
  assert.equal(packageJson.devDependencies["@types/qrcode"], "^1.5.5");
  assert.equal(packageLock.packages[""].dependencies.qrcode, "^1.5.4");
  assert.ok(packageLock.packages["node_modules/qrcode"]);
});

test("private Core runtimes stay locked for an enrolled but unavailable provider", async () => {
  for (const relative of [
    "src/core/protected-people/protected-people-runtime.ts",
    "src/core/protected-organization/protected-organization-runtime.ts",
  ]) {
    const source = await readFile(path.join(backendRoot, relative), "utf8");
    assert.match(
      source,
      /status\.privateDataProtectionEnrolled\s*===\s*true\s*\|\|\s*status\.enabled\s*===\s*true/u,
    );
    assert.doesNotMatch(
      source,
      /enrolled:\s*status\.privateDataProtectionEnrolled\s*===\s*true\s*\|\|\s*available/u,
    );
  }
});

test("an active local credential repairs missing enrollment evidence", async () => {
  const source = await readFile(
    path.join(modulesRoot, "security/two-factor/service.ts"),
    "utf8",
  );
  assert.match(source, /Boolean\(account\.twoFactorEnrolledAt\s*\|\|\s*localCredential\)/u);
  assert.match(source, /twoFactorEnrolledAt:\s*enrolledAt/u);
  assert.match(source, /privateDataTwoFactorEnrolledAt:\s*enrolledAt/u);
});

test("TOTP confirmation performs the enrollment expiry CAS inside its transaction", async () => {
  const source = await readFile(
    path.join(modulesRoot, "security/two-factor/service.ts"),
    "utf8",
  );
  assert.match(source, /const txNow = new Date\(\);/u);
  assert.match(source, /expiresAt:\s*\{\s*gt:\s*txNow\s*\}/u);
  assert.ok(
    source.indexOf("expiresAt: { gt: txNow }")
      < source.indexOf("const activated = await tx.securityTwoFactorCredential.updateMany"),
  );
});

test("local, recovery and external challenge verification recheck the 60-second expiry", async () => {
  const source = await readFile(
    path.join(modulesRoot, "security/two-factor/service.ts"),
    "utf8",
  );
  const verifySource = source.slice(
    source.indexOf("export async function verifyChallenge"),
    source.indexOf("export async function verifyLoginChallenge"),
  );
  assert.ok(
    (verifySource.match(/expiresAt:\s*\{\s*gt:\s*txNow\s*\}/gu) || []).length >= 2,
    "TOTP and recovery transactions must both bind their CAS to the post-proof time",
  );
  assert.match(verifySource, /expiresAt:\s*\{\s*gt:\s*verifiedAt\s*\}/u);
  assert.match(source, /expiresAt:\s*\{\s*gt:\s*failureNow\s*\}/u);
});

test("every encrypted TOTP secret revoke also shreds its fingerprint", async () => {
  const source = await readFile(
    path.join(modulesRoot, "security/two-factor/service.ts"),
    "utf8",
  );
  const revokeWrites = [...source.matchAll(/data:\s*\{[^{}]*secretEncrypted:\s*null[^{}]*\}/gu)];
  assert.ok(revokeWrites.length >= 5);
  for (const [write] of revokeWrites) {
    assert.match(write, /secretFingerprint:\s*null/u);
  }
});

test("challenge consumption rechecks interactive account eligibility before and after its CAS", async () => {
  const source = await readFile(
    path.join(modulesRoot, "security/two-factor/service.ts"),
    "utf8",
  );
  const consumeSource = source.slice(source.indexOf("export async function consumeVerifiedChallenge"));
  assert.ok((consumeSource.match(/assertInteractiveLocalAccount\(/gu) || []).length >= 2);
  assert.ok((consumeSource.match(/isActive:\s*true/gu) || []).length >= 2);
  assert.ok((consumeSource.match(/passwordHash:\s*true/gu) || []).length >= 2);
  assert.match(consumeSource, /isolationLevel:\s*"Serializable"/u);
});

test("all account eligibility transitions cross the canonical Core Security revision boundary", async () => {
  const transition = await readFile(
    path.join(modulesRoot, "security/two-factor/account-security-transition.ts"),
    "utf8",
  );
  assert.match(transition, /credentialRevision:\s*input\.previousRevision/u);
  assert.match(transition, /type:\s*input\.previousType/u);
  assert.match(transition, /isActive:\s*input\.previousIsActive/u);
  assert.match(transition, /credentialRevision:\s*\{\s*increment:\s*1/u);
  assert.match(transition, /passwordHash:\s*null/u);
  assert.match(transition, /twoFactorProviderId:\s*null/u);
  assert.match(transition, /secretEncrypted:\s*null/u);
  assert.match(transition, /secretFingerprint:\s*null/u);
  assert.match(transition, /securityTwoFactorRecoveryCode\.deleteMany/u);
  assert.match(transition, /securityTwoFactorEnrollment\.updateMany/u);
  assert.match(transition, /securityTwoFactorChallenge\.updateMany/u);
  assert.match(transition, /session\.updateMany/u);
  assert.match(transition, /refreshToken\.updateMany/u);

  for (const relative of [
    "src/platform/auth/users/users.mutations.service.ts",
    "src/platform/auth/terminal-accounts/terminal-account.service.ts",
    "src/platform/auth/service-accounts/service-account.service.ts",
    "src/system/database/seed-system.ts",
  ]) {
    const source = await readFile(path.join(backendRoot, relative), "utf8");
    assert.match(source, /transitionAccountSecurity\(/u, `${relative} bypasses the security transition`);
  }
});
