export const BONNI_CORE_GITHUB_REPOSITORY = "Bonni-Community/bonni-core";
export const BONNI_CORE_GITHUB_REPOSITORY_URL = "https://github.com/Bonni-Community/bonni-core";
export const BONNI_CORE_GITHUB_RELEASES_URL = "https://github.com/Bonni-Community/bonni-core/releases";
export const BONNI_CORE_GITHUB_LATEST_MANIFEST_URL = "https://github.com/Bonni-Community/bonni-core/releases/latest/download/manifest.json";
export function getCoreReleaseAllowedOrigins(environment = process.env) {
    const configured = String(environment.BONNI_UPDATE_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
    if (configured.length)
        return configured;
    const source = String(environment.BONNI_UPDATE_MANIFEST_URL || "").trim();
    if (!source)
        return [];
    const url = new URL(source);
    // GitHub sends release downloads to its asset CDN. Allow only these exact
    // origins for the official source; private-address checks still run per hop.
    if (url.origin === "https://github.com" && /^\/Bonni-Community\/bonni-core\/releases\//i.test(url.pathname)) {
        return ["https://github.com", "https://release-assets.githubusercontent.com", "https://objects.githubusercontent.com"];
    }
    return [url.origin];
}
export function getOfficialCoreReleaseSource(environment = process.env) {
    const architecture = { x64: "AMD64", arm64: "ARM64", arm: "ARMv7" }[process.arch];
    const configured = String(environment.BONNI_UPDATE_MANIFEST_URL || "").trim();
    const latestManifestUrl = configured || (architecture ? `${BONNI_CORE_GITHUB_RELEASES_URL}/latest/download/manifest-${architecture}.json` : BONNI_CORE_GITHUB_LATEST_MANIFEST_URL);
    return {
        provider: "github",
        repository: BONNI_CORE_GITHUB_REPOSITORY,
        repositoryUrl: BONNI_CORE_GITHUB_REPOSITORY_URL,
        releasesUrl: BONNI_CORE_GITHUB_RELEASES_URL,
        latestManifestUrl,
        destination: "UPDATE",
        manifestConfigured: Boolean(String(environment.BONNI_UPDATE_MANIFEST_URL || "").trim()),
        // Erst ein erfolgreich verifiziertes Manifest darf diesen Wert im
        // Update-Center auf true setzen. Eine konfigurierte URL allein reicht nie.
        signedCatalogConnected: false,
        batchInstallationSupported: false,
        state: "source-recorded",
    };
}
