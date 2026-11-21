export function assertReleaseArtifactIdentity(manifest, actual) {
    if (!Number.isSafeInteger(actual.sizeBytes) || actual.sizeBytes !== manifest.artifact.sizeBytes) {
        throw new Error("RELEASE_ARTIFACT_SIZE_MISMATCH");
    }
    if (!/^[a-f0-9]{64}$/.test(actual.sha256) || actual.sha256 !== manifest.artifact.sha256) {
        throw new Error("RELEASE_ARTIFACT_HASH_MISMATCH");
    }
    return true;
}
export function assertReleaseImageIdentity(manifest, actual) {
    const expected = manifest.artifact.imageIdentity;
    if (actual.repository !== expected.repository
        || actual.digest !== expected.digest
        || actual.platform.os !== expected.platform.os
        || actual.platform.architecture !== expected.platform.architecture
        || (actual.platform.variant || null) !== (expected.platform.variant || null)) {
        throw new Error("RELEASE_IMAGE_IDENTITY_MISMATCH");
    }
    return true;
}
