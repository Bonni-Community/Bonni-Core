#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  PublicCertificationError,
  getPublicCertificationStatus,
  importPublicCertification,
} from "./public-certification-store.mjs";

const MAX_STDIN_BYTES = 1024 * 1024;

function fail(code) {
  throw new PublicCertificationError(code);
}

export function parsePublicCertificationArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 1) fail("PUBLIC_CERTIFICATION_ARGUMENT_INVALID");
  const command = argv[0];
  if (!new Set(["status", "import-file", "import-stdin"]).has(command)) {
    fail("PUBLIC_CERTIFICATION_ARGUMENT_INVALID");
  }
  const allowed = new Set(["--product-root", "--source", "--expected-sha256"]);
  const values = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) fail("PUBLIC_CERTIFICATION_ARGUMENT_INVALID");
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || values.has(flag)) fail("PUBLIC_CERTIFICATION_ARGUMENT_INVALID");
    values.set(flag, value);
    index += 1;
  }
  if (!values.has("--product-root") || !path.isAbsolute(values.get("--product-root"))) {
    fail("PUBLIC_CERTIFICATION_PRODUCT_ROOT_ABSOLUTE_REQUIRED");
  }
  if (command === "status" && values.size !== 1) fail("PUBLIC_CERTIFICATION_ARGUMENT_INVALID");
  if (command === "import-file") {
    if (!values.has("--source") || !path.isAbsolute(values.get("--source"))) {
      fail("PUBLIC_CERTIFICATION_SOURCE_ABSOLUTE_REQUIRED");
    }
  } else if (values.has("--source")) {
    fail("PUBLIC_CERTIFICATION_ARGUMENT_INVALID");
  }
  return Object.freeze({
    command,
    productRoot: path.resolve(values.get("--product-root")),
    sourceFile: values.has("--source") ? path.resolve(values.get("--source")) : "",
    expectedSha256: values.get("--expected-sha256") || "",
  });
}

async function readBoundedStdin(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_STDIN_BYTES) fail("PUBLIC_CERTIFICATION_SOURCE_SIZE_INVALID");
    chunks.push(bytes);
  }
  if (size < 1) fail("PUBLIC_CERTIFICATION_SOURCE_SIZE_INVALID");
  return Buffer.concat(chunks);
}

export async function runPublicCertificationCli(argv = process.argv.slice(2), stdin = process.stdin) {
  const options = parsePublicCertificationArguments(argv);
  if (options.command === "status") {
    return getPublicCertificationStatus({ productRoot: options.productRoot });
  }
  if (options.command === "import-file") {
    return importPublicCertification(options);
  }
  const sourceBytes = await readBoundedStdin(stdin);
  return importPublicCertification({
    productRoot: options.productRoot,
    sourceBytes,
    expectedSha256: options.expectedSha256,
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runPublicCertificationCli().then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  }).catch((error) => {
    const code = typeof error?.code === "string" ? error.code : "PUBLIC_CERTIFICATION_FAILED";
    // Nur der stabile Code wird ausgegeben. Ein versehentlich uebergebenes
    // privates Geheimnis kann deshalb niemals im Protokoll gespiegelt werden.
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
  });
}
