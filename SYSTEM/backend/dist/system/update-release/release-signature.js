import { verifyBuildAuthorization } from "../../../src/system/update-runner/build-authorization.mjs";
import crypto from "node:crypto";
import { releaseSignatureBytes } from "./canonical-release.js";
import { parseReleaseManifest, parseReleaseManifestPayload, } from "./release-manifest.schema.js";
import { compareStrictSemVer } from "./semver.js";
import { parseEd25519SpkiPublicKey } from "./release-public-key.js";
function trustedKey(keys, keyId) {
    if (!keys)
        return undefined;
    return keys instanceof Map
        ? keys.get(keyId)
        : keys[keyId];
}
function asEd25519PublicKey(value) {
    return parseEd25519SpkiPublicKey(value);
}
function asEd25519PrivateKey(value) {
    const key = value instanceof crypto.KeyObject ? value : crypto.createPrivateKey(value);
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
        throw new Error("RELEASE_KEY_MUST_BE_ED25519_PRIVATE_KEY");
    }
    return key;
}
function decodeCanonicalEd25519Signature(value) {
    if (!/^[A-Za-z0-9+/]{86}==$/.test(value))
        throw new Error("INVALID_ED25519_SIGNATURE_ENCODING");
    const signature = Buffer.from(value, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== value) {
        throw new Error("INVALID_ED25519_SIGNATURE_ENCODING");
    }
    return signature;
}
function enforceManifestPolicy(manifest, options) {
    const expectedProduct = options.expectedProduct || "bonni-core";
    if (manifest.product !== expectedProduct)
        throw new Error("RELEASE_PRODUCT_MISMATCH");
    if (options.expectedChannel && manifest.channel !== options.expectedChannel) {
        throw new Error("RELEASE_CHANNEL_MISMATCH");
    }
    if (compareStrictSemVer(options.runnerVersion, manifest.minimumRunnerVersion) < 0) {
        throw new Error("RELEASE_RUNNER_TOO_OLD");
    }
    const now = (options.now || new Date()).getTime();
    if (!Number.isFinite(now))
        throw new Error("INVALID_VERIFICATION_TIME");
    const issuedAt = Date.parse(manifest.issuedAt);
    const expiresAt = Date.parse(manifest.expiresAt);
    const clockSkewMs = Math.max(0, options.clockSkewMs ?? 5 * 60_000);
    const maximumValidityMs = Math.max(1, options.maximumValidityMs ?? 90 * 24 * 60 * 60_000);
    if (expiresAt - issuedAt > maximumValidityMs)
        throw new Error("RELEASE_VALIDITY_WINDOW_TOO_LONG");
    if (now + clockSkewMs < issuedAt)
        throw new Error("RELEASE_NOT_YET_VALID");
    if (now - clockSkewMs > expiresAt)
        throw new Error("RELEASE_EXPIRED");
}
export function signReleaseManifest(payloadInput, keyId, privateKeyInput) {
    const payload = parseReleaseManifestPayload(payloadInput);
    const unsigned = parseReleaseManifest(payload);
    const privateKey = asEd25519PrivateKey(privateKeyInput);
    const signature = crypto.sign(null, releaseSignatureBytes(unsigned), privateKey);
    return parseReleaseManifest({
        ...payload,
        signature: {
            algorithm: "Ed25519",
            keyId,
            value: signature.toString("base64"),
        },
    });
}
export function verifyReleaseManifest(manifestInput, options) {
    const manifest = parseReleaseManifest(manifestInput);
    enforceManifestPolicy(manifest, options);
    if (!manifest.signature) {
        const runtimeMode = (options.nodeEnv || process.env.NODE_ENV || "production").trim().toLowerCase();
        if (!["development", "test"].includes(runtimeMode)) {
            throw new Error("UNSIGNED_RELEASE_FORBIDDEN_IN_PRODUCTION");
        }
        if (!options.allowUnsignedDevelopment)
            throw new Error("UNSIGNED_RELEASE_REQUIRES_EXPLICIT_DEVELOPMENT_OVERRIDE");
        if (manifest.artifact.source.kind !== "local")
            throw new Error("UNSIGNED_REMOTE_RELEASE_FORBIDDEN");
        return { manifest, verified: false, unsignedDevelopment: true, keyId: null };
    }
    const keyInput = manifest.buildAuthorization
        ? verifyBuildAuthorization(manifest.buildAuthorization, { trustedKeys: options.trustedKeys,
            version: manifest.version, product: manifest.product, channel: manifest.channel,
            keyId: manifest.signature.keyId, now: options.now || new Date(),
            issuedAt: manifest.issuedAt, expiresAt: manifest.expiresAt })
        : trustedKey(options.trustedKeys, manifest.signature.keyId);
    if (!keyInput)
        throw new Error("UNTRUSTED_RELEASE_KEY");
    const publicKey = asEd25519PublicKey(keyInput);
    const signature = decodeCanonicalEd25519Signature(manifest.signature.value);
    if (!crypto.verify(null, releaseSignatureBytes(manifest), publicKey, signature)) {
        throw new Error("INVALID_RELEASE_SIGNATURE");
    }
    return {
        manifest,
        verified: true,
        unsignedDevelopment: false,
        keyId: manifest.signature.keyId,
    };
}
