import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(directory, "StorePage.jsx"), "utf8");
const guideDirectory = path.resolve(directory, "../../../public/system/guides/2fa");

test("2FA plugin details keep description, setup, installation guide and feedback separate", () => {
  assert.match(source, />Beschreibung<\/button>/);
  assert.match(source, />Einrichtung<\/button>/);
  assert.match(source, />Installationshilfe<\/button>/);
  assert.match(source, />Feedback &amp; Vorschläge<\/button>/);
  assert.match(source, /value="auto">Auto<\/option>/);
  assert.match(source, /value="de">DE<\/option>/);
  assert.match(source, /value="en">EN<\/option>/);
});

test("feedback stays local until the user explicitly opens an online channel", () => {
  assert.match(source, /Bonni Core kann vollständig lokal betrieben werden/);
  assert.match(source, /window\.localStorage\.setItem/);
  assert.match(source, /navigator\.onLine/);
  assert.match(source, /Auf GitHub öffnen/);
  assert.match(source, /Keine Passwörter, Token, QR-Geheimnisse oder Wiederherstellungscodes/);
  assert.doesNotMatch(source, /github[_-]?token|authorization:\s*[`'"]Bearer/i);
});

test("2FA installation guide ships one privacy-safe illustration per step", () => {
  const illustrations = fs.readdirSync(guideDirectory).filter((entry) => entry.endsWith(".svg"));
  assert.deepEqual(illustrations.sort(), [
    "01-provider.svg",
    "02-connection.svg",
    "03-policy.svg",
    "04-qr-code.svg",
    "05-finish.svg",
  ]);
  for (const illustration of illustrations) {
    const svg = fs.readFileSync(path.join(guideDirectory, illustration), "utf8");
    assert.match(svg, /<title/);
    assert.doesNotMatch(svg, /otpauth:\/\/|secret=/i);
  }
});

test("QR enrollment is backed by Core and distinguishes privacyIDEA issuance", () => {
  assert.match(source, /startCurrentUserTotpSetup/);
  assert.match(source, /confirmCurrentUserTotpSetup/);
  assert.match(source, /Bonni erzeugt keinen Ersatzschlüssel/);
  assert.match(source, /nur jetzt sichtbar/);
});
