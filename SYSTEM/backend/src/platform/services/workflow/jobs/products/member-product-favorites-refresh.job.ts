/**
 * feature-modules ist ein reiner Datenträger.
 * Dieser System-Job darf daher nicht direkt die StüberlApp-Favorites-Services aus
 * feature-modules importieren. Die echte Aktualisierung wird vom installierten
 * System-Runtime-Modul übernommen, sobald der Installer diese Runtime vorbereitet hat.
 */
export async function runMemberProductFavoritesRefreshJob() {
  return { skipped: true, reason: "STUEBERLAPP_RUNTIME_NOT_PREPARED" };
}
