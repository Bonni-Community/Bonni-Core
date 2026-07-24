/**
 * Bonni Core Base contains no stewardship add-on job implementation.
 * The real OIDC member sync job is provided by the installed stewardship add-on.
 */
export async function runOidcMemberSyncJob() {
  return { ok: false, skipped: true, reason: "STEWARDSHIP_ADDON_NOT_INSTALLED" };
}
