import type { InstalledModuleSummary, MemberNavigationItem, ModuleManifestSummary } from "../types.js";

const sectionKey = /^[a-z][a-z0-9-]{0,47}$/;
export type MemberAreaStatus = {
  sections: string[];
  privacy: { version: string; text: string; acknowledged: boolean; translations?: { en: string } };
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Each app opts in and supplies the current privacy state for the account. */
export function readMemberAreaStatus(value: unknown): MemberAreaStatus | null {
  if (!record(value) || value.enabled !== true || !Array.isArray(value.sections)
    || value.sections.length > 20
    || !value.sections.every((section) => typeof section === "string" && sectionKey.test(section))
  ) return null;
  const notice = value.privacy;
  if (!record(notice) || typeof notice.version !== "string" || !notice.version.trim() || notice.version.length > 160
    || typeof notice.text !== "string" || !notice.text.trim() || notice.text.length > 100_000
    || typeof notice.acknowledged !== "boolean"
  ) return null;
  const en = record(notice.translations) ? notice.translations.en : undefined;
  const translations = typeof en === "string" && en.trim() && en.length <= 100_000 ? { en } : undefined;
  return { sections: value.sections, privacy: { version: notice.version, text: notice.text, acknowledged: notice.acknowledged, translations } };
}

export function validMemberNavigation(value: unknown): value is MemberNavigationItem[] {
  if (!Array.isArray(value) || value.length > 20) return false;
  const seen = new Set<string>();
  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const { section, label, profiles } = item;
    if (
      typeof section !== "string" || !sectionKey.test(section) || seen.has(section)
      || typeof label !== "string" || !label.trim() || label.length > 80
      || !Array.isArray(profiles) || !profiles.length || profiles.length > 20
      || !profiles.every((key: unknown) => typeof key === "string" && sectionKey.test(key))
    ) return false;
    seen.add(section);
    return true;
  });
}

export function resolveMemberNavigation(
  manifests: ModuleManifestSummary[],
  installed: InstalledModuleSummary[],
  access: Array<{ kind: string; moduleKey: string; moduleName: string; profiles: Array<{ key: string }> }>,
) {
  const declared = new Map(manifests.filter((manifest) => manifest.kind === "app")
    .map((manifest) => [manifest.key, manifest]));
  const enabled = new Map(installed.filter((module) => module.kind === "app" && module.installed && module.enabled)
    .map((module) => [module.key, module.version]));
  const projected = new Map<string, { key: string; app: string; appLabel: string; section: string; label: string }>();
  for (const assignment of access) {
    if (assignment.kind !== "app") continue;
    const manifest = declared.get(assignment.moduleKey);
    const items = manifest?.metadata?.memberNavigation;
    if (!manifest || enabled.get(manifest.key) !== manifest.version || !validMemberNavigation(items)) continue;
    const profiles = new Set(assignment.profiles.map(({ key }) => key));
    for (const item of items) {
      if (!item.profiles.some((profile) => profiles.has(profile))) continue;
      const key = `${manifest.key}:${item.section}`;
      projected.set(key, {
        key, app: manifest.key, appLabel: assignment.moduleName, section: item.section, label: item.label.trim(),
      });
    }
  }
  return [...projected.values()];
}

export async function enabledMemberNavigation(
  candidates: ReturnType<typeof resolveMemberNavigation>,
  getStatus: (app: string) => Promise<unknown>,
) {
  const apps = [...new Set(candidates.map((item) => item.app))];
  const availability = new Map(await Promise.all(apps.map(async (app) => {
    try {
      return [app, readMemberAreaStatus(await getStatus(app))] as const;
    } catch {
      // An unresponsive app should leave its part of the member area closed.
      return [app, null] as const;
    }
  })));
  return candidates.filter((item) => availability.get(item.app)?.sections.includes(item.section));
}
