import { listModuleManifests } from "../../../module-manager/manifests/index.js";
import type { ModuleManifestSummary } from "../../../module-manager/types.js";

import { systemDataClassificationCatalog } from "./data-classification.catalog.js";
import {
  listSystemDataClassificationProfiles,
  resolveSystemDataClassificationDeclaration,
} from "./data-classification.profiles.js";
import type {
  DataClassificationCapability,
  DataClassificationDeclaration,
  DataClassificationModuleSummary,
  DataClassificationOverview,
  DataClassificationSeverity,
  DataClassificationStatus,
} from "./data-classification.types.js";

const DEFAULT_CAPABILITIES: DataClassificationCapability = {
  usesMemberId: false,
  usesAccountId: false,
  requiresMasterKey: false,
  requires2FA: false,
  auditAlways: false,
};

type ModuleLike = {
  key: string;
  kind: string;
  name?: string;
  version?: string;
  sourcePath?: string;
  manifestPath?: string;
  metadata?: Record<string, unknown>;
  backend?: { entry?: string };
  frontend?: { entry?: string };
  prisma?: { source?: string; assembled?: string };
};

function isDataClassificationDeclaration(value: unknown): value is DataClassificationDeclaration {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getDeclaration(module: ModuleLike): DataClassificationDeclaration | undefined {
  const fromCatalog = systemDataClassificationCatalog[module.key];
  if (fromCatalog) return fromCatalog;

  const fromMetadata = module.metadata?.dataClassification;
  return isDataClassificationDeclaration(fromMetadata) ? fromMetadata : undefined;
}

function toClassificationStatus(declaration: DataClassificationDeclaration | undefined): DataClassificationStatus {
  if (!declaration) return "UNCLASSIFIED";
  if (declaration.reviewStatus === "IGNORED") return "IGNORED";
  if (declaration.reviewStatus === "APPROVED") return "CLASSIFIED";
  return "SUGGESTED";
}

function inferCapabilities(module: ModuleLike): { usesMemberId: boolean; usesAccountId: boolean; reason: string[] } {
  const haystack = [
    module.key,
    module.name,
    module.sourcePath,
    module.manifestPath,
    module.backend?.entry,
    module.frontend?.entry,
    module.prisma?.source,
    module.prisma?.assembled,
  ].filter(Boolean).join(" ").toLowerCase();

  const usesMemberId = haystack.includes("member") || haystack.includes("mitglied") || haystack.includes("memberid");
  const usesAccountId = haystack.includes("account") || haystack.includes("user") || haystack.includes("benutzer") || haystack.includes("accountid");
  const reason: string[] = [];

  if (usesMemberId) reason.push("Name oder Pfad deutet auf memberId/Memberdaten hin.");
  if (usesAccountId) reason.push("Name oder Pfad deutet auf accountId/Benutzerdaten hin.");

  return { usesMemberId, usesAccountId, reason };
}

function buildModuleSummary(module: ModuleLike): DataClassificationModuleSummary {
  const declaration = getDeclaration(module);
  const resolved = resolveSystemDataClassificationDeclaration(declaration);
  const inferred = inferCapabilities(module);
  const classificationStatus = toClassificationStatus(declaration);

  const capabilities: DataClassificationCapability = resolved
    ? {
        usesMemberId: resolved.usesMemberId,
        usesAccountId: resolved.usesAccountId,
        requiresMasterKey: resolved.requiresMasterKey,
        requires2FA: resolved.requires2FA,
        auditAlways: resolved.auditAlways,
      }
    : {
        ...DEFAULT_CAPABILITIES,
        usesMemberId: inferred.usesMemberId,
        usesAccountId: inferred.usesAccountId,
      };

  const criticalOpen = classificationStatus === "UNCLASSIFIED" && (capabilities.usesMemberId || capabilities.usesAccountId);
  const severity: DataClassificationSeverity = criticalOpen
    ? "ACTION_REQUIRED"
    : classificationStatus === "UNCLASSIFIED"
      ? "INFO"
      : "OK";

  return {
    moduleId: module.key,
    label: module.name ?? module.key,
    kind: module.kind,
    domain: module.key,
    status: classificationStatus,
    sourceRoots: [module.sourcePath, module.manifestPath].filter(Boolean) as string[],
    runtimeRoutes: [],
    classificationStatus,
    severity,
    profile: resolved?.profile ?? null,
    profileLabel: resolved?.profileLabel ?? null,
    areas: resolved?.areas ?? [],
    capabilities,
    dsgvoRelevant: resolved?.dsgvoRelevant ?? false,
    inferred,
    criticalOpen,
    owner: resolved?.owner ?? null,
    note: resolved?.note ?? null,
    reviewedAt: resolved?.reviewedAt ?? null,
    reviewedBy: resolved?.reviewedBy ?? null,
    actions: criticalOpen
      ? ["Modul bewusst klassifizieren oder ein Datenschutzprofil im Manifest hinterlegen."]
      : classificationStatus === "UNCLASSIFIED"
        ? ["Modul bei Gelegenheit klassifizieren."]
        : [],
  };
}

function buildOverview(modules: ModuleLike[]): DataClassificationOverview {
  const moduleSummaries = modules
    .map(buildModuleSummary)
    .sort((left, right) => left.kind.localeCompare(right.kind, "de") || left.label.localeCompare(right.label, "de"));

  return {
    ok: moduleSummaries.every((module) => !module.criticalOpen),
    area: "system/security/data-classification",
    generatedAt: new Date().toISOString(),
    policy: {
      mode: "OVERVIEW_ONLY",
      defaultClassification: "UNCLASSIFIED",
      activeIdentifiers: ["memberId", "accountId"],
      ignoredIdentifiers: ["userId", "personId"],
      blocking: false,
      preferredDeclarationMode: "PROFILE_REFERENCE",
    },
    profiles: listSystemDataClassificationProfiles().map((profile) => ({
      key: profile.key,
      label: profile.label,
      areas: [...profile.areas],
      usesMemberId: profile.usesMemberId,
      usesAccountId: profile.usesAccountId,
      requiresMasterKey: profile.requiresMasterKey,
      requires2FA: profile.requires2FA,
      auditAlways: profile.auditAlways,
      dsgvoRelevant: profile.dsgvoRelevant,
      description: profile.description,
    })),
    summary: {
      totalModuleCount: moduleSummaries.length,
      classifiedCount: moduleSummaries.filter((module) => module.classificationStatus === "CLASSIFIED").length,
      suggestedCount: moduleSummaries.filter((module) => module.classificationStatus === "SUGGESTED").length,
      unclassifiedCount: moduleSummaries.filter((module) => module.classificationStatus === "UNCLASSIFIED").length,
      ignoredCount: moduleSummaries.filter((module) => module.classificationStatus === "IGNORED").length,
      criticalUnclassifiedCount: moduleSummaries.filter((module) => module.criticalOpen).length,
      usesMemberIdCount: moduleSummaries.filter((module) => module.capabilities.usesMemberId).length,
      usesAccountIdCount: moduleSummaries.filter((module) => module.capabilities.usesAccountId).length,
      requiresMasterKeyCount: moduleSummaries.filter((module) => module.capabilities.requiresMasterKey).length,
      requires2FACount: moduleSummaries.filter((module) => module.capabilities.requires2FA).length,
      auditAlwaysCount: moduleSummaries.filter((module) => module.capabilities.auditAlways).length,
      dsgvoRelevantCount: moduleSummaries.filter((module) => module.dsgvoRelevant).length,
    },
    modules: moduleSummaries,
  };
}

function getCatalogModules(): ModuleLike[] {
  return Object.keys(systemDataClassificationCatalog).map((key) => ({
    key,
    kind: "system",
    name: key,
  }));
}

/**
 * Synchroner Bonni-Core-Überblick.
 * Wird u.a. von der Security-Overview beim Plattformstart verwendet und darf deshalb keine async Paket-Suche erzwingen.
 */
export function getSystemDataClassificationOverview(): DataClassificationOverview {
  return buildOverview(getCatalogModules());
}

/**
 * Vollständiger Überblick für die API: Bonni-Core-Katalog plus installierbare Manifest-Pakete aus app/add-on/plug-in.
 */
export async function getDataClassificationOverview(): Promise<DataClassificationOverview> {
  const manifests: ModuleManifestSummary[] = await listModuleManifests();
  const catalogModules = getCatalogModules();
  const catalogKeys = new Set(catalogModules.map((module) => module.key));
  const externalModules = manifests.filter((manifest) => !catalogKeys.has(manifest.key));

  return buildOverview([...catalogModules, ...externalModules]);
}
