import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { resolveBonniProjectRoot } from "../project-root.js";
import type { ModuleKind, ModuleManifestSummary } from "../types.js";
import { normalizeDeclaredModuleTerminalAccounts } from "../../auth/terminal-accounts/terminal-account-declaration.js";
import { loadModuleRpcContract, validateModuleRpcContract } from "./module-rpc-contract.js";
import { parseStaticTypeScriptManifest } from "./static-manifest-parser.js";

const PACKAGE_ROOTS: Array<{ kind: ModuleKind; directories: string[] }> = [
  { kind: "app", directories: ["app", "apps"] },
  { kind: "addon", directories: ["addons", "add-on", "addon"] },
  { kind: "plugin", directories: ["plugins", "plug-in", "plugin"] },
  { kind: "bridge", directories: ["bridges", "bridge"] },
];

const MANIFEST_FILES = [
  "module.manifest.json",
  "app.manifest.json",
  "addon.manifest.json",
  "plugin.manifest.json",
  "bridge.manifest.json",
  "manifest.json",
  "manifest.ts",
] as const;

const SKIPPED_DIRECTORIES = new Set([".git", ".cache", "build", "coverage", "dist", "node_modules"]);
const MANIFEST_KEY = /^(app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_RELATIVE_PATH = /^[^\u0000-\u001f\u007f\\]+$/;
const IFRAME_SANDBOX_CAPABILITIES = new Set(["downloads", "forms", "popups"]);

async function readJson(file: string) {
  const stats = await fs.stat(file);
  if (!stats.isFile() || stats.size < 2 || stats.size > 256 * 1024) {
    throw new Error("MODULE_MANIFEST_JSON_SIZE_INVALID");
  }
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw);
}

async function readManifest(file: string) {
  if (file.endsWith(".json")) return readJson(file);
  return parseStaticTypeScriptManifest(await fs.readFile(file, "utf8"));
}

