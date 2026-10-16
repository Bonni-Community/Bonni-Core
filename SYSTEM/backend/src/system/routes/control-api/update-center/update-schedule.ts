export type UpdateMode = "off" | "check" | "scheduled";
export type UpdateSettings = {
  mode: UpdateMode;
  scheduleTime: string;
  timeZone: "server";
  revision: number;
  automaticChecks: boolean;
  automaticDownload: boolean;
  backupBeforeInstall: true;
  maintenanceWindow: "manual" | "scheduled";
  channel: "stable";
};
export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  mode: "check", scheduleTime: "03:00", timeZone: "server", revision: 0,
  automaticChecks: true, automaticDownload: false,
  backupBeforeInstall: true, maintenanceWindow: "manual", channel: "stable",
};
function bad(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}
export function parseUpdateSettings(input: unknown, current: UpdateSettings = DEFAULT_UPDATE_SETTINGS): UpdateSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) bad("Ungültige Update-Einstellungen.");
  const value = input as Partial<UpdateSettings>;
  const mode = value.mode ?? (value.automaticChecks === false ? "off" : value.automaticChecks === true && current.mode === "off" ? "check" : current.mode);
  if (!["off", "check", "scheduled"].includes(mode)) bad("Ungültige Update-Betriebsart.");
  const scheduleTime = value.scheduleTime ?? current.scheduleTime;
  if (typeof scheduleTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) bad("Bitte eine gültige Uhrzeit angeben.");
  const timeZone = value.timeZone ?? current.timeZone;
  if (timeZone !== "server") bad("Die Installationszeit richtet sich nach der Serverzeit.");
  return {mode, scheduleTime, timeZone, revision: current.revision,
    automaticChecks: mode !== "off", automaticDownload: false,
    backupBeforeInstall: true, maintenanceWindow: mode === "scheduled" ? "scheduled" : "manual", channel: "stable"};
}
export function loadUpdateSettings(value: unknown): UpdateSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {...DEFAULT_UPDATE_SETTINGS};
  const stored = value as Partial<UpdateSettings>;
  // Old settings could only authorize checking/downloading, never installation.
  const mode = stored.mode ?? (stored.automaticChecks === false ? "off" : "check");
  try {
    const settings = parseUpdateSettings({...stored, mode});
    settings.revision = Number.isSafeInteger(stored.revision) && Number(stored.revision) >= 0 ? Number(stored.revision) : 0;
    return settings;
  } catch { return {...DEFAULT_UPDATE_SETTINGS, mode: "off", automaticChecks: false}; }
}
export function scheduledOccurrence(settings: UpdateSettings, now: Date, lastAttemptKey?: string | null): string | null {
  if (settings.mode !== "scheduled") return null;
  const parts = new Intl.DateTimeFormat("en-CA", {year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now);
  const get = (name: string) => parts.find(part => part.type === name)?.value || "";
  const currentMinute = Number(get("hour")) * 60 + Number(get("minute"));
  const [hour,minute] = settings.scheduleTime.split(":").map(Number);
  // A five-minute window tolerates a scheduler tick delay. Missed nights are
  // not caught up at an arbitrary time after a host restart.
  const delay = currentMinute - (hour * 60 + minute);
  if (delay < 0 || delay >= 5) return null;
  const key = `${get("year")}-${get("month")}-${get("day")}/${settings.timeZone}/${settings.scheduleTime}`;
  // Repeated DST hours get the same key, so there is only one attempt per day.
  return key === lastAttemptKey ? null : key;
}
export function automaticInstallAuthorized(settings: UpdateSettings, revision?: number): boolean {
  return revision === undefined || (settings.mode === "scheduled" && settings.revision === revision);
}
