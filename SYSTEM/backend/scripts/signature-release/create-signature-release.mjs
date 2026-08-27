#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  parseSignatureReleaseArguments,
  runSignatureRelease,
  signatureReleaseHelp,
} from "./signature-release.mjs";

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseSignatureReleaseArguments(argv, env);
  if (options.help) {
    console.log(signatureReleaseHelp());
    return 0;
  }
  const result = await runSignatureRelease(options);
  console.log(`${result.label} ${result.version}`);
  console.log(`Signaturbereich geprueft: ${result.keyScope} (${result.keyId})`);
  if (result.state === "dry-run") {
    console.log(result.artifactReady
      ? "Trockenlauf erfolgreich: OCI-Artefakt und Signaturfreigabe sind bereit."
      : "Trockenlauf erfolgreich: Als naechstes muss das OCI-Artefakt gebaut werden.");
  } else {
    console.log(`Installierbares Release erstellt: ${result.outputDirectory}`);
    console.log(`GitHub-Tag: ${result.releaseTag}`);
    console.log(`Manifest: ${result.manifestUrl}`);
    console.log(`Oeffentlicher Schluessel-Fingerabdruck: ${result.publicKeyFingerprint}`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "RELEASE_FAILED");
    process.exitCode = 1;
  });
}
