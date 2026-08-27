export const BONNI_CORE_GITHUB_REPOSITORY = "Bonni-Community/bonni-core" as const;
export const BONNI_CORE_GITHUB_REPOSITORY_URL = "https://github.com/Bonni-Community/bonni-core" as const;
export const BONNI_CORE_GITHUB_RELEASES_URL = "https://github.com/Bonni-Community/bonni-core/releases" as const;
export const BONNI_CORE_GITHUB_LATEST_MANIFEST_URL = "https://github.com/Bonni-Community/bonni-core/releases/latest/download/manifest.json" as const;

export type CoreReleaseSource = {
  provider: "github";
  repository: typeof BONNI_CORE_GITHUB_REPOSITORY;
  repositoryUrl: typeof BONNI_CORE_GITHUB_REPOSITORY_URL;
  releasesUrl: typeof BONNI_CORE_GITHUB_RELEASES_URL;
  latestManifestUrl: typeof BONNI_CORE_GITHUB_LATEST_MANIFEST_URL;
  destination: "UPDATE";
  manifestConfigured: boolean;
  signedCatalogConnected: boolean;
  batchInstallationSupported: false;
  state: "source-recorded" | "signed-release-connected";
};

export function getOfficialCoreReleaseSource(
  environment: NodeJS.ProcessEnv = process.env,
): CoreReleaseSource {
  return {
    provider: "github",
    repository: BONNI_CORE_GITHUB_REPOSITORY,
    repositoryUrl: BONNI_CORE_GITHUB_REPOSITORY_URL,
    releasesUrl: BONNI_CORE_GITHUB_RELEASES_URL,
    latestManifestUrl: BONNI_CORE_GITHUB_LATEST_MANIFEST_URL,
    destination: "UPDATE",
    manifestConfigured: Boolean(String(environment.BONNI_UPDATE_MANIFEST_URL || "").trim()),
    // Erst ein erfolgreich verifiziertes Manifest darf diesen Wert im
    // Update-Center auf true setzen. Eine konfigurierte URL allein reicht nie.
    signedCatalogConnected: false,
    batchInstallationSupported: false,
    state: "source-recorded",
  };
}
