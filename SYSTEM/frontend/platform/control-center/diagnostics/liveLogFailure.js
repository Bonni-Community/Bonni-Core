import { catalog, diagnosticHint } from "../../../system/diagnostics/journalModel.js";

const missingSchema = {
  cause: "Für die Datenbankabfrage fehlt eine benötigte Tabelle oder Spalte.",
  check: "Im Setup-Protokoll nach einer ausstehenden Datenbankmigration suchen.",
};
const schemaMigration = {
  cause: "Das vorhandene Datenbankschema benötigt eine Migration für die App-Version.",
  check: missingSchema.check,
};

const knownFailures = new Map([
  ["APP_DATABASE_SCHEMA_INCOMPLETE", missingSchema],
  ["P2021", missingSchema],
  ["P2022", missingSchema],
  ["APP_DATABASE_MIGRATION_REQUIRED", schemaMigration],
  ["APP_SCHEMA_CONSTRAINT_MIGRATION_REQUIRED", schemaMigration],
  ["STUEBERL_SCHEMA_CONSTRAINT_MIGRATION_REQUIRED", schemaMigration],
  ["CORE_MEDIA_NOT_FOUND", { cause: "Das angeforderte Medium wurde in der Ablage nicht gefunden.", check: "Ablage und vorhandene Sicherung prüfen." }],
  ["AUTH_RATE_LIMITED", { cause: "Das Limit für Anmeldeversuche wurde erreicht." }],
]);

const httpFailures = new Map([
  [400, "Die Anfrage wurde als ungültig abgewiesen."],
  [401, "Für die Anfrage ist eine gültige Anmeldung erforderlich."],
  [403, "Der Server hat den Zugriff verweigert."],
  [404, "Der Server hat die angeforderte Ressource als nicht gefunden gemeldet."],
  [413, "Die Anfrage wurde wegen ihrer Größe abgewiesen."],
  [429, "Der Server hat weitere Anfragen vorübergehend begrenzt."],
]);
const recordedStackFrame = /^\s*at ([^/\\():\s]+:\d+:\d+)\s*$/u;

function logMessage(entry) {
  const code = entry.metadata?.errorCode || entry.metadata?.code;
  if (typeof code === "string" && (!entry.message || entry.message === "[Ausgabe ausgelassen]")) return code;
  return entry.message;
}

function durationLabel(value) {
  return Number.isFinite(value) ? `${value} ms` : undefined;
}

function summaryDuration(entry) {
  return entry.message === "HTTP request" ? durationLabel(entry.metadata?.durationMs) : undefined;
}

export function liveLogSummary(entry) {
  if (!entry.timestamp) return entry.line;
  const { method, path, statusCode } = entry.metadata ?? {};
  const route = [method, typeof path === "string" && !path.startsWith("[") ? path : undefined].filter(Boolean).join(" ");
  return [
    [entry.level, logMessage(entry)].filter(Boolean).join(" "),
    route,
    Number.isInteger(statusCode) ? `HTTP ${statusCode}` : undefined,
    summaryDuration(entry),
  ].filter(Boolean).join(" · ") || "Protokolleintrag";
}

function recordedLocations(errors) {
  const locations = new Set();
  for (const { stack } of [...errors].reverse()) {
    if (typeof stack !== "string") continue;
    for (const line of stack.split("\n")) {
      const location = recordedStackFrame.exec(line)?.[1];
      if (location) locations.add(location);
    }
  }
  return [...locations];
}

export function liveLogDetails(entry, entries, applicationName) {
  const logged = entry.metadata ?? {};
  const request = entry.tone === "error" && typeof logged.requestId === "string" && logged.requestId
    ? entries.findLast(item => item.message === "HTTP request" && item.metadata?.requestId === logged.requestId)?.metadata
    : undefined;
  const statusCode = logged.statusCode ?? request?.statusCode;
  const failedRequest = Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599;

  const errors = [logged];
  for (let detail = logged.error; detail && typeof detail === "object"; detail = detail.cause) {
    errors.push(detail);
  }
  const [fileLocation, ...callerLocations] = recordedLocations(errors);
  const codes = errors.flatMap(detail => [detail.errorCode, detail.code]);
  const message = logMessage(entry);
  const messageCodes = message?.match(/\b[A-Z][A-Z0-9_]{2,}\b/gu) ?? [];
  codes.push(...messageCodes);
  const knownCode = codes.find(code => knownFailures.has(code));
  const known = knownFailures.get(knownCode);
  const fields = [["Datei", fileLocation]];
  if (entry.tone === "error" || failedRequest || known) {
    const code = knownCode ?? codes.find(value => typeof value === "string" && value !== "CORE_ERROR");
    const firstSchemaIssue = errors.find(detail => Array.isArray(detail.schemaIssues) && detail.schemaIssues.length)?.schemaIssues[0];
    const column = [...errors.flatMap(detail => [detail.meta?.column, detail.column]), firstSchemaIssue?.column].find(value => (
      typeof value === "string" && value && value !== "[Bezeichner ausgelassen]"
    ));
    const stage = catalog.stages[logged.phase]?.[0] ?? catalog.workflows[logged.workflow];
    const statusHint = httpFailures.get(statusCode);
    fields.push(
      [known || !statusHint ? "Ursache" : "Hinweis", known?.cause ?? statusHint ?? "Die konkrete Ursache ist in diesem Eintrag offen."],
      ["Vorgang", stage !== message ? stage : undefined],
      ["Datenbankspalte", column],
      ["Schema-Element", firstSchemaIssue?.name],
      ["Ursachencode", !messageCodes.includes(code) ? code : undefined],
    );
    const check = known?.check ?? (statusCode === 413 ? undefined : diagnosticHint({ selected: { code, statusCode } }));
    fields.push(["Prüfschritt", check]);
  }

  const application = applicationName || entry.moduleId;
  fields.push(
    ["HTTP-Status", Number.isInteger(logged.statusCode) ? undefined : statusCode],
    ["Dauer", summaryDuration(entry) ? undefined : durationLabel(logged.durationMs ?? request?.durationMs)],
    ["Fehler-ID", logged.errorId],
    ["Weitere Aufrufe", callerLocations.join("\n")],
    ["Zeitpunkt (UTC)", entry.timestamp],
    [application ? "Anwendung" : "Quelle", application || logged.moduleId || logged.module],
  );
  return fields.filter(([, value]) => typeof value === "string" ? value.trim() : Number.isFinite(value));
}
