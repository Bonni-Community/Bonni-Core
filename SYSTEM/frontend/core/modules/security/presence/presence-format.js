export function lastSeenLabel(value, now = Date.now()) {
  if (!value) return "Noch nicht gesehen";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Zeitpunkt unbekannt";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "Zuletzt gesehen gerade eben";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Zuletzt gesehen vor ${minutes} ${minutes === 1 ? "Minute" : "Minuten"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Zuletzt gesehen vor ${hours} ${hours === 1 ? "Stunde" : "Stunden"}`;
  const days = Math.floor(hours / 24);
  return `Zuletzt gesehen vor ${days} ${days === 1 ? "Tag" : "Tagen"}`;
}
