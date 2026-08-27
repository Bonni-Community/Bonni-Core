import assert from "node:assert/strict";
import test from "node:test";

import { getOfficialCoreReleaseSource } from "../src/system/routes/control-api/update-center/github-release-source.ts";

test("official Bonni Core GitHub source is fixed and does not expose credentials", () => {
  const source = getOfficialCoreReleaseSource({
    BONNI_UPDATE_MANIFEST_URL: "https://github.com/Bonni-Community/bonni-core/releases/download/core-v1/manifest.json",
    BONNI_GITHUB_TOKEN: "must-never-be-returned",
  });

  assert.deepEqual(source, {
    provider: "github",
    repository: "Bonni-Community/bonni-core",
    repositoryUrl: "https://github.com/Bonni-Community/bonni-core",
    releasesUrl: "https://github.com/Bonni-Community/bonni-core/releases",
    latestManifestUrl: "https://github.com/Bonni-Community/bonni-core/releases/latest/download/manifest.json",
    destination: "UPDATE",
    manifestConfigured: true,
    signedCatalogConnected: false,
    batchInstallationSupported: false,
    state: "source-recorded",
  });
  assert.equal(JSON.stringify(source).includes("must-never-be-returned"), false);
});

test("recorded GitHub source stays an honest preview without a signed catalog", () => {
  const source = getOfficialCoreReleaseSource({});
  assert.equal(source.manifestConfigured, false);
  assert.equal(source.signedCatalogConnected, false);
  assert.equal(source.batchInstallationSupported, false);
});
