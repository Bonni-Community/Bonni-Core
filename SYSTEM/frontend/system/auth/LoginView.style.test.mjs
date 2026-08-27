import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = readFile(new URL("./LoginView.jsx", import.meta.url), "utf8");
const stylesheet = readFile(new URL("./LoginView.css", import.meta.url), "utf8");
const recoveryStylesheet = readFile(
  new URL("../../core/modules/security/identity/components/PasswordRecoveryFlow.css", import.meta.url),
  "utf8",
);

test("login view keeps the real password, 2FA and recovery contracts", async () => {
  const source = await component;

  assert.match(source, /secretInputWouldBeInvalid\(nextValue, maxLength\)/u);
  assert.match(source, /onBeforeInput=\{guardInsertion\}/u);
  assert.match(source, /onPaste=\{guardPaste\}/u);
  assert.match(source, /twoFactorChallenge \? proofFields\.map/u);
  assert.match(source, /onTwoFactorProofChange\(field\.name, value\)/u);
  assert.match(source, /PasswordRecoveryLauncher/u);
  assert.match(source, /PasswordRecoveryFlow/u);
  assert.match(source, /onSubmit=\{onSubmit\}/u);
  assert.match(source, /onClick=\{onCancelTwoFactor\}/u);
  assert.match(source, /passwordVisible \? "text" : type/u);
  assert.match(source, /aria-pressed=\{passwordVisible\}/u);
});

test("login view is semantic, restrained and contains no invented actions", async () => {
  const source = await component;

  assert.match(source, /<main className="bonni-login-page">/u);
  assert.match(source, /aria-labelledby="bonni-login-title"/u);
  assert.match(source, /htmlFor="bonni-login-name"/u);
  assert.match(source, /autoComplete="username"/u);
  assert.match(source, /aria-live="assertive"/u);
  assert.match(source, /Willkommen zurück/u);
  assert.match(source, /Organisationen sollen genau die Werkzeuge nutzen können/u);
  assert.doesNotMatch(source, /style=\{\{/u);
  assert.doesNotMatch(source, /Angemeldet bleiben|E-Mail|Mit 2FA-Token|Datenschutz|Impressum|Version\s/u);
});

test("official Bonni Core signet uses the fixed brand colors", async () => {
  const source = await component;

  assert.match(source, /function BonniCoreSignet\(\)/u);
  assert.match(source, /fill="#0B1F4D"/u);
  assert.match(source, /fill="#F5B000"/u);
  assert.match(source, /bonni-login-brand__bonni-mark/u);
  assert.match(source, /bonni-login-brand__corner/u);
  assert.match(source, /bonni-login-brand__divider/u);
  assert.match(source, /bonni-login-brand__core-hexagon/u);
  assert.match(source, /bonni-login-brand__core-center/u);
  assert.match(source, /role="img"/u);
  assert.match(source, /aria-label="Bonni Core"/u);
  assert.doesNotMatch(source, /bonni-login-brand__plate|bonni-login-brand__core-mark/u);
});

test("login styling is responsive piano black without glass or glow effects", async () => {
  const css = await stylesheet;
  const recoveryCss = await recoveryStylesheet;

  assert.match(css, /--bonni-login-ink:\s*#060708/u);
  assert.match(css, /--bonni-login-blue:\s*#0b1f4d/u);
  assert.match(css, /--bonni-login-orange:\s*#f5b000/u);
  assert.match(css, /\.bonni-login-page__content\s*\{[\s\S]*?grid-template-columns:/u);
  assert.match(css, /@media \(max-width: 840px\)/u);
  assert.match(css, /@media \(max-width: 520px\)/u);
  assert.match(css, /:focus-visible/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(css, /bonni-login-field__control--revealable/u);
  assert.doesNotMatch(css, /:has\(/u);
  assert.match(recoveryCss, /background:\s*#0a0c0f/u);
  assert.doesNotMatch(`${css}\n${recoveryCss}`, /box-shadow|text-shadow|(?:backdrop-)?filter\s*:|radial-gradient|position:\s*fixed|z-index\s*:/u);
});
