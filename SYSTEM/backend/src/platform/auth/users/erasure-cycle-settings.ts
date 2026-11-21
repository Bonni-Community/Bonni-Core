export type ErasureCycleSettings = {
  schema: "bonni.erasure-cycle/v1"; enabled: boolean; intervalDays: number;
  nextRunAt: string; backupRetentionDays: number; timeZone: "Europe/Berlin";
};
function parts(date: Date) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).map(p => [p.type, p.value]));
}
export function berlinThreeOnDay(date: Date, addDays: number) {
  const p = parts(date), day = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + addDays, 3));
  let target = day.getTime();
  for (let i = 0; i < 3; i++) {
    const local = parts(new Date(target));
    const observed = Date.UTC(+local.year, +local.month - 1, +local.day, +local.hour, +local.minute);
    target += day.getTime() - observed;
  }
  return new Date(target).toISOString();
}
export function defaultErasureCycleSettings(now = new Date()): ErasureCycleSettings {
  const p = parts(now), weekday = new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay();
  let days = (7 - weekday) % 7;
  if (Date.parse(berlinThreeOnDay(now, days)) <= now.getTime()) days += 7;
  return { schema: "bonni.erasure-cycle/v1", enabled: true, intervalDays: 7, nextRunAt: berlinThreeOnDay(now, days),
    backupRetentionDays: 30, timeZone: "Europe/Berlin" };
}
export function validateErasureCycleSettings(value: unknown): ErasureCycleSettings {
  const v = value as ErasureCycleSettings | null;
  if (!v || v.schema !== "bonni.erasure-cycle/v1" || typeof v.enabled !== "boolean" || v.timeZone !== "Europe/Berlin"
    || !Number.isInteger(v.intervalDays) || v.intervalDays < 1 || v.intervalDays > 365
    || !Number.isInteger(v.backupRetentionDays) || v.backupRetentionDays < 1 || v.backupRetentionDays > 3650
    || typeof v.nextRunAt !== "string" || !Number.isFinite(Date.parse(v.nextRunAt)))
    throw Object.assign(new Error("Die Einstellungen des Löschzyklus sind ungültig."), { code: "ERASURE_SETTINGS_INVALID", statusCode: 422 });
  return { schema: v.schema, enabled: v.enabled, intervalDays: v.intervalDays, nextRunAt: new Date(v.nextRunAt).toISOString(),
    backupRetentionDays: v.backupRetentionDays, timeZone: v.timeZone };
}