function normalizeKind(value: unknown, fallback: ModuleKind): ModuleKind {
  const normalized = String(value || fallback).trim().toLowerCase().replaceAll("_", "-");
  if (["add-on", "addon"].includes(normalized)) return "addon";
  if (["plug-in", "plugin"].includes(normalized)) return "plugin";
  if (normalized === "bridge") return "bridge";
  return "app";
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPackageRelativePath(value: unknown) {
  const candidate = String(value || "").trim();
  if (
    !candidate
    || candidate.length > 512
    || path.isAbsolute(candidate)
    || !PACKAGE_RELATIVE_PATH.test(candidate)
  ) {
    return false;
  }
  const normalized = path.posix.normalize(candidate);
  return normalized !== ".." && !normalized.startsWith("../") && !normalized.startsWith("/");
}

function isAbsoluteUrlPath(value: unknown) {
  const candidate = String(value || "").trim();
  return (
    candidate.startsWith("/")
    && !candidate.startsWith("//")
    && candidate.length <= 2048
    && !candidate.includes("\\")
    && !candidate.includes("?")
    && !candidate.includes("#")
    && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(candidate)
    && !/[\u0000-\u001f\u007f]/.test(candidate)
  );
}

function allUniqueStrings(value: unknown, maximum = 256) {
  return (
    Array.isArray(value)
    && value.length <= maximum
    && value.every((entry) => typeof entry === "string" && entry.trim() === entry && entry.length > 0 && entry.length <= 200)
    && new Set(value).size === value.length
  );
}

function defaultPrismaAssemblyPath(kind: ModuleKind, key: string) {
  const directory = kind === "addon" ? "add-on" : kind === "plugin" ? "plug-in" : kind;
  const keyPrefix = `${kind}.`;
  const suffix = key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key;
  const segments = suffix.split(".").filter(Boolean);
  if (!segments.length || segments.some((segment) => !/^[a-z0-9][a-z0-9-]{0,99}$/.test(segment))) {
    return null;
  }
  return `backend/prisma/domains/assembled/${directory}/${segments.join("/")}`;
}

async function findManifestFiles(directory: string): Promise<string[]> {
  const manifests: string[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const manifestName = MANIFEST_FILES.find((candidate) => names.has(candidate));
  if (manifestName) manifests.push(path.join(directory, manifestName));

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    manifests.push(...await findManifestFiles(path.join(directory, entry.name)));
  }

  return manifests;
}

async function collectManifests(
  kind: ModuleKind,
  rootDirectory: string,
  strict: boolean,
): Promise<ModuleManifestSummary[]> {
  const projectRoot = resolveBonniProjectRoot();
  const root = path.join(projectRoot, rootDirectory);
  if (!existsSync(root)) return [];

  const manifests: ModuleManifestSummary[] = [];
  const manifestFiles = await findManifestFiles(root);

  for (const manifestPath of manifestFiles) {
    try {
      const manifest = await readManifest(manifestPath);
      const packageRoot = path.dirname(manifestPath);
      const key = String(manifest.key || manifest.id || path.basename(packageRoot)).trim();
      if (!key) continue;
      const normalizedKind = normalizeKind(manifest.kind || manifest.type, kind);
      const sourceFrontend = isRecord(manifest.frontend) ? manifest.frontend : undefined;
      const rpcContractPath = typeof sourceFrontend?.rpcContract === "string"
        ? sourceFrontend.rpcContract.trim()
        : "";
      const frontend = sourceFrontend && rpcContractPath
        ? {
            ...sourceFrontend,
            rpcContractPath,
            rpcContract: await loadModuleRpcContract({
              packageRoot,
              contractPath: rpcContractPath,
              moduleId: key,
            }),
          }
        : sourceFrontend;
      const sourcePrisma = isRecord(manifest.prisma) ? manifest.prisma : undefined;
      const derivedAssemblyPath = sourcePrisma?.source && !sourcePrisma.assembled
        ? defaultPrismaAssemblyPath(normalizedKind, key)
        : null;
      const prisma = sourcePrisma && derivedAssemblyPath
        ? { ...sourcePrisma, assembled: derivedAssemblyPath }
        : sourcePrisma;

      manifests.push({
        ...manifest,
        key,
        kind: normalizedKind,
        name: manifest.name || manifest.label || key,
        version: manifest.version || "0.0.0",
        description: manifest.description,
        backend: manifest.backend,
        frontend,
        prisma,
        provides: manifest.provides,
        dependsOn: manifest.dependsOn,
        permissions: manifest.permissions,
        navigation: manifest.navigation,
        compatibility: manifest.compatibility,
        installation: manifest.installation,
        legal: manifest.legal,
        metadata: manifest.metadata,
        sourcePath: path.relative(projectRoot, packageRoot).replaceAll("\\", "/"),
        manifestPath: path.relative(projectRoot, manifestPath).replaceAll("\\", "/"),
      });
    } catch (error) {
      const relativePath = path.relative(projectRoot, manifestPath).replaceAll("\\", "/");
      if (strict) {
        throw new Error(
          `MODULE_MANIFEST_INVALID:${relativePath}:${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      console.warn(`[module-manager] Manifest ${relativePath} wurde ignoriert:`, error instanceof Error ? error.message : error);
    }
  }

  return manifests;
}

function canonicalPackageDirectoryScore(manifest: ModuleManifestSummary) {
  const declaredDirectory = String((manifest.metadata as any)?.packageDirectory || "").trim();
  if (!declaredDirectory || declaredDirectory.includes("/") || declaredDirectory.includes("\\")) return 0;
  const actualDirectory = path.posix.basename(String(manifest.sourcePath || ""));
  return actualDirectory === declaredDirectory ? 1 : 0;
}

export async function listModuleManifests(
  options: { strict?: boolean } = {},
): Promise<ModuleManifestSummary[]> {
  const groups = await Promise.all(
    PACKAGE_ROOTS.flatMap((root) => root.directories.map((directory) => (
      collectManifests(root.kind, directory, options.strict === true)
    ))),
  );
  const unique = new Map<string, ModuleManifestSummary>();
  for (const manifest of groups.flat()) {
    const existing = unique.get(manifest.key);
    if (!existing || canonicalPackageDirectoryScore(manifest) > canonicalPackageDirectoryScore(existing)) {
      unique.set(manifest.key, manifest);
    }
  }
  return [...unique.values()].sort((left, right) => left.kind.localeCompare(right.kind, "de") || left.name.localeCompare(right.name, "de"));
}

export async function findModuleManifest(key: string): Promise<ModuleManifestSummary | null> {
  const manifests = await listModuleManifests();
  return manifests.find((manifest) => manifest.key === key) || null;
}

export function validateModuleManifest(manifest: any) {
  const errors: string[] = [];
  if (!isRecord(manifest)) {
    return { ok: false, errors: ["Manifest muss ein Objekt sein."] };
  }

  const key = String(manifest.key || manifest.id || "").trim();
  if (!key) {
    errors.push("Manifest braucht key oder id.");
  } else if (!MANIFEST_KEY.test(key)) {
    errors.push("Manifest-key hat kein gültiges kanonisches Format.");
  }

  const kind = normalizeKind(manifest.kind || manifest.type, "app");
  const declaredKind = String(manifest.kind || manifest.type || "").trim();
  if (!declaredKind || !["app", "add-on", "addon", "plug-in", "plugin", "bridge"].includes(declaredKind)) {
    errors.push("Manifest kind muss app, addon, plugin oder bridge sein.");
  } else if (key && !key.startsWith(`${kind}.`)) {
    errors.push("Manifest-key und kind widersprechen sich.");
  }

  const name = String(manifest.name || "").trim();
  if (!name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)) {
    errors.push("Manifest braucht einen gültigen Namen.");
  }

  const version = String(manifest.version || "").trim();
  if (!version) {
    errors.push("Manifest braucht version.");
  } else if (!SEMVER.test(version)) {
    errors.push("Manifest-version muss SemVer entsprechen.");
  }

  if (manifest.backend !== undefined) {
    if (!isRecord(manifest.backend)) {
      errors.push("backend muss ein Objekt sein.");
    } else if (manifest.backend.entry !== undefined && !isPackageRelativePath(manifest.backend.entry)) {
      errors.push("backend.entry muss innerhalb des Pakets liegen.");
    }
  }

  const frontend = manifest.frontend;
  if (frontend !== undefined) {
    if (!isRecord(frontend)) {
      errors.push("frontend muss ein Objekt sein.");
    } else {
      if (frontend.entry !== undefined && !isPackageRelativePath(frontend.entry)) {
        errors.push("frontend.entry muss innerhalb des Pakets liegen.");
      }
      if (frontend.publicRoot !== undefined && !isPackageRelativePath(frontend.publicRoot)) {
        errors.push("frontend.publicRoot muss innerhalb des Pakets liegen.");
      }
      for (const field of ["runtimeEntry", "mountPath", "publicEntry", "memberEntry"] as const) {
        if (frontend[field] !== undefined && !isAbsoluteUrlPath(frontend[field])) {
          errors.push(`frontend.${field} muss ein sicherer absoluter URL-Pfad sein.`);
        }
      }
      if (
        frontend.publicEntry !== undefined
        && frontend.memberEntry !== undefined
        && frontend.publicEntry === frontend.memberEntry
      ) {
        errors.push("frontend.publicEntry und frontend.memberEntry müssen verschieden sein.");
      }
      if (frontend.memberEntry !== undefined && !String(frontend.route || "").trim()) {
        errors.push("frontend.memberEntry benötigt frontend.route als internes Ziel.");
      }
      if (frontend.integration !== undefined && !["module", "iframe"].includes(frontend.integration)) {
        errors.push("frontend.integration ist ungültig.");
      }
      if (frontend.transport !== undefined && frontend.transport !== "opaque-rpc-v1") {
        errors.push("frontend.transport ist nicht unterstützt.");
      }
      if (frontend.transport === "opaque-rpc-v1" && frontend.integration !== "iframe") {
        errors.push("opaque-rpc-v1 ist nur für iframe-Module erlaubt.");
      }
      if (
        frontend.sandboxCapabilities !== undefined
        && (
          !allUniqueStrings(frontend.sandboxCapabilities, IFRAME_SANDBOX_CAPABILITIES.size)
          || frontend.sandboxCapabilities.some((capability: string) => (
            !IFRAME_SANDBOX_CAPABILITIES.has(capability)
          ))
        )
      ) {
        errors.push("frontend.sandboxCapabilities enthält nicht erlaubte Fähigkeiten.");
      }
      if (
        frontend.sandboxCapabilities !== undefined
        && frontend.integration !== "iframe"
      ) {
        errors.push("frontend.sandboxCapabilities ist nur für iframe-Module erlaubt.");
      }
      if (frontend.rpcContractPath !== undefined && !isPackageRelativePath(frontend.rpcContractPath)) {
        errors.push("frontend.rpcContractPath muss innerhalb des Pakets liegen.");
      }
      if (frontend.transport === "opaque-rpc-v1") {
        if (!isRecord(frontend.rpcContract)) {
          errors.push("opaque-rpc-v1 benötigt einen geladenen RPC-Vertrag.");
        } else {
          try {
            validateModuleRpcContract(frontend.rpcContract, key);
          } catch (error) {
            errors.push(error instanceof Error ? error.message : "RPC-Vertrag ist ungültig.");
          }
        }
      } else if (frontend.rpcContract !== undefined || frontend.rpcContractPath !== undefined) {
        errors.push("Ein RPC-Vertrag benötigt frontend.transport opaque-rpc-v1.");
      }
    }
  }

  if (manifest.prisma !== undefined) {
    if (!isRecord(manifest.prisma)) {
      errors.push("prisma muss ein Objekt sein.");
    } else {
      const source = manifest.prisma.source;
      const assembled = manifest.prisma.assembled;
      if (source === undefined && assembled !== undefined) {
        errors.push("prisma.assembled benötigt prisma.source.");
      }
      if (source !== undefined && !isPackageRelativePath(source)) {
        errors.push("prisma.source muss innerhalb des Pakets liegen.");
      }
      if (assembled !== undefined && !isPackageRelativePath(assembled)) {
        errors.push("prisma.assembled ist ungültig.");
      }
      if (
        manifest.prisma.exclude !== undefined
        && (
          !allUniqueStrings(manifest.prisma.exclude)
          || manifest.prisma.exclude.some((entry: string) => (
            entry.startsWith("/")
            || entry.includes("\\")
            || entry.split("/").includes("..")
          ))
        )
      ) {
        errors.push("prisma.exclude enthält ungültige Pfade.");
      }
    }
  }

  for (const field of ["provides", "dependsOn"] as const) {
    if (manifest[field] !== undefined && !allUniqueStrings(manifest[field])) {
      errors.push(`${field} muss eine Liste eindeutiger Schlüssel sein.`);
    }
  }

  if (manifest.permissions !== undefined) {
    const permissions = manifest.permissions;
    const valid = Array.isArray(permissions)
      ? allUniqueStrings(permissions)
      : isRecord(permissions)
        ? (
          (permissions.provides === undefined || allUniqueStrings(permissions.provides))
          && (permissions.requires === undefined || allUniqueStrings(permissions.requires))
        )
        : false;
    if (!valid) errors.push("permissions ist ungültig.");
  }

  if (manifest.installation !== undefined) {
    if (!isRecord(manifest.installation)) {
      errors.push("installation muss ein Objekt sein.");
    } else {
      for (const field of [
        "installable",
        "autoInstall",
        "snapshotRequired",
        "rollbackSupported",
        "healthcheckRequired",
      ]) {
        if (manifest.installation[field] !== undefined && typeof manifest.installation[field] !== "boolean") {
          errors.push(`installation.${field} muss boolean sein.`);
        }
      }
    }
  }

  if (manifest.legal !== undefined) {
    const legal = manifest.legal;
    if (!isRecord(legal)) {
      errors.push("legal muss ein Objekt sein.");
    } else {
      if (legal.schemaVersion !== "bonni.module-legal/v1") {
        errors.push("legal.schemaVersion muss bonni.module-legal/v1 sein.");
      }
      if (!isPackageRelativePath(legal.notices)) {
        errors.push("legal.notices muss innerhalb des Pakets liegen.");
      }
      if (
        !allUniqueStrings(legal.payloadRoots, 16)
        || legal.payloadRoots.length < 1
        || legal.payloadRoots.some((entry: string) => !isPackageRelativePath(entry))
      ) {
        errors.push("legal.payloadRoots muss sichere eindeutige Paketpfade enthalten.");
      }
      if (!/^[a-f0-9]{64}$/.test(String(legal.treeSha256 || ""))) {
        errors.push("legal.treeSha256 muss ein SHA-256-Baumhash sein.");
      }
      if (!Number.isSafeInteger(legal.fileCount) || legal.fileCount < 1 || legal.fileCount > 20_000) {
        errors.push("legal.fileCount muss eine sichere positive Dateianzahl sein.");
      }
    }
  }

  if (manifest.metadata !== undefined) {
    if (!isRecord(manifest.metadata)) {
      errors.push("metadata muss ein Objekt sein.");
    } else {
      if (manifest.metadata.database !== undefined) {
        const database = manifest.metadata.database;
        const isDatabaseLessPrivacyIdeaCompatibility = (
          manifest.key === "plugin.privacyidea"
          && database?.mode === "scoped-v1"
          && database?.domain === "core"
          && Array.isArray(database?.delegates)
          && database.delegates.length === 1
          && database.delegates[0] === "twoFactorPluginStorageUnavailable"
        );
        if (!isRecord(database) || !["none", "scoped-v1"].includes(String(database.mode || ""))) {
          errors.push("metadata.database.mode muss none oder scoped-v1 sein.");
        } else if (database.mode === "none" && Object.keys(database).some((field) => field !== "mode")) {
          errors.push("metadata.database darf bei mode none nur mode enthalten.");
        } else if (
          database.mode === "scoped-v1"
          && !isDatabaseLessPrivacyIdeaCompatibility
          && !["hocket", "kontor", "meet", "stueberl", "pos"].includes(String(database.domain || ""))
        ) {
          errors.push("metadata.database.domain ist ungültig.");
        } else if (database.mode === "scoped-v1" && (
          !allUniqueStrings(database.delegates)
          || database.delegates.length < 1
          || database.delegates.some((entry: string) => !/^[a-z][A-Za-z0-9]{0,99}$/.test(entry))
        )) {
          errors.push("metadata.database.delegates ist ungültig.");
        }
      }

      if (manifest.metadata.accessProfiles !== undefined) {
        const profiles = manifest.metadata.accessProfiles;
        const providedPermissions = Array.isArray(manifest.permissions)
          ? manifest.permissions
          : isRecord(manifest.permissions) && Array.isArray(manifest.permissions.provides)
            ? manifest.permissions.provides
            : [];
        const validProfiles = (
          Array.isArray(profiles)
          && profiles.length > 0
          && profiles.length <= 100
          && profiles.every((profile: unknown) => (
            isRecord(profile)
            && Object.keys(profile).every((field) => (
              ["key", "label", "permission", "workspace", "usage", "accountType"].includes(field)
            ))
            && /^[a-z][a-z0-9-]{0,79}$/.test(String(profile.key || ""))
            && typeof profile.label === "string"
            && profile.label.trim() === profile.label
            && profile.label.length > 0
            && profile.label.length <= 120
            && typeof profile.permission === "string"
            && profile.permission.trim() === profile.permission
            && profile.permission.length > 0
            && profile.permission.length <= 200
            && providedPermissions.includes(profile.permission)
            && typeof profile.workspace === "string"
            && /^[A-Z][A-Z0-9_-]{0,79}$/.test(profile.workspace)
            && ["local", "technical"].includes(profile.usage)
            && ["MEMBER", "ADMIN", "TERMINAL", "SERVICE"].includes(profile.accountType)
            && (
              profile.usage !== "technical"
              || ["TERMINAL", "SERVICE"].includes(profile.accountType)
            )
            && (
              profile.usage !== "local"
              || ["MEMBER", "ADMIN"].includes(profile.accountType)
            )
          ))
          && new Set(profiles.map((profile: any) => profile.key)).size === profiles.length
          && new Set(profiles.map((profile: any) => profile.permission)).size === profiles.length
        );
        if (!validProfiles) {
          errors.push("metadata.accessProfiles ist ungültig.");
        }
      }

      if (
        manifest.metadata.autoAssignMemberAccess !== undefined
        && typeof manifest.metadata.autoAssignMemberAccess !== "boolean"
      ) {
        errors.push("metadata.autoAssignMemberAccess muss boolean sein.");
      }

      if (manifest.metadata.legacyAccessMappings !== undefined) {
        const mappings = manifest.metadata.legacyAccessMappings;
        const accessProfiles = Array.isArray(manifest.metadata.accessProfiles)
          ? manifest.metadata.accessProfiles
          : [];
        const localProfileKeys = new Set(
          accessProfiles
            .filter((profile: unknown) => (
              isRecord(profile)
              && profile.usage === "local"
              && ["MEMBER", "ADMIN"].includes(String(profile.accountType || ""))
            ))
            .map((profile: any) => profile.key),
        );
        const validMappingGroup = (value: unknown) => (
          value === undefined
          || (
            isRecord(value)
            && Object.keys(value).length <= 200
            && Object.entries(value).every(([legacyKey, profileKey]) => (
              /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(legacyKey)
              && typeof profileKey === "string"
              && localProfileKeys.has(profileKey)
            ))
          )
        );
        const validMappings = (
          isRecord(mappings)
          && Object.keys(mappings).every((field) => (
            ["roles", "capabilities"].includes(field)
          ))
          && validMappingGroup(mappings.roles)
          && validMappingGroup(mappings.capabilities)
        );
        if (!validMappings) {
          errors.push("metadata.legacyAccessMappings ist ungültig.");
        }
        if (
          !Array.isArray(manifest.dependsOn)
          || !manifest.dependsOn.includes("core.members")
        ) {
          errors.push("metadata.legacyAccessMappings benötigt dependsOn core.members.");
        }
      }

      const declaresTerminalAccountCapability = (
        Array.isArray(manifest.dependsOn)
        && manifest.dependsOn.includes("core.terminal-accounts")
      );
      const technicalAccounts = manifest.metadata.technicalAccounts;
      if (technicalAccounts !== undefined && !declaresTerminalAccountCapability) {
        errors.push("metadata.technicalAccounts benötigt dependsOn core.terminal-accounts.");
      } else if (declaresTerminalAccountCapability && technicalAccounts === undefined) {
        errors.push("dependsOn core.terminal-accounts benötigt metadata.technicalAccounts.");
      } else if (technicalAccounts !== undefined && key) {
        try {
          const declarations = normalizeDeclaredModuleTerminalAccounts(key, technicalAccounts);
          const accessProfiles = Array.isArray(manifest.metadata.accessProfiles)
            ? manifest.metadata.accessProfiles
            : [];
          const terminalProfiles = accessProfiles.filter((profile: unknown) => (
            isRecord(profile)
            && profile.usage === "technical"
            && profile.accountType === "TERMINAL"
          ));
          const terminalProfileByKey = new Map(
            terminalProfiles.map((profile: any) => [profile.key, profile]),
          );
          const declarationsMatchProfiles = (
            terminalProfiles.length === declarations.length
            && declarations.every((declaration) => {
              const profile = terminalProfileByKey.get(declaration.profileKey);
              return profile?.permission === declaration.permissionKey;
            })
          );
          if (!declarationsMatchProfiles) {
            errors.push(
              "metadata.technicalAccounts muss exakt auf technische TERMINAL-Zugriffsprofile zeigen.",
            );
          }
        } catch {
          errors.push("metadata.technicalAccounts ist ungültig.");
        }
      }
    }
  }

  const declaresMembersCapability = (
    Array.isArray(manifest.dependsOn)
    && manifest.dependsOn.includes("core.members")
  );
  if (declaresMembersCapability) {
    const accessProfiles = isRecord(manifest.metadata)
      && Array.isArray(manifest.metadata.accessProfiles)
      ? manifest.metadata.accessProfiles
      : [];
    const defaultMemberProfile = accessProfiles.find((profile: unknown) => (
      isRecord(profile)
      && profile.key === "member"
      && profile.usage === "local"
      && profile.accountType === "MEMBER"
    ));
    if (manifest.metadata?.autoAssignMemberAccess !== false && !defaultMemberProfile) {
      errors.push(
        "dependsOn core.members benötigt das lokale MEMBER-Zugriffsprofil member.",
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
