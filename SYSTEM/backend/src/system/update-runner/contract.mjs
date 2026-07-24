import path from "node:path";

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{7,127}$/;
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const IMAGE_COMPONENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} muss ein Objekt sein.`);
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} enthält unbekannte Felder: ${unknown.join(", ")}`);
}

function requiredString(value, label, pattern, maximum = 512) {
  if (typeof value !== "string" || !value || value.length > maximum || (pattern && !pattern.test(value))) {
    throw new Error(`${label} ist ungültig.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} ist ungültig.`);
  return value;
}

function canonicalUtc(value, label) {
  const text = requiredString(value, label, UTC_TIMESTAMP, 32);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} ist ungültig.`);
  const canonical = parsed.toISOString();
  if (text.endsWith(".000Z") ? canonical !== text : canonical.replace(/\.000Z$/, "Z") !== text) {
    throw new Error(`${label} ist nicht kanonisch.`);
  }
  return { text, timestamp: parsed.getTime() };
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

function secureHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && (!url.port || url.port === "443");
  } catch {
    return false;
  }
}

function imageRepository(value) {
  if (typeof value !== "string" || !value || value.length > 255 || value !== value.toLowerCase() || value.includes("@")) return false;
  const parts = value.split("/");
  if (parts.length < 2 || parts.some((part) => !part)) return false;
  return parts.every((part, index) => {
    if (index === 0 && part.includes(":")) {
      const separator = part.lastIndexOf(":");
      const host = part.slice(0, separator);
      const port = part.slice(separator + 1);
      return host.split(".").every((component) => IMAGE_COMPONENT.test(component))
        && /^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65535;
    }
    return IMAGE_COMPONENT.test(part);
  });
}

export function compareStrictSemVer(left, right) {
  const parse = (value) => {
    const match = STRICT_SEMVER.exec(value);
    if (!match) throw new Error(`INVALID_STRICT_SEMVER:${String(value || "")}`);
    return { main: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], pre: match[4]?.split(".") || [] };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.main[index] < b.main[index]) return -1;
    if (a.main[index] > b.main[index]) return 1;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const l = a.pre[index]; const r = b.pre[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l); const rn = /^\d+$/.test(r);
    if (ln && rn) return BigInt(l) < BigInt(r) ? -1 : 1;
    if (ln) return -1;
    if (rn) return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function validateReleaseManifest(input) {
  const release = record(input, "release");
  exactKeys(release, [
    "schemaVersion", "product", "channel", "version", "artifact", "migration", "issuedAt", "expiresAt",
    "minimumRunnerVersion", "releaseNotes", "signature",
  ], "release");
  if (release.schemaVersion !== 2 || release.product !== "bonni-core") throw new Error("Ungültige Release-Identität.");
  if (!["stable", "beta", "nightly"].includes(release.channel)) throw new Error("release.channel ist ungültig.");
  const version = requiredString(release.version, "release.version", STRICT_SEMVER, 128);
  if (release.channel === "stable" && version.includes("-")) throw new Error("Stable-Releases dürfen keine Vorabversion sein.");

  const artifact = record(release.artifact, "release.artifact");
  exactKeys(artifact, ["type", "sizeBytes", "sha256", "source", "imageIdentity"], "release.artifact");
  if (!["oci-image-archive", "bonni-release-bundle"].includes(artifact.type)) throw new Error("release.artifact.type ist ungültig.");
  const sizeBytes = positiveInteger(artifact.sizeBytes, "release.artifact.sizeBytes");
  const artifactSha256 = requiredString(artifact.sha256, "release.artifact.sha256", DIGEST, 64);
  const source = record(artifact.source, "release.artifact.source");
  if (source.kind === "local") {
    exactKeys(source, ["kind", "path"], "release.artifact.source");
    if (!safeRelativePath(source.path)) throw new Error("release.artifact.source.path ist unsicher.");
  } else if (source.kind === "https") {
    exactKeys(source, ["kind", "url"], "release.artifact.source");
    if (!secureHttpsUrl(source.url)) throw new Error("release.artifact.source.url ist unsicher.");
  } else throw new Error("release.artifact.source.kind ist ungültig.");

  const identity = record(artifact.imageIdentity, "release.artifact.imageIdentity");
  exactKeys(identity, ["repository", "digest", "platform"], "release.artifact.imageIdentity");
  if (!imageRepository(identity.repository)) throw new Error("OCI-Repository ist ungültig.");
  const imageDigest = requiredString(identity.digest, "release.artifact.imageIdentity.digest", /^sha256:[a-f0-9]{64}$/, 71);
  const platform = record(identity.platform, "release.artifact.imageIdentity.platform");
  exactKeys(platform, ["os", "architecture", "variant"], "release.artifact.imageIdentity.platform");
  if (platform.os !== "linux" || !["amd64", "arm64"].includes(platform.architecture)) throw new Error("Release-Plattform ist ungültig.");
  if (platform.variant !== undefined) requiredString(platform.variant, "release platform.variant", /^[A-Za-z0-9._-]{1,32}$/, 32);

  const migration = record(release.migration, "release.migration");
  exactKeys(migration, ["required", "strategy", "fromSchemaVersion", "toSchemaVersion", "backwardCompatible"], "release.migration");
  if (typeof migration.required !== "boolean" || typeof migration.backwardCompatible !== "boolean") throw new Error("Release-Migrationsflags sind ungültig.");
  if (!["none", "expand-contract", "offline"].includes(migration.strategy)) throw new Error("Release-Migrationsstrategie ist ungültig.");
  const fromSchemaVersion = requiredString(migration.fromSchemaVersion, "migration.fromSchemaVersion", STRICT_SEMVER, 128);
  const toSchemaVersion = requiredString(migration.toSchemaVersion, "migration.toSchemaVersion", STRICT_SEMVER, 128);
  if (!migration.required && migration.strategy !== "none") throw new Error("Ohne Migration ist nur none erlaubt.");
  if (migration.required && migration.strategy === "none") throw new Error("Erforderliche Migration benötigt eine Strategie.");
  if (!migration.required && fromSchemaVersion !== toSchemaVersion) throw new Error("Ohne Migration dürfen sich Schemas nicht unterscheiden.");

  const issuedAt = canonicalUtc(release.issuedAt, "release.issuedAt");
  const expiresAt = canonicalUtc(release.expiresAt, "release.expiresAt");
  if (expiresAt.timestamp <= issuedAt.timestamp) throw new Error("release.expiresAt muss nach issuedAt liegen.");
  const minimumRunnerVersion = requiredString(release.minimumRunnerVersion, "release.minimumRunnerVersion", STRICT_SEMVER, 128);

  let releaseNotes;
  if (release.releaseNotes !== undefined) {
    const notes = record(release.releaseNotes, "release.releaseNotes");
    exactKeys(notes, ["title", "descriptions", "highlights"], "release.releaseNotes");
    const title = requiredString(notes.title, "release.releaseNotes.title", null, 160);
    let descriptions;
    if (notes.descriptions !== undefined) {
      descriptions = record(notes.descriptions, "release.releaseNotes.descriptions");
      for (const [language, description] of Object.entries(descriptions)) {
        requiredString(language, "Sprachcode", /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 32);
        requiredString(description, "Release-Beschreibung", null, 20_000);
      }
    }
    let highlights;
    if (notes.highlights !== undefined) {
      if (!Array.isArray(notes.highlights) || notes.highlights.length > 50) throw new Error("releaseNotes.highlights ist ungültig.");
      highlights = notes.highlights.map((entry) => requiredString(entry, "Release-Highlight", null, 500));
    }
    releaseNotes = { title, ...(descriptions ? { descriptions } : {}), ...(highlights ? { highlights } : {}) };
  }

  let signature;
  if (release.signature !== undefined) {
    const inputSignature = record(release.signature, "release.signature");
    exactKeys(inputSignature, ["algorithm", "keyId", "value"], "release.signature");
    if (inputSignature.algorithm !== "Ed25519") throw new Error("Nur Ed25519 ist erlaubt.");
    signature = {
      algorithm: "Ed25519",
      keyId: requiredString(inputSignature.keyId, "release.signature.keyId", KEY_ID, 128),
      value: requiredString(inputSignature.value, "release.signature.value", /^[A-Za-z0-9+/]{86}==$/, 88),
    };
    const decoded = Buffer.from(signature.value, "base64");
    if (decoded.length !== 64 || decoded.toString("base64") !== signature.value) throw new Error("Release-Signatur ist nicht kanonisch.");
  }

  return {
    schemaVersion: 2,
    product: "bonni-core",
    channel: release.channel,
    version,
    artifact: {
      type: artifact.type,
      sizeBytes,
      sha256: artifactSha256,
      source: source.kind === "local" ? { kind: "local", path: source.path } : { kind: "https", url: source.url },
      imageIdentity: {
        repository: identity.repository,
        digest: imageDigest,
        platform: { os: "linux", architecture: platform.architecture, ...(platform.variant ? { variant: platform.variant } : {}) },
      },
    },
    migration: { required: migration.required, strategy: migration.strategy, fromSchemaVersion, toSchemaVersion, backwardCompatible: migration.backwardCompatible },
    issuedAt: issuedAt.text,
    expiresAt: expiresAt.text,
    minimumRunnerVersion,
    ...(releaseNotes ? { releaseNotes } : {}),
    ...(signature ? { signature } : {}),
  };
}

export function validateUpdateRunnerRequest(input, options = {}) {
  const request = record(input, "request");
  exactKeys(request, [
    "schemaVersion", "requestId", "workflowId", "action", "product", "currentVersion", "targetVersion",
    "artifactRelativePath", "backupId", "issuedAt", "expiresAt", "nonce", "release", "auth",
  ], "request");
  if (request.schemaVersion !== 1 || request.action !== "install" || request.product !== "bonni-core") {
    throw new Error("Ungültige Update-Request-Identität.");
  }
  const requestId = requiredString(request.requestId, "request.requestId", IDENTIFIER, 128);
  const workflowId = requiredString(request.workflowId, "request.workflowId", IDENTIFIER, 128);
  const currentVersion = requiredString(request.currentVersion, "request.currentVersion", STRICT_SEMVER, 128);
  const targetVersion = requiredString(request.targetVersion, "request.targetVersion", STRICT_SEMVER, 128);
  const backupId = requiredString(request.backupId, "request.backupId", /^backup-[a-zA-Z0-9._-]{4,120}$/, 128);
  const nonce = requiredString(request.nonce, "request.nonce", NONCE, 128);
  const artifactRelativePath = requiredString(request.artifactRelativePath, "request.artifactRelativePath", null, 512);
  if (!safeRelativePath(artifactRelativePath) || !artifactRelativePath.startsWith("downloads/") || path.posix.normalize(artifactRelativePath) !== artifactRelativePath) {
    throw new Error("request.artifactRelativePath ist unsicher.");
  }
  const issued = canonicalUtc(request.issuedAt, "request.issuedAt");
  const expires = canonicalUtc(request.expiresAt, "request.expiresAt");
  if (expires.timestamp <= issued.timestamp) throw new Error("request.expiresAt muss nach issuedAt liegen.");
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  if (issued.timestamp > now + Number(options.futureToleranceMs ?? 5 * 60_000)) throw new Error("Update-Request liegt in der Zukunft.");
  if (options.allowExpired !== true && expires.timestamp <= now) throw new Error("Update-Request ist abgelaufen.");

  const release = validateReleaseManifest(request.release);
  if (release.product !== request.product || release.version !== targetVersion) throw new Error("Request und Release stimmen nicht überein.");
  if (compareStrictSemVer(targetVersion, currentVersion) <= 0) throw new Error("Zielversion ist nicht neuer als die laufende Version.");
  if (options.enforceInstallPolicy !== false && (
    release.migration.required
    || release.migration.strategy !== "none"
    || release.migration.backwardCompatible !== true
  )) {
    throw new Error("Automatische Updates bleiben ohne rückwärtskompatiblen Datenstand und versionierte Migrationskette fail-closed gesperrt.");
  }

  let auth;
  if (request.auth !== undefined) {
    const inputAuth = record(request.auth, "request.auth");
    exactKeys(inputAuth, ["algorithm", "value"], "request.auth");
    if (inputAuth.algorithm !== "HMAC-SHA256") throw new Error("request.auth.algorithm ist ungültig.");
    auth = {
      algorithm: "HMAC-SHA256",
      value: requiredString(inputAuth.value, "request.auth.value", /^[a-f0-9]{64}$/, 64),
    };
  } else if (options.requireAuth !== false) {
    throw new Error("Request besitzt keine lokale HMAC-Authentifizierung.");
  }

  return {
    schemaVersion: 1, requestId, workflowId, action: "install", product: "bonni-core", currentVersion, targetVersion,
    artifactRelativePath, backupId, issuedAt: issued.text, expiresAt: expires.text, nonce, release,
    ...(auth ? { auth } : {}),
  };
}

export function validateTrustedName(value, label = "Name") {
  return requiredString(value, label, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/, 128);
}

export function validateImageReference(value, label = "Image-Referenz") {
  return requiredString(value, label, /^(?!-)[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9][a-zA-Z0-9._-]{0,127})?$/, 255);
}
