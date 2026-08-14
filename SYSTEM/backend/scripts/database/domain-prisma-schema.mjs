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
]);

const sourceDirectories = Object.freeze({
  people: ["prisma/domains/people"],
  organization: ["prisma/domains/organization"],
  privacy: ["prisma/domains/system/privacy"],
  hocket: ["prisma/domains/assembled/app/hocketapp"],
  kontor: ["prisma/domains/assembled/app/kontorapp"],
  meet: ["prisma/domains/assembled/app/meetapp"],
  stueberl: ["prisma/domains/assembled/app/stueberlapp"],
  pos: ["prisma/domains/assembled/app/posapp"],
});

const moduleDomainPackages = Object.freeze({
  hocket: Object.freeze({ packageDirectory: "hocketapp", required: false }),
  kontor: Object.freeze({ packageDirectory: "kontorapp", required: true }),
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
  for (const parent of ["app", "apps"]) {
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
  if (!active.includes("core") || !active.includes("kontor")) {
    throw new Error("DATA_DOMAIN_REQUIRED_SET_INVALID");
  }
  return Object.freeze(active);
}

export const listAvailableDataDomains = listActiveDataDomains;

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
