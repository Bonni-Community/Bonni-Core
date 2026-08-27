import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Bonni Core update page records the official GitHub source and a verified single release honestly", async () => {
  const [overview, page, settings, backendSource] = await Promise.all([
    readFile(new URL("./CoreReleaseOverview.jsx", import.meta.url), "utf8"),
    readFile(new URL("./CoreUpdatePage.jsx", import.meta.url), "utf8"),
    readFile(new URL("./UpdateSettingsPage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../../../backend/src/system/routes/control-api/update-center/github-release-source.ts", import.meta.url), "utf8"),
  ]);

  for (const source of [overview, settings, backendSource]) {
    assert.match(source, /https:\/\/github\.com\/Bonni-Community\/bonni-core/u);
  }
  assert.match(backendSource, /releases\/latest\/download\/manifest\.json/u);
  assert.match(page, /<CoreReleaseOverview status=\{status\}/u);
  assert.match(overview, /Installiert/u);
  assert.match(overview, /GitHub verfügbar/u);
  assert.match(overview, /Ablage nach Prüfung/u);
  assert.match(overview, /Signiertes Release verbunden/u);
  assert.match(overview, /öffentliche Core-Schlüssel/u);
  assert.match(overview, /source\.signedCatalogConnected/u);
  assert.doesNotMatch(overview, /GitHub-Token/u);
  assert.doesNotMatch(overview, /<button/u);
});

test("future package plans can display every consecutive package", async () => {
  const overview = await readFile(new URL("./CoreReleaseOverview.jsx", import.meta.url), "utf8");
  assert.match(overview, /plan\?\.packages/u);
  assert.match(overview, /entry\.fromVersion/u);
  assert.match(overview, /entry\.toVersion/u);
  assert.match(overview, /packageStateLabel\(entry\.status\)/u);
});
