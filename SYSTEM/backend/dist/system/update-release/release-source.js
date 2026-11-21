import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
function isInside(candidate, parent) {
    const relative = path.relative(parent, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function stripIpv6Brackets(value) {
    return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}
function isNonPublicIpv4(address) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
        return true;
    const [a, b, c] = parts;
    return a === 0
        || a === 10
        || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 0)
        || (a === 192 && b === 168)
        || (a === 192 && b === 0 && c === 2)
        || (a === 198 && (b === 18 || b === 19))
        || (a === 198 && b === 51 && c === 100)
        || (a === 203 && b === 0 && c === 113)
        || a >= 224;
}
export function isPublicReleaseAddress(addressInput) {
    const address = stripIpv6Brackets(addressInput).toLowerCase();
    const family = net.isIP(address);
    if (family === 4)
        return !isNonPublicIpv4(address);
    if (family !== 6)
        return false;
    if (address === "::" || address === "::1")
        return false;
    if (/^(?:fc|fd)/.test(address) || /^fe[89ab]/.test(address) || /^ff/.test(address))
        return false;
    if (address.startsWith("2001:db8:"))
        return false;
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? !isNonPublicIpv4(mapped) : true;
}
function normalizedAllowedOrigins(origins) {
    return new Set((origins || []).map((origin) => new URL(origin).origin));
}
export function assertSecureReleaseHttpsUrl(value, options = {}) {
    const url = new URL(value);
    if (url.protocol !== "https:")
        throw new Error("RELEASE_URL_REQUIRES_HTTPS");
    if (url.username || url.password)
        throw new Error("RELEASE_URL_CREDENTIALS_FORBIDDEN");
    if (url.hash)
        throw new Error("RELEASE_URL_FRAGMENT_FORBIDDEN");
    if (!options.allowNonStandardPort && url.port && url.port !== "443") {
        throw new Error("RELEASE_URL_NON_STANDARD_PORT_FORBIDDEN");
    }
    const hostname = stripIpv6Brackets(url.hostname).toLowerCase().replace(/\.$/, "");
    const addressFamily = net.isIP(hostname);
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || (!addressFamily && !hostname.includes("."))) {
        throw new Error("RELEASE_URL_LOCAL_HOST_FORBIDDEN");
    }
    if ([".local", ".lan", ".home", ".internal", ".test", ".invalid", ".example"].some((suffix) => hostname.endsWith(suffix))) {
        throw new Error("RELEASE_URL_RESERVED_HOST_FORBIDDEN");
    }
    if (addressFamily && !isPublicReleaseAddress(hostname)) {
        throw new Error("RELEASE_URL_PRIVATE_ADDRESS_FORBIDDEN");
    }
    for (const address of options.resolvedAddresses || []) {
        if (!isPublicReleaseAddress(address))
            throw new Error("RELEASE_URL_PRIVATE_ADDRESS_FORBIDDEN");
    }
    const allowed = normalizedAllowedOrigins(options.allowedOrigins);
    if (allowed.size > 0 && !allowed.has(url.origin))
        throw new Error("RELEASE_URL_ORIGIN_NOT_ALLOWED");
    return url;
}
export function assertSecureReleaseRedirect(previousUrl, nextUrl, options = {}) {
    const previous = assertSecureReleaseHttpsUrl(previousUrl, options);
    const allowedOrigins = options.allowedOrigins?.length ? options.allowedOrigins : [previous.origin];
    return assertSecureReleaseHttpsUrl(nextUrl, { ...options, allowedOrigins });
}
async function assertNoSymbolicLinks(root, candidate) {
    const relative = path.relative(root, candidate);
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink())
            throw new Error("RELEASE_LOCAL_SYMLINK_FORBIDDEN");
    }
}
export async function resolveSecureLocalReleaseArtifact(options) {
    const allowedRoot = await fs.realpath(options.allowedRoot);
    const manifestFile = path.resolve(options.manifestFile);
    if (!isInside(manifestFile, allowedRoot))
        throw new Error("RELEASE_MANIFEST_OUTSIDE_ALLOWED_ROOT");
    const manifestRealPath = await fs.realpath(manifestFile);
    if (!isInside(manifestRealPath, allowedRoot))
        throw new Error("RELEASE_MANIFEST_OUTSIDE_ALLOWED_ROOT");
    await assertNoSymbolicLinks(allowedRoot, manifestFile);
    const artifact = path.resolve(path.dirname(manifestFile), options.artifactPath);
    if (!isInside(artifact, allowedRoot))
        throw new Error("RELEASE_ARTIFACT_OUTSIDE_ALLOWED_ROOT");
    await assertNoSymbolicLinks(allowedRoot, artifact);
    const artifactRealPath = await fs.realpath(artifact);
    if (!isInside(artifactRealPath, allowedRoot))
        throw new Error("RELEASE_ARTIFACT_OUTSIDE_ALLOWED_ROOT");
    const stat = await fs.lstat(artifactRealPath);
    if (!stat.isFile())
        throw new Error("RELEASE_ARTIFACT_MUST_BE_REGULAR_FILE");
    return artifactRealPath;
}
export async function assertSecureReleaseSource(manifest, context) {
    if (manifest.artifact.source.kind === "local") {
        if (!context.localAllowedRoot)
            throw new Error("RELEASE_LOCAL_ALLOWED_ROOT_REQUIRED");
        return {
            kind: "local",
            artifactPath: await resolveSecureLocalReleaseArtifact({
                manifestFile: context.manifestLocation,
                artifactPath: manifest.artifact.source.path,
                allowedRoot: context.localAllowedRoot,
            }),
        };
    }
    const manifestUrl = assertSecureReleaseHttpsUrl(context.manifestLocation, {
        allowedOrigins: context.allowedHttpsOrigins,
        resolvedAddresses: context.manifestResolvedAddresses || context.resolvedAddresses,
    });
    const allowedOrigins = context.allowedHttpsOrigins?.length ? context.allowedHttpsOrigins : [manifestUrl.origin];
    const artifactUrl = assertSecureReleaseHttpsUrl(manifest.artifact.source.url, {
        allowedOrigins,
        resolvedAddresses: context.artifactResolvedAddresses || context.resolvedAddresses,
    });
    return { kind: "https", manifestUrl, artifactUrl };
}
