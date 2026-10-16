export const BONNI_CORE_GITHUB_REPOSITORY = "Bonni-Community/bonni-core" as const;
export const BONNI_CORE_GITHUB_REPOSITORY_URL = "https://github.com/Bonni-Community/bonni-core" as const;
export const BONNI_CORE_GITHUB_RELEASES_URL = "https://github.com/Bonni-Community/bonni-core/releases" as const;
export const BONNI_CORE_GITHUB_LATEST_MANIFEST_URL = "https://github.com/Bonni-Community/bonni-core/releases/latest/download/manifest.json" as const;

export function getCoreReleaseAllowedOrigins(environment: NodeJS.ProcessEnv = process.env): string[] {
  const configured = String(environment.BONNI_UPDATE_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
  if (configured.length) return configured;
  const source = String(environment.BONNI_UPDATE_MANIFEST_URL || "").trim();
  if (!source) return [];
  const url = new URL(source);
  // GitHub sends release downloads to its asset CDN. Allow only these exact
  // origins for the official source; private-address checks still run per hop.
  if (url.origin === "https://github.com" && /^\/Bonni-Community\/bonni-core\/releases\//i.test(url.pathname)) {
    return ["https://github.com", "https://release-assets.githubusercontent.com", "https://objects.githubusercontent.com"];
  }
  return [url.origin];
}

export type CoreReleaseSource = {
  provider: "github";
  repository: typeof BONNI_CORE_GITHUB_REPOSITORY;
  repositoryUrl: typeof BONNI_CORE_GITHUB_REPOSITORY_URL;
  releasesUrl: typeof BONNI_CORE_GITHUB_RELEASES_URL;
  latestManifestUrl: string;
  destination: "UPDATE";
  manifestConfigured: boolean;
  signedCatalogConnected: boolean;
  batchInstallationSupported: false;
  state: "source-recorded" | "signed-release-connected";
};

export function getOfficialCoreReleaseSource(
  environment: NodeJS.ProcessEnv = process.env,
): CoreReleaseSource {
  const architecture = { x64: "AMD64", arm64: "ARM64", arm: "ARMv7" }[process.arch as "x64" | "arm64" | "arm"];
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
