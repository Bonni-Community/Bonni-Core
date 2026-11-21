/**
 * Docker-Archive-Tags are executable daemon state: `docker image load` applies
 * them before the caller can inspect the loaded image. A release may therefore
 * contain exactly the immutable, version-bound release tag.
 * Runtime tags such as Active/Rollback and every unrelated tag fail closed.
 */
export function assertReleaseArchiveTags(identity, actualTags, options = {}) {
    if (!Array.isArray(actualTags) || actualTags.length > 32) {
        throw new Error("RELEASE_ARCHIVE_TAGS_INVALID");
    }
    const expectedTag = `${identity.repository}:${identity.imageTag || identity.version}`;
    if (actualTags.length !== 1)
        throw new Error("RELEASE_ARCHIVE_VERSION_TAG_REQUIRED");
    const forbiddenTags = new Set(options.forbiddenTags || []);
    const seen = new Set();
    for (const tag of actualTags) {
        if (typeof tag !== "string" || tag.length < 3 || tag.length > 255 || seen.has(tag)) {
            throw new Error("RELEASE_ARCHIVE_TAGS_INVALID");
        }
        seen.add(tag);
        if (forbiddenTags.has(tag))
            throw new Error("RELEASE_ARCHIVE_FORBIDDEN_RUNTIME_TAG");
        if (tag !== expectedTag)
            throw new Error("RELEASE_ARCHIVE_UNEXPECTED_TAG");
    }
    return true;
}
