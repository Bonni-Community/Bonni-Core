import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PREBUILT_FRONTEND_MARKER = ".bonni-prebuilt-release.json";
export const CORE_VERSION = "0.1.19";
const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function treeHash(files) {
  return hash(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(""));
}

async function assertBackendCoreVersion() {
  const backendPackage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "package.json");
  const pkg = JSON.parse(await fs.readFile(backendPackage, "utf8"));
  if (pkg.name !== "bonni-core-backend" || pkg.version !== CORE_VERSION) {
    throw new Error(`SETUP_PREBUILT_FRONTEND_BACKEND_VERSION_MISMATCH:${pkg.name || "unknown"}@${pkg.version || "unknown"}`);
  }
}

export async function bindFrontendCoreVersion(root) {
  const indexPath = path.join(root, "index.html");
  const state = await fs.lstat(indexPath).catch(() => null);
  if (!state?.isFile() || state.isSymbolicLink()) throw new Error("SETUP_PREBUILT_FRONTEND_INDEX_MISSING");
  const source = await fs.readFile(indexPath, "utf8");
  const withoutOldBinding = source.replace(/\?core=\d+\.\d+\.\d+/gu, "");
  let count = 0;
  const bound = withoutOldBinding.replace(
    /((?:src|href)=["']\/assets\/[^"'?]+\.(?:js|css))(["'])/gu,
    (_match, asset, quote) => {
      count += 1;
      return `${asset}?core=${CORE_VERSION}${quote}`;
    },
  );
  if (count < 1) throw new Error("SETUP_PREBUILT_FRONTEND_ASSET_BINDING_MISSING");
  await fs.writeFile(indexPath, bound, "utf8");
  return count;
}

async function collectFrontendTree(root) {
  const rootState = await fs.lstat(root).catch(() => null);
  if (!rootState?.isDirectory() || rootState.isSymbolicLink()) throw new Error("SETUP_PREBUILT_FRONTEND_MISSING");
  const files = [];
  let totalBytes = 0;
  async function walk(relative) {
    const directory = relative ? path.join(root, ...relative.split("/")) : root;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (child === PREBUILT_FRONTEND_MARKER) continue;
      if (entry.isSymbolicLink()) throw new Error(`SETUP_PREBUILT_FRONTEND_SYMLINK:${child}`);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        const content = await fs.readFile(path.join(root, ...child.split("/")));
        totalBytes += content.byteLength;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error("SETUP_PREBUILT_FRONTEND_TOO_LARGE");
        files.push({ path: child, bytes: content.byteLength, sha256: hash(content) });
        if (files.length > MAX_FILES) throw new Error("SETUP_PREBUILT_FRONTEND_FILE_COUNT_EXCEEDED");
      } else throw new Error(`SETUP_PREBUILT_FRONTEND_TYPE_INVALID:${child}`);
    }
  }
  await walk("");
  if (!files.some((file) => file.path === "index.html")) throw new Error("SETUP_PREBUILT_FRONTEND_INDEX_MISSING");
  return files;
}

export async function createPrebuiltFrontendMarker(root) {
  await assertBackendCoreVersion();
  await bindFrontendCoreVersion(root);
  const files = await collectFrontendTree(root);
  const marker = {
    schemaVersion: "bonni.prebuilt-frontend/v1",
    coreVersion: CORE_VERSION,
    files,
    treeSha256: treeHash(files),
  };
  await fs.writeFile(path.join(root, PREBUILT_FRONTEND_MARKER), `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o444,
  });
  return marker;
}

export async function verifyPrebuiltFrontend(root) {
  await assertBackendCoreVersion();
  const markerPath = path.join(root, PREBUILT_FRONTEND_MARKER);
  const markerState = await fs.lstat(markerPath).catch(() => null);
  if (!markerState?.isFile() || markerState.isSymbolicLink()) throw new Error("SETUP_PREBUILT_FRONTEND_MARKER_MISSING");
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    throw new Error("SETUP_PREBUILT_FRONTEND_MARKER_INVALID");
  }
  if (
    marker?.schemaVersion !== "bonni.prebuilt-frontend/v1"
    || marker?.coreVersion !== CORE_VERSION
    || !Array.isArray(marker.files)
    || !/^[a-f0-9]{64}$/u.test(String(marker.treeSha256 || ""))
  ) throw new Error("SETUP_PREBUILT_FRONTEND_MARKER_INVALID");
  const index = await fs.readFile(path.join(root, "index.html"), "utf8");
  if (!index.includes(`?core=${CORE_VERSION}`) || /\?core=(?!0\.1\.19)\d+\.\d+\.\d+/u.test(index)) {
    throw new Error("SETUP_PREBUILT_FRONTEND_CORE_VERSION_MISMATCH");
  }
  const actual = await collectFrontendTree(root);
  if (JSON.stringify(actual) !== JSON.stringify(marker.files)) throw new Error("SETUP_PREBUILT_FRONTEND_EXACT_TREE_MISMATCH");
  if (treeHash(actual) !== marker.treeSha256) throw new Error("SETUP_PREBUILT_FRONTEND_TREE_HASH_MISMATCH");
  return marker;
}

export async function resolveFrontendSetupMode({ frontendRoot, publishedFrontendRoot }) {
  const sourcePackage = await fs.lstat(path.join(frontendRoot, "package.json")).catch(() => null);
  if (sourcePackage?.isFile() && !sourcePackage.isSymbolicLink()) return "source";
  await verifyPrebuiltFrontend(publishedFrontendRoot);
  return "prebuilt";
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  const [action, target] = process.argv.slice(2);
  if (!target || !["--write", "--verify"].includes(action)) {
    throw new Error("Usage: node prebuilt-frontend.mjs --write|--verify <frontend-root>");
  }
  const resolved = path.resolve(target);
  const result = action === "--write"
    ? await createPrebuiltFrontendMarker(resolved)
    : await verifyPrebuiltFrontend(resolved);
  console.log(`[bonni-frontend] ${action === "--write" ? "Marker geschrieben" : "Prebuilt geprüft"}: ${result.treeSha256}`);
}
