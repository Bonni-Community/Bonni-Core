import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const {
  buildTotpOtpauthUri,
  buildTotpQrCodeDataUrl,
  generateEnrollmentPassword,
  generateTotpSecret,
  normalizeRecoveryCode,
} = await import(process.env.BONNI_TEST_SOURCE === "1"
  ? "../src/core/modules/security/two-factor/totp.ts"
  : "../dist/core/modules/security/two-factor/totp.js");

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Core generates a real PNG QR from a 160-bit local TOTP secret", async () => {
  const secret = generateTotpSecret();
  assert.equal(secret.length, 32);
  const uri = buildTotpOtpauthUri({ issuer: "Bonni Core", label: "account:7", secret });
  const dataUrl = await buildTotpQrCodeDataUrl(uri);
  assert.match(dataUrl, /^data:image\/png;base64,/u);
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("admin enrollment password contains exactly 160 random bits", () => {
  const password = generateEnrollmentPassword();
  assert.match(password, /^[A-Za-z0-9_-]{27}$/u);
  assert.equal(Buffer.from(password, "base64url").length, 20);
});

test("recovery proofs use the exact displayed canonical form", () => {
  assert.equal(normalizeRecoveryCode("ABCD-EFGH-JKLM-NPQR"), "ABCD-EFGH-JKLM-NPQR");
  assert.throws(() => normalizeRecoveryCode("abcd-efgh-jklm-npqr"), /FORMAT_INVALID/u);
  assert.throws(() => normalizeRecoveryCode("ABCDEFGHIJKLMNOP"), /FORMAT_INVALID/u);
});

test("HTTP setup response exposes PNG only and never the otpauth URI or manual secret", async () => {
  const service = await readFile(
    path.join(backendRoot, "src/core/modules/security/two-factor/service.ts"),
    "utf8",
  );
  const response = service.slice(service.indexOf("return Object.freeze({", service.indexOf("export async function setupTotp")), service.indexOf("async function createRecoveryCodes"));
  assert.match(response, /qrCodeDataUrl/u);
  assert.doesNotMatch(response, /otpauthUri\s*[,}]/u);
  assert.doesNotMatch(response, /\bsecret\s*[,}]/u);
});
