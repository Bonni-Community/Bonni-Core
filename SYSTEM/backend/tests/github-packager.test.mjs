import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createGitHubPackages,
  helpText,
  parseArguments,
} from "../scripts/github/create-github-packages.mjs";

async function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

async function fixture(t) {
  const productRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-github-package-"));
  t.after(() => fs.rm(productRoot, { recursive: true, force: true }));
  const systemRoot = path.join(productRoot, "SYSTEM");
  await write(systemRoot, "backend/package.json", '{"name":"backend","version":"1.2.3"}\n');
  await write(systemRoot, "backend/src/server.ts", "export const server = true;\n");
  await write(systemRoot, "backend/src/data/banks.json", "{}\n");
  await write(systemRoot, "backend/tests/jwt-secret-policy.test.mjs", "// source test, not a secret\n");
  await write(systemRoot, "backend/.env", "TOKEN=secret\n");
  await write(systemRoot, "backend/.env.example", "TOKEN=\n");
  await write(systemRoot, "backend/node_modules/pkg/index.js", "not packaged\n");
  await write(systemRoot, "backend/storage/private.json", "not packaged\n");
  await write(systemRoot, "backend/data/runtime.json", "not packaged\n");
  await write(systemRoot, "backend/config/private-key.pem", "not packaged\n");
  await write(systemRoot, "frontend/package.json", '{"name":"frontend","version":"1.2.3"}\n');
  await write(systemRoot, "frontend/src/main.jsx", "export default true;\n");
  await write(systemRoot, "frontend/dist/index.js", "not packaged\n");
  await write(systemRoot, "app/kontorapp/package.json", '{"name":"kontor","version":"4.5.6"}\n');
  await write(systemRoot, "app/kontorapp/backend/src/index.js", "export const kontor = true;\n");
  await write(systemRoot, "app/kontorapp/frontend/src/index.jsx", "export default true;\n");
  return { productRoot, systemRoot, outputRoot: path.join(productRoot, "GITHUB") };
}

test("Argumente akzeptieren die vier Komponentennamen, Aliase und dry-run", () => {
  assert.deepEqual(parseArguments(["core", "kontorapp", "stüberl", "hocket", "--dry-run"]), {
    selected: ["core", "kontor", "stueberl", "hocket"],
    dryRun: true,
    help: false,
  });
  assert.deepEqual(parseArguments([]).selected, ["core", "kontor", "stueberl", "hocket"]);
  assert.throws(() => parseArguments(["unbekannt"]), /Unbekannte Komponente/u);
  assert.match(helpText(), /npm run github -- core kontor stueberl hocket/u);
  assert.match(helpText(), /veroeffentlicht nichts/u);
});

