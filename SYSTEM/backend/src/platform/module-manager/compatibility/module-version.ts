export type VersionComparison = -1 | 0 | 1;

type ParsedModuleVersion = {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
  bonniRevision: number;
  bonniDevelopment: number;
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
// Laborstände können aus Paket-/Manifestpfaden einmal als `DEV.2` und einmal
// als `dev.2` zurückkommen. Beide Schreibweisen gehören zur gleichen Bonni-
// Entwicklungsstufe und dürfen nicht wie eine gewöhnliche SemVer-Prerelease
// unter die stabile `+h`-Basis fallen.
const BONNI_LETTER_REVISION = /^([a-z]+)(?:-dev\.([1-9]\d*))?$/i;

function compareNumericIdentifiers(left: string, right: string): VersionComparison {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length < normalizedRight.length) return -1;
  if (normalizedLeft.length > normalizedRight.length) return 1;
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

function parseModuleVersion(value: unknown, allowLeadingV = false): ParsedModuleVersion | null {
  if (typeof value !== "string" || value.trim() !== value) return null;
  const candidate = allowLeadingV ? value.replace(/^v/i, "") : value;
  const compact = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)([a-z]+)-DEV\.(0*[1-9]\d*)$/.exec(candidate);
  if (compact) {
    const development = Number(compact[5]);
    const revision = [...compact[4]].reduce((total, character) => total * 26 + character.charCodeAt(0) - 96, 0);
    if (!Number.isSafeInteger(development) || !Number.isSafeInteger(revision)) return null;
    return { major: compact[1], minor: compact[2], patch: compact[3], prerelease: [], bonniRevision: revision, bonniDevelopment: development };
  }
  const match = SEMVER.exec(candidate);
  if (!match) return null;

  const buildMetadata = match[5] || "";
  const revision = BONNI_LETTER_REVISION.exec(buildMetadata);
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4] ? match[4].split(".") : [],
    // SemVer normally ignores build metadata. Bonni deliberately reserves a
    // A lower-case letter is the Bonni branch/revision (+a, +b, ...).
    // `-DEV.n` is a laboratory iteration of that revision.
    bonniRevision: revision ? [...revision[1]].reduce((total, character) => (
      total * 26 + character.charCodeAt(0) - 96
    ), 0) : 0,
    bonniDevelopment: revision?.[2] ? Number(revision[2]) : 0,
  };
}

function comparePrerelease(left: string[], right: string[]): VersionComparison {
  if (!left.length && right.length) return 1;
  if (left.length && !right.length) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const comparison = compareNumericIdentifiers(leftPart, rightPart);
      if (comparison !== 0) return comparison;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

export function isValidModuleVersion(value: unknown): value is string {
  return parseModuleVersion(value) !== null;
}

export function compareModuleVersions(leftValue: string, rightValue: string): VersionComparison {
  const left = parseModuleVersion(leftValue, true);
  const right = parseModuleVersion(rightValue, true);
  if (!left || !right) {
    throw new TypeError("MODULE_VERSION_INVALID");
  }

  for (const field of ["major", "minor", "patch"] as const) {
    const comparison = compareNumericIdentifiers(left[field], right[field]);
    if (comparison !== 0) return comparison;
  }

  const prereleaseComparison = comparePrerelease(left.prerelease, right.prerelease);
  if (prereleaseComparison !== 0) return prereleaseComparison;

  if (left.bonniRevision < right.bonniRevision) return -1;
  if (left.bonniRevision > right.bonniRevision) return 1;
  if (left.bonniDevelopment < right.bonniDevelopment) return -1;
  if (left.bonniDevelopment > right.bonniDevelopment) return 1;
  return 0;
}

export function validateCoreVersionCompatibility(value: unknown) {
  const errors: string[] = [];
  if (value === undefined) {
    return {
      ok: true,
      minimumCoreVersion: null,
      maximumCoreVersion: null,
      errors,
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      minimumCoreVersion: null,
      maximumCoreVersion: null,
      errors: ["compatibility muss ein Objekt sein."],
    };
  }

  const source = value as Record<string, unknown>;
  const allowedFields = new Set(["minimumCoreVersion", "maximumCoreVersion"]);
  const unknownFields = Object.keys(source).filter((field) => !allowedFields.has(field));
  if (unknownFields.length) {
    errors.push(`compatibility enthält nicht unterstützte Felder: ${unknownFields.sort().join(", ")}.`);
  }

  const validateField = (field: "minimumCoreVersion" | "maximumCoreVersion") => {
    if (!Object.prototype.hasOwnProperty.call(source, field)) return null;
    if (!isValidModuleVersion(source[field])) {
      errors.push(`compatibility.${field} muss eine gültige SemVer-Version sein.`);
      return null;
    }
    return source[field];
  };

  const minimumCoreVersion = validateField("minimumCoreVersion");
  const maximumCoreVersion = validateField("maximumCoreVersion");
  if (
    minimumCoreVersion
    && maximumCoreVersion
    && compareModuleVersions(minimumCoreVersion, maximumCoreVersion) > 0
  ) {
    errors.push("compatibility.minimumCoreVersion darf nicht neuer als compatibility.maximumCoreVersion sein.");
  }

  return {
    ok: errors.length === 0,
    minimumCoreVersion,
    maximumCoreVersion,
    errors,
  };
}
