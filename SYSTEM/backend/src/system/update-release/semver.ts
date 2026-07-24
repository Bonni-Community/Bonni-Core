const STRICT_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export type ParsedStrictSemVer = {
  raw: string;
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: string[];
  build: string[];
};

export function isStrictSemVer(value: unknown): value is string {
  return typeof value === "string" && STRICT_SEMVER_PATTERN.test(value);
}

export function parseStrictSemVer(value: unknown): ParsedStrictSemVer {
  if (!isStrictSemVer(value)) {
    throw new Error(`INVALID_STRICT_SEMVER:${String(value || "")}`);
  }

  const match = STRICT_SEMVER_PATTERN.exec(value);
  if (!match) throw new Error(`INVALID_STRICT_SEMVER:${value}`);

  return {
    raw: value,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
    build: match[5] ? match[5].split(".") : [],
  };
}

function compareBigInt(left: bigint, right: bigint): -1 | 0 | 1 {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isNumericIdentifier(value: string) {
  return /^\d+$/.test(value);
}

export function compareStrictSemVer(leftValue: string, rightValue: string): -1 | 0 | 1 {
  const left = parseStrictSemVer(leftValue);
  const right = parseStrictSemVer(rightValue);

  for (const [leftPart, rightPart] of [
    [left.major, right.major],
    [left.minor, right.minor],
    [left.patch, right.patch],
  ] as const) {
    const comparison = compareBigInt(leftPart, rightPart);
    if (comparison !== 0) return comparison;
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = isNumericIdentifier(leftPart);
    const rightNumeric = isNumericIdentifier(rightPart);
    if (leftNumeric && rightNumeric) return compareBigInt(BigInt(leftPart), BigInt(rightPart));
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }

  return 0;
}
