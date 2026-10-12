import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { atomicJson, rebuildLicenseCatalog, validCoreLicenseVersion } from "./license-payload-utils.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const licenseRoot = path.resolve(args.get("--license-root") || "");
const version = args.get("--version");
const noticeSource = path.resolve(args.get("--notice") || "");
if (!licenseRoot || !validCoreLicenseVersion(version) || !noticeSource) {
  throw new Error("CORE_LICENSE_FINALIZE_ARGUMENTS_INVALID");
}

const versionRoot = path.join(licenseRoot, "platform", "bonni-core", version);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const files = [];
async function collect(root, prefix = "") {
  const entries = await fs.readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) await collect(absolute, relative);
    else if (entry.isFile() && entry.name !== "RECEIPT.json") {
      const content = await fs.readFile(absolute);
      files.push({ path: relative, bytes: content.length, sha256: sha256(content) });
    }
  }
}

await fs.copyFile(noticeSource, path.join(versionRoot, "BONNI_CORE_LICENSE_NOTICE.md"));
await collect(versionRoot);
files.sort((left, right) => left.path.localeCompare(right.path, "en"));
const treeSha256 = sha256(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}`).join("\n"));
const receipt = {
  schemaVersion: "bonni.platform-legal-receipt/v1",
  product: "bonni-core",
  version,
  projectLicense: "UNDECLARED",
  files,
  treeSha256,
};
await atomicJson(path.join(versionRoot, "RECEIPT.json"), receipt, 0o444);

// Der Katalog wird immer aus dem vollständigen zentralen Zielbestand erzeugt.
// Dadurch bleiben der geschützte Core-Vorgänger und bereits installierte
// Modulstände während der Funktionsprüfung sichtbar.
const catalog = await rebuildLicenseCatalog(licenseRoot);
console.log(`[core-license] Katalog erstellt: ${catalog.entries.length} Einträge`);
