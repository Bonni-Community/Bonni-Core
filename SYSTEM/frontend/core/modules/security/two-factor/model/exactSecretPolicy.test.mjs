import assert from "node:assert/strict";
import test from "node:test";

import {
  countUnicodeCodePoints,
  hasExactUtf8RoundTrip,
  hasLoneSurrogate,
  secretInputWouldBeInvalid,
  validateExactSecret,
} from "./exactSecretPolicy.js";

test("password limit counts Unicode code points instead of UTF-16 code units", () => {
  const exactly512Emoji = "😀".repeat(512);
  const tooManyEmoji = "😀".repeat(513);

  assert.equal(countUnicodeCodePoints(exactly512Emoji), 512);
  assert.equal(validateExactSecret(exactly512Emoji), "");
  assert.equal(secretInputWouldBeInvalid(exactly512Emoji), false);
  assert.match(validateExactSecret(tooManyEmoji), /hoechstens 512/);
  assert.equal(secretInputWouldBeInvalid(tooManyEmoji), true);
});

test("exact secret policy rejects controls and invalid UTF-8 round trips", () => {
  for (const value of ["a\rb", "a\nb", "a\0b"]) {
    assert.notEqual(validateExactSecret(value), "");
  }
  assert.equal(hasLoneSurrogate("\uD800"), true);
  assert.equal(hasExactUtf8RoundTrip("\uD800"), false);
  assert.match(validateExactSecret("\uD800"), /Unicode/);
});

test("exact secret policy neither trims nor normalizes valid input", () => {
  const exact = "  Pässwort mit Rand  ";
  assert.equal(validateExactSecret(exact), "");
  assert.equal(hasExactUtf8RoundTrip(exact), true);
});
