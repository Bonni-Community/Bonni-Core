import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const packageRoot = path.resolve(args.get("--package-root") || "");
const outputRoot = path.resolve(args.get("--output-root") || "");
const component = args.get("--component");
const version = args.get("--version");
if (!packageRoot || !outputRoot || !["backend", "frontend"].includes(component) || !version) {
  throw new Error("CORE_LICENSE_ARGUMENTS_INVALID");
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const safeName = (value) => value.replace(/^@/u, "").replaceAll("/", "__").replace(/[^A-Za-z0-9._-]/gu, "_");
const licenseNames = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "COPYING", "NOTICE", "NOTICE.md"];
const lock = JSON.parse(await fs.readFile(path.join(packageRoot, "package-lock.json"), "utf8"));
const packages = lock.packages || {};
const dependencies = [];

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(path.join(outputRoot, "licenses"), { recursive: true });

for (const [relative, metadata] of Object.entries(packages)) {
  if (!relative.includes("node_modules/") || !metadata?.version) continue;
  const installedRoot = path.resolve(packageRoot, relative);
  if (!installedRoot.startsWith(`${packageRoot}${path.sep}`)) throw new Error("CORE_LICENSE_PACKAGE_ESCAPE");
  const packageSource = await fs.readFile(path.join(installedRoot, "package.json"), "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  // package-lock enthält auch plattformfremde optionale Pakete, die npm auf
  // dem aktuellen Betriebssystem bewusst nicht installiert.
  if (!packageSource) continue;
  const packageJson = JSON.parse(packageSource);
  const identity = `${packageJson.name}@${packageJson.version}`;
  if (dependencies.some((entry) => entry.identity === identity)) continue;
  const copied = [];
  for (const name of licenseNames) {
    const source = path.join(installedRoot, name);
    const content = await fs.readFile(source).catch(() => null);
    if (!content) continue;
    const relativeTarget = `licenses/${safeName(identity)}/${name}`;
    const target = path.join(outputRoot, ...relativeTarget.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { mode: 0o444 });
    copied.push({ path: relativeTarget, bytes: content.length, sha256: sha256(content) });
  }
  dependencies.push({
    identity,
    name: packageJson.name,
    version: packageJson.version,
    license: packageJson.license || metadata.license || "UNKNOWN",
    licenseFiles: copied,
  });
}

dependencies.sort((left, right) => left.identity.localeCompare(right.identity, "en"));
const inventory = {
  schemaVersion: "bonni.core-third-party-inventory/v1",
  product: "bonni-core",
  productVersion: version,
  component,
  dependencyCount: dependencies.length,
  dependencies,
};
const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
await fs.writeFile(path.join(outputRoot, "THIRD_PARTY_BUNDLES.json"), serialized, { mode: 0o444 });
await fs.writeFile(path.join(outputRoot, "COMPONENT_RECEIPT.json"), `${JSON.stringify({
  schemaVersion: "bonni.core-license-component/v1",
  product: "bonni-core",
  productVersion: version,
  component,
  dependencyCount: dependencies.length,
  inventorySha256: sha256(serialized),
}, null, 2)}\n`, { mode: 0o444 });

console.log(`[core-license] ${component}: ${dependencies.length} Abhängigkeiten`);