test("erstellt reproduzierbare Einzel-ZIPs, ein Manifest und ueberspringt fehlende Apps", async (t) => {
  const { systemRoot, outputRoot } = await fixture(t);
  const options = { systemRoot, outputRoot, selected: ["core", "kontor", "stueberl", "hocket"] };
  const first = await createGitHubPackages(options);
  assert.deepEqual(first.packages.map((entry) => entry.component), ["core", "kontor"]);
  assert.deepEqual(first.missing.map((entry) => entry.component), ["stueberl", "hocket"]);

  const coreZip = await fs.readFile(path.join(outputRoot, "core-1.2.3.zip"));
  const kontorZip = await fs.readFile(path.join(outputRoot, "kontor-4.5.6.zip"));
  const coreNames = coreZip.toString("latin1");
  const kontorNames = kontorZip.toString("latin1");
  assert.match(coreNames, /core-1\.2\.3\/backend\/src\/server\.ts/u);
  assert.match(coreNames, /core-1\.2\.3\/backend\/src\/data\/banks\.json/u);
  assert.match(coreNames, /core-1\.2\.3\/backend\/tests\/jwt-secret-policy\.test\.mjs/u);
  assert.match(coreNames, /core-1\.2\.3\/backend\/\.env\.example/u);
  assert.doesNotMatch(coreNames, /node_modules|storage|private-key|backend\/\.env(?:[^.]|$)|\/dist\//u);
  assert.match(kontorNames, /kontor-4\.5\.6\/backend\/src\/index\.js/u);
  assert.doesNotMatch(kontorNames, /SYSTEM\/app\/kontorapp/u, "Der ZIP-Hauptpfad bleibt absichtlich kurz.");

  const firstCoreHash = first.packages.find((entry) => entry.component === "core").sha256;
  const second = await createGitHubPackages(options);
  const secondCoreZip = await fs.readFile(path.join(outputRoot, "core-1.2.3.zip"));
  assert.equal(second.packages.find((entry) => entry.component === "core").sha256, firstCoreHash);
  assert.deepEqual(secondCoreZip, coreZip);

  const manifest = JSON.parse(await fs.readFile(path.join(outputRoot, "github-packages.json"), "utf8"));
  assert.equal(manifest.published, false);
  assert.deepEqual(manifest.packages.map((entry) => entry.archive), ["core-1.2.3.zip", "kontor-4.5.6.zip"]);
  assert.deepEqual(manifest.missing.map((entry) => entry.component), ["stueberl", "hocket"]);
});

test("schliesst SIGNATUR vollstaendig aus ZIPs und Manifest aus", async (t) => {
  const { productRoot, systemRoot, outputRoot } = await fixture(t);
  await write(productRoot, "SIGNATUR/core/bonni-core-release-01.private.pem", "nicht einlesen\n");
  await write(systemRoot, "backend/SIGNATUR/core/bonni-core-release-01.private.pem", "nicht einlesen\n");
  await write(systemRoot, "app/kontorapp/SiGnAtUr/kontor-release-01.private.pem", "nicht einlesen\n");

  await createGitHubPackages({ systemRoot, outputRoot, selected: ["core", "kontor"] });

  const coreZipNames = (await fs.readFile(path.join(outputRoot, "core-1.2.3.zip"))).toString("latin1");
  const kontorZipNames = (await fs.readFile(path.join(outputRoot, "kontor-4.5.6.zip"))).toString("latin1");
  const manifestText = await fs.readFile(path.join(outputRoot, "github-packages.json"), "utf8");
  for (const artifactText of [coreZipNames, kontorZipNames, manifestText]) {
    assert.doesNotMatch(artifactText, /signatur|bonni-core-release-01|kontor-release-01/iu);
  }
});

test("bricht bei einem umbenannten privaten Schluesselmarker den gesamten Build ab", async (t) => {
  const { systemRoot, outputRoot } = await fixture(t);
  const privateKeyHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const privateKeyFooter = ["-----END", "PRIVATE KEY-----"].join(" ");
  await write(systemRoot, "frontend/src/release-notes.txt", [
    privateKeyHeader,
    "QUJDREVGR0hJSktMTU5PUA==",
    privateKeyFooter,
    "",
  ].join("\n"));

  await assert.rejects(
    createGitHubPackages({ systemRoot, outputRoot, selected: ["kontor", "core"] }),
    /privater Schluesselmarker im fertigen ZIP/u,
  );
  await assert.rejects(fs.stat(outputRoot), { code: "ENOENT" });
});

test("bricht bei sensibler Dateiendung im fertigen Artefakt ab", async (t) => {
  const { systemRoot, outputRoot } = await fixture(t);
  await write(systemRoot, "frontend/src/angebliches-bild.pem", "kein Schluesselmarker, aber sensibles Format\n");

  await assert.rejects(
    createGitHubPackages({ systemRoot, outputRoot, selected: ["core"] }),
    /sensibles Schluesseldateiformat im fertigen ZIP/u,
  );
  await assert.rejects(fs.stat(outputRoot), { code: "ENOENT" });
});

test("dry-run prueft die Quellen, legt aber keinen GITHUB-Ordner an", async (t) => {
  const { systemRoot, outputRoot } = await fixture(t);
  const result = await createGitHubPackages({ systemRoot, outputRoot, selected: ["core", "stueberl"], dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.packages[0].sha256, undefined);
  await assert.rejects(fs.stat(outputRoot), { code: "ENOENT" });
});

test("entfernt nur unveraenderte, vom letzten Manifest verwaltete alte ZIPs", async (t) => {
  const { systemRoot, outputRoot } = await fixture(t);
  await createGitHubPackages({ systemRoot, outputRoot, selected: ["core", "kontor"] });
  await fs.writeFile(path.join(outputRoot, "eigene-notiz.txt"), "behalten\n");

  const second = await createGitHubPackages({ systemRoot, outputRoot, selected: ["core"] });
  assert.deepEqual(second.cleanup.removed, ["kontor-4.5.6.zip"]);
  await assert.rejects(fs.stat(path.join(outputRoot, "kontor-4.5.6.zip")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(outputRoot, "eigene-notiz.txt"), "utf8"), "behalten\n");
  const manifest = JSON.parse(await fs.readFile(path.join(outputRoot, "github-packages.json"), "utf8"));
  assert.deepEqual(manifest.packages.map((entry) => entry.archive), ["core-1.2.3.zip"]);
});

test("bewahrt ein seit der letzten Erstellung veraendertes altes ZIP", async (t) => {
  const { systemRoot, outputRoot } = await fixture(t);
  await createGitHubPackages({ systemRoot, outputRoot, selected: ["core", "kontor"] });
  const oldKontor = path.join(outputRoot, "kontor-4.5.6.zip");
  await fs.appendFile(oldKontor, "manuell veraendert");

  const second = await createGitHubPackages({ systemRoot, outputRoot, selected: ["core"] });
  assert.deepEqual(second.cleanup.preserved, ["kontor-4.5.6.zip"]);
  assert.equal((await fs.lstat(oldKontor)).isFile(), true);
});

test("unterschiedliche Core-Versionen werden abgewiesen", async (t) => {
  const { systemRoot, outputRoot } = await fixture(t);
  await write(systemRoot, "frontend/package.json", '{"name":"frontend","version":"1.2.4"}\n');
  await assert.rejects(
    createGitHubPackages({ systemRoot, outputRoot, selected: ["core"] }),
    /unterschiedliche Versionen/u,
  );
});
