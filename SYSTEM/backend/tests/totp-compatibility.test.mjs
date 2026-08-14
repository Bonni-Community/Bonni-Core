import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTotpOtpauthUri,
  getTotpDigits,
} from "../dist/platform/security/two-factor/services/totp.js";

test("new TOTP setups use the broadly compatible six-digit otpauth default", () => {
  const previous = process.env.TWO_FACTOR_TOTP_DIGITS;
  try {
    delete process.env.TWO_FACTOR_TOTP_DIGITS;
    assert.equal(getTotpDigits(), 6);
    const uri = buildTotpOtpauthUri({
      issuer: "Bonni Core",
      label: "max.mustermann",
      secret: "JBSWY3DPEHPK3PXP",
    });
    assert.match(uri, /algorithm=SHA1/);
    assert.match(uri, /digits=6/);
    assert.match(uri, /period=30/);
  } finally {
    if (previous === undefined) delete process.env.TWO_FACTOR_TOTP_DIGITS;
    else process.env.TWO_FACTOR_TOTP_DIGITS = previous;
  }
});

test("existing installations may retain eight-digit TOTP codes", () => {
  const previous = process.env.TWO_FACTOR_TOTP_DIGITS;
  try {
    process.env.TWO_FACTOR_TOTP_DIGITS = "8";
    assert.equal(getTotpDigits(), 8);
  } finally {
    if (previous === undefined) delete process.env.TWO_FACTOR_TOTP_DIGITS;
    else process.env.TWO_FACTOR_TOTP_DIGITS = previous;
  }
});
