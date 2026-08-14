#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const backendRoot = path.resolve(path.dirname(scriptPath), "../..");
const defaultEnvironmentPath = path.join(backendRoot, ".env");

const insecureSecretPatterns = [
  /change[-_ ]?me/iu,
  /development/iu,
  /dev[-_ ]?secret/iu,
  /example/iu,
  /placeholder/iu,
  /replace[-_ ]?me/iu,
  /your[-_ ]?(?:jwt[-_ ]?)?secret/iu,
];

export function isSecureJwtSecret(value) {
  const normalized = String(value || "").trim();
  const isRepeatedCharacter =
    normalized.length > 0 && /^([\s\S])\1+$/u.test(normalized);

  return (
    normalized.length >= 32
    && !isRepeatedCharacter
    && !insecureSecretPatterns.some((pattern) => pattern.test(normalized))
  );
}

export function isSecureMasterKey(value) {
  return isSecureJwtSecret(value) && String(value || "").trim().length >= 43;
}

function decodedValue(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (
    trimmed.length >= 2
    && (
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    )
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function readEnvironmentFile(environmentPath) {
  try {
    const stat = await fs.lstat(environmentPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `JWT_SECRET_BOOTSTRAP_UNSAFE_ENV_FILE: ${environmentPath}`,
      );
    }

    return {
      exists: true,
      mode: stat.mode & 0o777,
      content: await fs.readFile(environmentPath, "utf8"),
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      exists: false,
      mode: 0o600,
      content: "",
    };
  }
}

async function writeEnvironmentFileAtomically(environmentPath, content, mode) {
  const directory = path.dirname(environmentPath);
  await fs.mkdir(directory, { recursive: true });

  const temporaryPath = path.join(
    directory,
    `.${path.basename(environmentPath)}.jwt-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
  );
  let handle;

  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    await fs.rename(temporaryPath, environmentPath);
    await fs.chmod(environmentPath, mode || 0o600).catch(() => undefined);

    const directoryHandle = await fs.open(directory, "r").catch(() => null);
    if (directoryHandle) {
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function ensureMasterKey({
  environmentPath = defaultEnvironmentPath,
  inheritedEnvironment = process.env,
  logger = console,
} = {}) {
  const variableName = "MASTER_KEY";
  const inheritedSecret = inheritedEnvironment[variableName];
  if (inheritedSecret !== undefined) {
    if (!isSecureMasterKey(inheritedSecret)) {
      throw new Error(`${variableName}_BOOTSTRAP_EXTERNAL_SECRET_WEAK`);
    }
    return { changed: false, source: "environment" };
  }

  const environmentFile = await readEnvironmentFile(environmentPath);
  const newline = environmentFile.content.includes("\r\n") ? "\r\n" : "\n";
  const lines = environmentFile.content
    ? environmentFile.content.replace(/\r\n/g, "\n").split("\n")
    : [];
  const definitions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*(?:export\s+)?MASTER_KEY\s*=(.*)$/u.exec(lines[index]);
    if (match) definitions.push({ index, rawValue: match[1] });
  }
  if (definitions.length > 1) throw new Error(`${variableName}_BOOTSTRAP_DUPLICATE`);

  const configured = definitions[0] ? decodedValue(definitions[0].rawValue) : "";
  if (isSecureMasterKey(configured)) return { changed: false, source: "file" };

  const replacement = `${variableName}="${crypto.randomBytes(48).toString("base64url")}"`;
  const replacedWeakLocalKey = Boolean(definitions[0]);
  if (definitions[0]) {
    lines[definitions[0].index] = replacement;
  } else {
    while (lines.length && lines.at(-1) === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(
      "# Automatisch erzeugter Hauptschlüssel für verschlüsselte Bonni-Core-Daten.",
      replacement,
    );
  }
  while (lines.length && lines.at(-1) === "") lines.pop();
  await writeEnvironmentFileAtomically(environmentPath, `${lines.join(newline)}${newline}`, 0o600);
  logger.log(
    replacedWeakLocalKey
      ? `[bonni-core] Ein unsicherer lokaler ${variableName} wurde automatisch ersetzt.`
      : `[bonni-core] ${variableName} wurde einmalig kryptografisch erzeugt und gespeichert.`,
  );
  return {
    changed: true,
    source: replacedWeakLocalKey ? "replaced" : "generated",
  };
}

export async function ensureJwtSecret({
  environmentPath = defaultEnvironmentPath,
  inheritedEnvironment = process.env,
  logger = console,
} = {}) {
  const inheritedSecret = inheritedEnvironment.JWT_SECRET;
  if (inheritedSecret !== undefined) {
    if (!isSecureJwtSecret(inheritedSecret)) {
      throw new Error(
        "JWT_SECRET_BOOTSTRAP_EXTERNAL_SECRET_WEAK: "
        + "Die außerhalb von System/backend/.env gesetzte Variable JWT_SECRET "
        + "ist unsicher und kann nicht automatisch ersetzt werden.",
      );
    }

    return {
      changed: false,
      source: "environment",
    };
  }

  const environmentFile = await readEnvironmentFile(environmentPath);
  const newline = environmentFile.content.includes("\r\n") ? "\r\n" : "\n";
  const lines = environmentFile.content
    ? environmentFile.content.replace(/\r\n/g, "\n").split("\n")
    : [];
  const definitions = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*(?:export\s+)?JWT_SECRET\s*=(.*)$/u.exec(lines[index]);
    if (match) {
      definitions.push({
        index,
        rawValue: match[1],
      });
    }
  }

  if (definitions.length > 1) {
    throw new Error(
      "JWT_SECRET_BOOTSTRAP_DUPLICATE: "
      + "System/backend/.env enthält JWT_SECRET mehrfach.",
    );
  }

  const configuredSecret = definitions[0]
    ? decodedValue(definitions[0].rawValue)
    : "";
  if (isSecureJwtSecret(configuredSecret)) {
    return {
      changed: false,
      source: "file",
    };
  }

  const generatedSecret = crypto.randomBytes(48).toString("base64url");
  const replacement = `JWT_SECRET="${generatedSecret}"`;

  if (definitions[0]) {
    lines[definitions[0].index] = replacement;
  } else {
    while (lines.length && lines.at(-1) === "") {
      lines.pop();
    }
    if (lines.length) lines.push("");
    lines.push(
      "# Automatisch erzeugter Signaturschlüssel für Bonni-Core-Anmeldungen.",
      replacement,
    );
  }

  while (lines.length && lines.at(-1) === "") {
    lines.pop();
  }
  const finalContent = `${lines.join(newline)}${newline}`;
  await writeEnvironmentFileAtomically(
    environmentPath,
    finalContent,
    0o600,
  );

  logger.log(
    "[bonni-core] JWT_SECRET wurde einmalig kryptografisch erzeugt "
    + "und in System/backend/.env gespeichert.",
  );

  return {
    changed: true,
    source: "generated",
  };
}

export async function ensureModulePrivateDataSecret({
  environmentPath = defaultEnvironmentPath,
  inheritedEnvironment = process.env,
  logger = console,
} = {}) {
  const variableName = "MODULE_PRIVATE_DATA_SECRET";
  const inheritedSecret = inheritedEnvironment[variableName];
  if (inheritedSecret !== undefined) {
    if (!isSecureJwtSecret(inheritedSecret) || String(inheritedSecret).trim().length < 43) {
      throw new Error(`${variableName}_BOOTSTRAP_EXTERNAL_SECRET_WEAK`);
    }
    return { changed: false, source: "environment" };
  }

  const environmentFile = await readEnvironmentFile(environmentPath);
  const newline = environmentFile.content.includes("\r\n") ? "\r\n" : "\n";
  const lines = environmentFile.content
    ? environmentFile.content.replace(/\r\n/g, "\n").split("\n")
    : [];
  const definitions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*(?:export\s+)?MODULE_PRIVATE_DATA_SECRET\s*=(.*)$/u.exec(lines[index]);
    if (match) definitions.push({ index, rawValue: match[1] });
  }
  if (definitions.length > 1) throw new Error(`${variableName}_BOOTSTRAP_DUPLICATE`);

  const configured = definitions[0] ? decodedValue(definitions[0].rawValue) : "";
  if (isSecureJwtSecret(configured) && configured.length >= 43) {
    return { changed: false, source: "file" };
  }

  const replacement = `${variableName}="${crypto.randomBytes(48).toString("base64url")}"`;
  if (definitions[0]) {
    lines[definitions[0].index] = replacement;
  } else {
    while (lines.length && lines.at(-1) === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(
      "# Automatisch erzeugter Schlüssel für verschlüsselte private Moduldaten.",
      replacement,
    );
  }
  while (lines.length && lines.at(-1) === "") lines.pop();
  await writeEnvironmentFileAtomically(environmentPath, `${lines.join(newline)}${newline}`, 0o600);
  logger.log(`[bonni-core] ${variableName} wurde einmalig kryptografisch erzeugt und gespeichert.`);
  return { changed: true, source: "generated" };
}

export async function ensureCoreRuntimeSecrets(options = {}) {
  const master = await ensureMasterKey(options);
  const jwt = await ensureJwtSecret(options);
  const privateData = await ensureModulePrivateDataSecret(options);
  return { master, jwt, privateData };
}

function sameFile(left, right) {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

if (process.argv[1] && sameFile(process.argv[1], scriptPath)) {
  ensureCoreRuntimeSecrets().catch((error) => {
    console.error(`[bonni-core] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
