#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  UpdatePublicTrustEnrollmentError,
  enrollUpdatePublicTrust,
} from "./update-public-trust-enrollment.mjs";

function fail(code, detail = "") {
  throw new UpdatePublicTrustEnrollmentError(code, detail);
}

export function parseUpdatePublicTrustEnrollmentArguments(argv) {
  const allowed = new Set(["--product-root", "--source", "--expected-sha256"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) {
      // Keine unbekannten Werte spiegeln: Selbst ein versehentlich hier
      // eingesetztes Passwort darf nicht im Fehlerprotokoll auftauchen.
      fail("UPDATE_TRUST_ENROLL_ARGUMENT_INVALID");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || values.has(flag)) {
      fail("UPDATE_TRUST_ENROLL_ARGUMENT_INVALID", flag);
    }
    values.set(flag, value);
    index += 1;
  }
  for (const flag of allowed) {
    if (!values.has(flag)) fail("UPDATE_TRUST_ENROLL_ARGUMENT_REQUIRED", flag);
  }
  if (!path.isAbsolute(values.get("--product-root"))) {
    fail("UPDATE_TRUST_ENROLL_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  }
  if (!path.isAbsolute(values.get("--source"))) {
    fail("UPDATE_TRUST_ENROLL_SOURCE_ABSOLUTE_REQUIRED");
  }
  return Object.freeze({
    productRoot: path.resolve(values.get("--product-root")),
    sourceFile: path.resolve(values.get("--source")),
    expectedSha256: values.get("--expected-sha256"),
  });
}

export async function runUpdatePublicTrustEnrollmentCli(argv = process.argv.slice(2)) {
  return enrollUpdatePublicTrust(parseUpdatePublicTrustEnrollmentArguments(argv));
}

if (
  process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  runUpdatePublicTrustEnrollmentCli().then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  }).catch((error) => {
    const code = typeof error?.code === "string" ? error.code : "UPDATE_TRUST_ENROLL_FAILED";
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code,
      message: error?.message || code,
    })}\n`);
    process.exitCode = 1;
  });
}
