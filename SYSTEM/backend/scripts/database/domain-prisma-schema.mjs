import fs from "node:fs/promises";
import path from "node:path";

export const dataDomains = Object.freeze([
  "core",
  "people",
  "organization",
  "privacy",
  "hocket",
  "kontor",
  "meet",
  "stueberl",
  "pos",
  "hub",
  "gourmet",
  "capture",
  "paypal",
  "works",
]);

const sourceDirectories = Object.freeze({
  hub: ["prisma/domains/assembled/add-on/hub"],
  gourmet: ["prisma/domains/assembled/addon/gourmet"],
  capture: ["prisma/domains/assembled/add-on/capture"],
  paypal: ["prisma/domains/assembled/add-on/paypal"],
  people: ["prisma/domains/people"],
  organization: ["prisma/domains/organization"],
  privacy: ["prisma/domains/system/privacy"],
  works: ["prisma/domains/assembled/app/worksapp"],
  hocket: ["prisma/domains/assembled/app/hocketapp"],
  kontor: ["prisma/domains/assembled/app/kontorapp"],
  meet: ["prisma/domains/assembled/app/meetapp"],
  stueberl: ["prisma/domains/assembled/app/stueberlapp"],
  pos: ["prisma/domains/assembled/app/posapp"],
});

const moduleDomainPackages = Object.freeze({
  hub: Object.freeze({ packageDirectory: "hub", required: false }),
  gourmet: Object.freeze({ packageDirectory: "gourmet", required: false }),
  capture: Object.freeze({ packageDirectory: "capture", required: false }),
  paypal: Object.freeze({ packageDirectory: "paypal", required: false }),
  works: Object.freeze({ packageDirectory: "worksapp", required: false }),
  hocket: Object.freeze({ packageDirectory: "hocketapp", required: false }),
  kontor: Object.freeze({ packageDirectory: "kontorapp", required: false }),
  meet: Object.freeze({ packageDirectory: "meetapp", required: false }),
  stueberl: Object.freeze({ packageDirectory: "stueberlapp", required: false }),
  pos: Object.freeze({ packageDirectory: "posapp", required: false }),
});

async function optionalState(target) {
  return fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

async function packageRoots(projectRoot, packageDirectory, domain) {
  const systemRoot = path.resolve(projectRoot, "..");
  const roots = [];
  for (const parent of (["hub", "gourmet", "capture", "paypal"].includes(domain) ? ["addons", "add-on", "addon"] : ["app", "apps"])) {
    const relative = `${parent}/${packageDirectory}`;
    const absolute = path.join(systemRoot, parent, packageDirectory);
    const state = await optionalState(absolute);
    if (!state) continue;
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error(`DATA_DOMAIN_PACKAGE_ROOT_INVALID:${domain}:${relative}`);
    }
    roots.push({ absolute, relative });
  }
  if (roots.length > 1) throw new Error(`DATA_DOMAIN_PACKAGE_ROOT_AMBIGUOUS:${domain}`);
  return roots;
}

async function assembledDomainState(projectRoot, domain) {
  const directories = sourceDirectories[domain];
  const present = [];
  for (const directory of directories) {
    const absolute = path.join(projectRoot, directory);
    const state = await optionalState(absolute);
    if (!state) continue;
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error(`DATA_DOMAIN_SOURCE_DIRECTORY_INVALID:${domain}:${directory}`);
    }
    present.push({ absolute, relative: directory });
  }
  return present;
}

export async function listActiveDataDomains(projectRoot) {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const active = [];
  for (const domain of dataDomains) {
    const policy = moduleDomainPackages[domain];
    if (!policy) {
      active.push(domain);
      continue;
    }
    const [roots, assemblies] = await Promise.all([
      packageRoots(absoluteProjectRoot, policy.packageDirectory, domain),
      assembledDomainState(absoluteProjectRoot, domain),
    ]);
    if (!roots.length) {
      if (policy.required) throw new Error(`DATA_DOMAIN_REQUIRED_PACKAGE_ROOT_MISSING:${domain}`);
      if (assemblies.length) throw new Error(`DATA_DOMAIN_ORPHANED_ASSEMBLY:${domain}`);
      continue;
    }
    if (assemblies.length !== sourceDirectories[domain].length) {
      throw new Error(`DATA_DOMAIN_ASSEMBLY_MISSING:${domain}`);
    }
    const files = (await Promise.all(assemblies.map((entry) => prismaFiles(entry.absolute)))).flat();
    if (!files.length) throw new Error(`DATA_DOMAIN_SCHEMA_EMPTY:${domain}`);
    active.push(domain);
  }
  if (!active.includes("core")) {
    throw new Error("DATA_DOMAIN_REQUIRED_SET_INVALID");
  }
  return Object.freeze(active);
}

export const listAvailableDataDomains = listActiveDataDomains;

/** Module-owned, idempotent SQL upgrades run before schema push. No runtime DB access is widened. */
export async function applyDomainPrismaUpgrades(projectRoot, domain, client) {
  if (!dataDomains.includes(domain)) throw new Error(`UNKNOWN_DATA_DOMAIN:${domain}`);
  for (const source of sourceDirectories[domain] || []) {
    const directory = path.join(projectRoot, source, "upgrades");
    const state = await optionalState(directory);
    if (!state) continue;
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error(`DATA_DOMAIN_UPGRADES_INVALID:${domain}`);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!/^[0-9]{3}-[a-z0-9-]+\.sql$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw new Error(`DATA_DOMAIN_UPGRADE_FILE_INVALID:${domain}`);
      const sql = await fs.readFile(path.join(directory, entry.name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query(sql);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  }
}

async function prismaFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`DATA_DOMAIN_SCHEMA_SYMLINK_DENIED:${target}`);
    if (entry.isDirectory()) files.push(...await prismaFiles(target));
    if (entry.isFile() && entry.name.endsWith(".prisma")) files.push(target);
  }
  return files;
}

async function coreFiles(projectRoot) {
  const systemRoot = path.join(projectRoot, "prisma", "domains", "system");
  const entries = await fs.readdir(systemRoot, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name === "privacy") continue;
    files.push(...await prismaFiles(path.join(systemRoot, entry.name)));
  }
  return files;
}

export async function buildDomainPrismaSchema(projectRoot, domain) {
  if (!dataDomains.includes(domain)) {
    throw new Error(`UNKNOWN_DATA_DOMAIN:${domain}`);
  }

  const files = domain === "core"
    ? await coreFiles(projectRoot)
    : (await Promise.all(
        sourceDirectories[domain].map((directory) => prismaFiles(path.join(projectRoot, directory))),
      )).flat();

  if (!files.length) throw new Error(`DATA_DOMAIN_SCHEMA_EMPTY:${domain}`);

  const sources = await Promise.all(files.map(async (file) => ({
    file: path.relative(projectRoot, file).replaceAll(path.sep, "/"),
    text: await fs.readFile(file, "utf8"),
  })));

  return [
    `// Generated only for the isolated ${domain} schema deployment.`,
    "datasource db {",
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    "}",
    "",
    ...sources.flatMap(({ file, text }) => [
      `// ---- ${file} ----`,
      text.trim(),
      "",
    ]),
  ].join("\n");
}
