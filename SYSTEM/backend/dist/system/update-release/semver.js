const STRICT_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export function isStrictSemVer(value) {
    return typeof value === "string" && STRICT_SEMVER_PATTERN.test(value);
}
export function parseStrictSemVer(value) {
    if (!isStrictSemVer(value)) {
        throw new Error(`INVALID_STRICT_SEMVER:${String(value || "")}`);
    }
    const match = STRICT_SEMVER_PATTERN.exec(value);
    if (!match)
        throw new Error(`INVALID_STRICT_SEMVER:${value}`);
    return {
        raw: value,
        major: BigInt(match[1]),
        minor: BigInt(match[2]),
        patch: BigInt(match[3]),
        prerelease: match[4] ? match[4].split(".") : [],
        build: match[5] ? match[5].split(".") : [],
    };
}
function compareBigInt(left, right) {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
function isNumericIdentifier(value) {
    return /^\d+$/.test(value);
}
export function compareStrictSemVer(leftValue, rightValue) {
    const left = parseStrictSemVer(leftValue);
    const right = parseStrictSemVer(rightValue);
    for (const [leftPart, rightPart] of [
        [left.major, right.major],
        [left.minor, right.minor],
        [left.patch, right.patch],
    ]) {
        const comparison = compareBigInt(leftPart, rightPart);
        if (comparison !== 0)
            return comparison;
    }
    if (left.prerelease.length === 0 && right.prerelease.length === 0)
        return 0;
    if (left.prerelease.length === 0)
        return 1;
    if (right.prerelease.length === 0)
        return -1;
    const length = Math.max(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < length; index += 1) {
        const leftPart = left.prerelease[index];
        const rightPart = right.prerelease[index];
        if (leftPart === undefined)
            return -1;
        if (rightPart === undefined)
            return 1;
        if (leftPart === rightPart)
            continue;
        const leftNumeric = isNumericIdentifier(leftPart);
        const rightNumeric = isNumericIdentifier(rightPart);
        if (leftNumeric && rightNumeric)
            return compareBigInt(BigInt(leftPart), BigInt(rightPart));
        if (leftNumeric)
            return -1;
        if (rightNumeric)
            return 1;
        return leftPart < rightPart ? -1 : 1;
    }
    return 0;
}
function alphabeticRevisionValue(value) {
    let result = 0n;
    for (const character of value) {
        result = result * 26n + BigInt(character.charCodeAt(0) - 96);
    }
    return result;
}
function bonniRevision(value) {
    if (value.build.length === 0)
        return { value: 0n, development: 0n };
    const build = value.build.join(".");
    const development = /^([a-z]+)-DEV\.([1-9]\d*)$/.exec(build);
    const revision = development?.[1] || build;
    if (!/^[a-z]+$/.test(revision)) {
        throw new Error(`INVALID_BONNI_RELEASE_REVISION:${value.raw}`);
    }
    return {
        value: alphabeticRevisionValue(revision),
        development: development ? BigInt(development[2]) : 0n,
    };
}
export function isBonniDevelopmentVersion(value) {
    if (!isStrictSemVer(value))
        return false;
    try {
        return bonniRevision(parseStrictSemVer(value)).development > 0n;
    }
    catch {
        return false;
    }
}
/**
 * Bonni displays maintenance releases as `0.1.19+a`, `0.1.19+b`, ... .
 * Standard SemVer intentionally ignores build metadata for precedence, so the
 * update boundary uses this narrower comparator and accepts only the Bonni
 * alphabetic revision form. The ordinary strict comparator remains standards
 * compliant for every other subsystem.
 */
export function compareBonniReleaseVersion(leftValue, rightValue) {
    const standardComparison = compareStrictSemVer(leftValue, rightValue);
    if (standardComparison !== 0)
        return standardComparison;
    const left = parseStrictSemVer(leftValue);
    const right = parseStrictSemVer(rightValue);
    const leftRevision = bonniRevision(left);
    const rightRevision = bonniRevision(right);
    const revisionComparison = compareBigInt(leftRevision.value, rightRevision.value);
    if (revisionComparison !== 0)
        return revisionComparison;
    return compareBigInt(leftRevision.development, rightRevision.development);
}
/** Maps the visible Bonni revision to a Docker-compatible immutable tag. */
export function bonniReleaseImageTag(versionValue) {
    const version = parseStrictSemVer(versionValue);
    // Validation is deliberate even though the result would be syntactically
    // usable: official releases must have one unambiguous alphabetic revision.
    const revision = bonniRevision(version);
    if (revision.development > 0n) {
        throw new Error(`INVALID_BONNI_RELEASE_REVISION:${versionValue}`);
    }
    const tag = [
        `${version.major}.${version.minor}.${version.patch}`,
        version.prerelease.length ? `-${version.prerelease.join(".")}` : "",
        version.build.length ? `-${version.build[0]}` : "",
    ].join("");
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) {
        throw new Error(`INVALID_BONNI_RELEASE_IMAGE_TAG:${versionValue}`);
    }
    return tag;
}
