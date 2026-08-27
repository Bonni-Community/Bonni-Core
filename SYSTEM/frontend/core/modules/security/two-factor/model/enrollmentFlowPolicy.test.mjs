import assert from "node:assert/strict";
import test from "node:test";

import {
  isCompleteTotpCode,
  retainTotpSetupAfterError,
} from "./enrollmentFlowPolicy.js";

test("TOTP-Bestaetigung akzeptiert nur vollstaendige 6- oder 8-stellige Codes", () => {
  assert.equal(isCompleteTotpCode("123456"), true);
  assert.equal(isCompleteTotpCode("12345678"), true);
  assert.equal(isCompleteTotpCode("123"), false);
  assert.equal(isCompleteTotpCode(" 123456"), false);
});

test("falscher Code behaelt den einmal sichtbaren QR bis zum Auftragsablauf", () => {
  assert.equal(retainTotpSetupAfterError({ code: "TWO_FACTOR_INVALID_CODE" }), true);
  assert.equal(retainTotpSetupAfterError({ code: "TWO_FACTOR_TEMPORARILY_LOCKED" }), true);
  assert.equal(retainTotpSetupAfterError({ code: "TWO_FACTOR_PAYLOAD_INVALID" }), true);
  assert.equal(retainTotpSetupAfterError({ code: "BACKEND_UNAVAILABLE" }), false);
});
