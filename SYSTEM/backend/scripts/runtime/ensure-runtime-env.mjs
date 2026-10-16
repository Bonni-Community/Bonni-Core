#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const targetArgument = args.find((value) => !value.startsWith("--")) || ".env";
const target = path.resolve(targetArgument);
const freshInstallation = args.includes("--fresh");
const existingInstallation = args.includes("--existing");
const printIdentifiers = args.includes("--identifiers");
const projectHintArgument = args.find((value) => value.startsWith("--project-name="));
const projectHint = projectHintArgument ? projectHintArgument.slice("--project-name=".length) : "";
if (freshInstallation === existingInstallation) {
  throw new Error("Runtime-Preflight benötigt genau einen Modus: --fresh oder --existing.");
}

const stat = await fs.lstat(target);
if (!stat.isFile() || stat.isSymbolicLink()) {
  throw new Error(`Runtime-Umgebungsdatei ist keine sichere reguläre Datei: ${target}`);
}

const original = await fs.readFile(target, "utf8");
const lines = original.replace(/\r\n/g, "\n").split("\n");
const definitions = new Map();
for (let index = 0; index < lines.length; index += 1) {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(lines[index]);
  if (!match) continue;
  const [, key, rawValue] = match;
  if (definitions.has(key)) throw new Error(`Runtime-Umgebung enthält den Schlüssel ${key} mehrfach.`);
  definitions.set(key, { index, rawValue });
}

function decodedValue(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function currentValue(key) {
  const definition = definitions.get(key);
  return definition ? decodedValue(definition.rawValue) : "";
}

function hasDefinition(key) {
  return definitions.has(key);
}

const changed = [];
function setValue(key, value) {
  const definition = definitions.get(key);
  const replacement = `${key}=${value}`;
  if (definition) lines[definition.index] = replacement;
  else {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    const index = lines.length;
    lines.push(replacement);
    definitions.set(key, { index, rawValue: value });
  }
  if (definition) definition.rawValue = value;
  changed.push(key);
}

const projectPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;
let projectName = currentValue("COMPOSE_PROJECT_NAME") || projectHint;
if (!projectName) projectName = `bonni-${crypto.randomBytes(6).toString("hex")}`;
if (!projectPattern.test(projectName)) throw new Error("COMPOSE_PROJECT_NAME ist für einen sicheren Multiinstanz-Betrieb ungültig.");
if (!currentValue("COMPOSE_PROJECT_NAME")) setValue("COMPOSE_PROJECT_NAME", projectName);

const tagPattern = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const configuredSystemImage = currentValue("SYSTEM_IMAGE");
const configuredEmergencyImage = currentValue("EMERGENCY_SYSTEM_IMAGE");
let activeImage = currentValue("BONNI_ACTIVE_IMAGE_TAG")
  || configuredSystemImage
  || `${projectName}-system:active`;
let emergencyImage = currentValue("BONNI_EMERGENCY_IMAGE_TAG")
  || configuredEmergencyImage
  || `${projectName}-system:emergency`;
const rollbackImage = currentValue("BONNI_ROLLBACK_IMAGE_TAG") || `${projectName}-system:rollback`;
if (!tagPattern.test(activeImage) || !tagPattern.test(emergencyImage) || !tagPattern.test(rollbackImage)) {
  throw new Error("Projektgescopte Active-/Emergency-/Rollback-Image-Tags sind ungültig.");
}
if (!currentValue("BONNI_ACTIVE_IMAGE_TAG")) setValue("BONNI_ACTIVE_IMAGE_TAG", activeImage);
if (!currentValue("BONNI_EMERGENCY_IMAGE_TAG")) setValue("BONNI_EMERGENCY_IMAGE_TAG", emergencyImage);
if (!currentValue("BONNI_ROLLBACK_IMAGE_TAG")) setValue("BONNI_ROLLBACK_IMAGE_TAG", rollbackImage);

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicIdentityKeys = [
  "BONNI_SERIAL",
  "BONNI_ORGANIZATION_ID",
  "BONNI_SITE_ID",
  "BONNI_NODE_ID",
];

for (const key of publicIdentityKeys) {
  if (!hasDefinition(key)) {
    setValue(key, crypto.randomUUID());
    continue;
  }
  if (!uuidV4Pattern.test(currentValue(key))) {
    throw new Error(
      `${key} ist ungültig. Vorhandene Bonni-Identitäten werden nicht automatisch ersetzt.`,
    );
  }
}

if (!hasDefinition("BONNI_TENANT_ID")) {
  setValue("BONNI_TENANT_ID", currentValue("BONNI_ORGANIZATION_ID"));
} else if (!uuidV4Pattern.test(currentValue("BONNI_TENANT_ID"))) {
  throw new Error(
    "BONNI_TENANT_ID ist ungültig. Vorhandene Bonni-Identitäten werden nicht automatisch ersetzt.",
  );
}

const specifications = [
  { key: "MASTER_KEY", minimum: 32, bytes: 48 },
  { key: "JWT_SECRET", minimum: 32, bytes: 48 },
  // Unlike a new transport secret, this key may already protect module data.
  // Generate only for a proven fresh installation. Existing installations
  // must retain/recover their original key; never silently replace it.
  { key: "MODULE_PRIVATE_DATA_SECRET", minimum: 43, bytes: 48 },
  { key: "POSTGRES_PASSWORD", minimum: 24, bytes: 36 },
  { key: "SANDBOX_PASSWORD", minimum: 16, bytes: 24 },
  { key: "BONNI_GATEWAY_INTERNAL_SECRET", minimum: 32, bytes: 48, initializeWhenMissing: true },
];

function isInsecure(value, minimum) {
  return value.length < minimum
    || /(change[-_ ]?me|replace|example|default|password|postgres)/i.test(value);
}

const unsafeExisting = [];
for (const specification of specifications) {
  const value = currentValue(specification.key);
  if (!isInsecure(value, specification.minimum)) continue;
  if (existingInstallation) {
    if (specification.initializeWhenMissing && !hasDefinition(specification.key)) {
      setValue(specification.key, crypto.randomBytes(specification.bytes).toString("base64url"));
      continue;
    }
    unsafeExisting.push(specification.key);
    continue;
  }
  setValue(specification.key, crypto.randomBytes(specification.bytes).toString("base64url"));
}
if (unsafeExisting.length) {
  throw new Error(
    `Bestehende Installation verwendet fehlende/unsichere Werte (${unsafeExisting.join(", ")}). `
    + "Automatische Schlüsselrotation wurde verweigert; bitte kontrollierte Datenbank-/Schlüsselmigration durchführen.",
  );
}

let finalText = original;
if (changed.length) {
  finalText = `${lines.join("\n").replace(/\n+$/, "")}\n`;
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(finalText, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
    const directoryHandle = await fs.open(directory, "r");
    await directoryHandle.sync().catch(() => undefined);
    await directoryHandle.close();
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
} else {
  await fs.chmod(target, 0o600);
}

if (printIdentifiers) {
  process.stdout.write(`${projectName}\t${activeImage}\t${emergencyImage}\t${rollbackImage}\n`);
} else if (changed.length) {
  console.log(`Runtime-Konfiguration wurde atomar ergänzt/gehärtet: ${changed.join(", ")}.`);
} else {
  console.log("Persistente Runtime-Konfiguration ist vollständig und ohne bekannte Platzhalter.");
}
