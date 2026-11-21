import { apiRequest } from "../../../system/api/apiClient.js";
import { moduleActions, runModuleAction } from "../../../system/api/moduleControlApi.js";
import { fetchShell } from "../../../system/api/sessionApi.js";
import { fetchCoreDiagnosticError, fetchCoreDiagnosticsLogs, writeCoreDiagnosticTest } from "../../../system/api/systemDiagnosticsApi.js";
import { groupedDiagnostics, diagnosticHint, stageLabel } from "../../../system/diagnostics/journalModel.js";
import { fetchModulePackages, isFeatureModuleInstalled, modulePackageDisplayName, modulePackageId } from "../../../system/feature-modules/featureModuleApi.js";
import { liveLogDetails, liveLogSummary } from "../diagnostics/liveLogFailure.js";
import { executeAdministrationCommand, parseAdministrationCommand } from "./terminalAdministration.js";
import { executeTerminalFileCommand } from "./terminalFiles.js";
import { formatTerminalHelp, terminalHelpNotesPath } from "./terminalHelp.js";
import { isLinuxCommand, moduleKey, parseLinuxLine } from "./terminalLinuxCommands.js";
import { executeTerminalTextPipeline } from "./terminalTextPipeline.js";
import { parseLiveLogLine, terminalLogTone } from "./terminalLogTone.js";
import { executeProductCommand, parseProductCommand } from "./terminalProducts.js";

const archiveName = /^[a-z0-9][a-z0-9.+_-]{0,195}\.zip$/iu;
const errorIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const appAction = new Map([
  ["list", "list"], ["liste", "list"],
  ["install", "install"], ["installieren", "install"],
  ["activate", "enable"], ["aktivieren", "enable"],
  ["deactivate", "disable"], ["deaktivieren", "disable"],
  ["uninstall", "uninstall"], ["deinstallieren", "uninstall"],
]);

function parseAppCommand(action, args) {
  const operation = appAction.get(action);
  if (operation === "list") return { kind: "list", query: args.join(" ") };
  const [target, flag, ...extra] = args;
  const key = target?.toLowerCase();
  if (operation === "install" && archiveName.test(target || "") && extra.length === 0 && (!flag || flag === "--dev")) {
    return { kind: "archive", filename: target, acceptDevRisk: flag === "--dev" };
  }
  if (operation && key && moduleKey.test(key) && !extra.length) {
    if (operation === "uninstall") {
      if (!["--confirm", "--bestätigen", "--bestaetigen"].includes(flag)) {
        throw new Error(`Bestätige die Deinstallation mit app uninstall ${key} --confirm.`);
      }
      return { kind: operation, key };
    }
    if (!flag) return { kind: operation, key };
  }
  throw new Error("Unbekannter oder unvollständiger Paketbefehl. Mit help siehst du die verfügbaren Befehle.");
}

function parseCommand(text) {
  const scoped = /^(?:bonni\s+)?(user|benutzer|product|produkt)\s+(\S+)(?:\s+(.+))?$/iu.exec(text);
  if (scoped) {
    const group = scoped[1].toLowerCase(), action = scoped[2].toLowerCase(), rest = scoped[3] || "";
    return ["product", "produkt"].includes(group) ? parseProductCommand(action, rest) : parseAdministrationCommand(action, rest);
  }
  const words = text.split(/\s+/u);
  if (words[0].toLowerCase() === "bonni") words.shift();
  const [group, action, ...args] = words;
  const verb = group?.toLowerCase();
  const subcommand = action?.toLowerCase();
  if (verb === "help" || verb === "hilfe") return { kind: "help", topic: words.slice(1).join(" ").toLowerCase() };
  if (["ping", "clear"].includes(verb) && !action) return { kind: verb };
  if (["diagnose", "diagnostics"].includes(verb)) {
    if (["errors", "fehler"].includes(subcommand) && args.length <= 1) {
      const key = args[0]?.toLowerCase();
      if (key && !moduleKey.test(key)) throw new Error("Gib eine Paket-ID wie app.stueberlapp ein.");
      return { kind: "errors", key };
    }
    if (subcommand === "show") {
      if (args.length !== 1 || !errorIdPattern.test(args[0])) {
        throw new Error("Verwende diagnose show <Fehler-ID> mit der vollständigen ID aus dem Live-Terminal.");
      }
      return { kind: "diagnose-show", errorId: args[0].toLowerCase() };
    }
    if (subcommand === "test" && args.length === 0) return { kind: "test" };
  }
  if (verb === "app") return parseAppCommand(subcommand, args);
  throw new Error("Unbekannter oder unvollständiger Befehl. Mit help siehst du die verfügbaren Befehle.");
}

export function parseTerminalBatch(input) {
  if (input.length > 4_000) throw new Error("Ein Befehlsblock darf höchstens 4.000 Zeichen enthalten.");
  const commands = [];
  for (const [index, line] of input.split(/\r?\n/u).entries()) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    try {
      const parsed = isLinuxCommand(text) ? parseLinuxLine(text, parseAppCommand) : [{ ...parseCommand(text), text }];
      if (commands.length + parsed.length > 20) throw new Error("Ein Befehlsblock darf bis zu 20 Befehle enthalten.");
      commands.push(...parsed.map(command => ({ ...command, line: index + 1 })));
    } catch (error) {
      throw new Error(`Zeile ${index + 1} · ${error.message}`);
    }
  }
  const interactive = commands.findIndex(command => ["user-delete", "product-import"].includes(command.kind));
  if (interactive >= 0 && interactive !== commands.length - 1) {
    throw new Error("Löschantrag und Dateiimport öffnen einen Dialog und müssen am Ende eines Befehlsblocks stehen.");
  }
  return commands;
}

async function pingBackend(signal) {
  const startedAt = performance.now();
  let result;
  try {
    result = await apiRequest("/api/health/ready", {
      auth: false,
      cache: "no-store",
      allowFailover: false,
      signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (error.name === "TimeoutError") throw new Error("Keine Antwort vom Backend innerhalb von 8 Sekunden.");
    if (error.data?.runtime && error.data.state === "unready") {
      throw new Error(`Backend erreichbar · ${Math.round(performance.now() - startedAt)} ms\nDatenbank oder Core noch nicht betriebsbereit.`);
    }
    throw new Error(error.status ? `Backend-Prüfung fehlgeschlagen · HTTP ${error.status}.` : "Backend ist vom Browser aus nicht erreichbar.");
  }
  const runtime = result?.runtime;
  if (!runtime || !["ready", "degraded"].includes(result.state)) {
    throw new Error("Die Antwort enthielt keinen gültigen Bonni-Core-Status.");
  }
  const summary = `Backend erreichbar · ${Math.round(performance.now() - startedAt)} ms · Core ${runtime.version || "unbekannt"}`;
  if (result.state === "degraded" || runtime.slotRole === "emergency" || result.notlauf?.active) {
    throw new Error(`${summary}\nBonni läuft im Notlauf.`);
  }
  return `${summary}\nDatenbank betriebsbereit.`;
}

async function readErrors(token, key, signal) {
  const result = await fetchCoreDiagnosticsLogs(token, 500, { signal, category: key ? "applications" : "all", moduleId: key });
  if (!result?.journal?.available) throw new Error("Das Diagnosejournal ist gerade nicht vollständig verfügbar.");
  const errors = groupedDiagnostics(result.journal.entries, { onlyErrors: true }).slice(0, 5);
  if (!errors.length) return "In den jüngsten gelesenen Diagnosemeldungen sind 0 Fehler erfasst.";
  const message = errors.map(group => {
    const entry = group.selected;
    const details = [entry.code, entry.statusCode && `HTTP ${entry.statusCode}`].filter(Boolean).join(" · ");
    const time = new Date(entry.timestamp).toLocaleString("de-DE");
    return [
      `${time} · ${entry.moduleId} · ${stageLabel(entry)}${details ? ` (${details})` : ""}`,
      diagnosticHint(group),
    ].filter(Boolean).join("\n");
  }).join("\n\n");
  return { message, tone: "error" };
}

async function showDiagnosticError(token, errorId, signal) {
  const result = await fetchCoreDiagnosticError(token, errorId, { signal });
  const entry = typeof result?.line === "string" ? parseLiveLogLine(result.line) : null;
  if (entry?.metadata?.errorId !== errorId || entry.tone !== "error") {
    throw new Error("Der Core hat den Eintrag zu dieser Fehler-ID nicht bestätigt.");
  }
  const context = typeof result.responseLine === "string" ? [parseLiveLogLine(result.responseLine)] : [];
  const details = liveLogDetails(entry, context)
    .filter(([label]) => label !== "Fehler-ID")
    .flatMap(([label, value]) => `${label} · ${value}`.split("\n").map(text => ({ text, tone: "text" })));
  return { rows: [{ text: liveLogSummary(entry), tone: "error" }, ...details] };
}

async function readJournal(token, { unit, count, priority, reverse }, signal) {
  const category = unit === "bonni-core" ? "system" : unit ? "applications" : "all";
  const moduleId = category === "applications" ? unit : undefined;
  const result = await fetchCoreDiagnosticsLogs(token, 2000, { signal, category, moduleId });
  if (!result?.journal?.available || !Array.isArray(result.journal.entries)) {
    throw new Error("Das Diagnosejournal ist gerade nicht vollständig verfügbar.");
  }
  const levels = { critical: 2, error: 3, warn: 4, info: 6 };
  const entries = result.journal.entries.filter(entry => levels[entry.level] <= priority).slice(-count);
  if (reverse) entries.reverse();
  const rows = entries.flatMap(entry => {
    const time = new Date(entry.timestamp).toLocaleString("de-DE");
    const details = [entry.code, entry.statusCode && `HTTP ${entry.statusCode}`].filter(Boolean).join(" · ");
    const message = `${time} ${entry.moduleId} [${entry.level.toUpperCase()}] ${stageLabel(entry)}${details ? ` · ${details}` : ""}`;
    const tone = terminalLogTone(entry.level, entry);
    return message.split("\n").map(text => ({ text, tone }));
  });
  return rows.length ? { rows } : "Keine passenden Einträge im Diagnosejournal.";
}

function packageStatus(item) {
  return item.enabled ? "Aktiv" : isFeatureModuleInstalled(item) ? "Installiert" : "Verfügbar";
}

async function listPackages(token, { query, installedOnly }, signal) {
  const packages = await fetchModulePackages(token, { signal });
  const term = query.toLowerCase();
  const matches = packages.filter(item => (!installedOnly || isFeatureModuleInstalled(item)) && (
    `${modulePackageId(item)} ${modulePackageDisplayName(item)}`.toLowerCase().includes(term)
  ));
  if (!matches.length) return "Keine passenden Pakete im Core gefunden.";
  const rows = matches.slice(0, 60).map(item => (
    `${modulePackageId(item)}  ·  ${modulePackageDisplayName(item)}  ·  ${packageStatus(item)}`
  ));
  if (matches.length > rows.length) rows.push(`Weitere ${matches.length - rows.length} Pakete. Schränke die Suche mit einem Namen ein.`);
  return rows.join("\n");
}

async function changePackage(token, key, action, signal) {
  const result = await runModuleAction(token, key, moduleActions[action], {}, { signal });
  if (result?.key !== key || result.ok === false) {
    const details = result?.compatibility?.reasons || result?.validation?.errors;
    const message = result?.message || ({
      MODULE_MANIFEST_NOT_FOUND: "Das Paket wurde im Core nicht gefunden. Suche die Paket-ID mit apt list oder gib den ZIP-Dateinamen aus UPDATE an.",
      MODULE_NOT_INSTALLED: "Das Paket ist nicht installiert.",
      MODULE_NOT_INSTALLABLE: "Der Core führt dieses Paket als nicht installierbar.",
    })[result?.error] || result?.error || "Der Core hat den Vorgang nicht bestätigt.";
    throw new Error([message, ...(Array.isArray(details) ? details : [])].join("\n"));
  }
  return result;
}

async function installArchive(token, { filename, acceptDevRisk }, signal) {
  const packages = await apiRequest("/api/update/apps/packages", {
    token, signal, cache: "no-store", allowFailover: false,
  });
  const item = packages?.local?.find(entry => entry.filename === filename);
  if (!item) throw new Error(`ZIP ${filename} wurde im UPDATE-Ordner nicht gefunden.`);
  if (item.error) throw new Error(`Das ZIP kann nicht installiert werden · ${item.error}.`);
  if (item.channel === "dev" && !acceptDevRisk) {
    throw new Error(`DEV-Paket. Ergänze --dev, um die Entwicklungsversion ${item.version} zu installieren.`);
  }
  const result = await apiRequest("/api/update/apps/install", {
    token, signal, method: "POST", allowFailover: false,
    body: { source: "offline", filename, appId: item.appId, version: item.version, sha256: item.sha256, acceptDevRisk },
  });
  if (!result?.ok) throw new Error(result?.message || "Der Core hat die Installation nicht bestätigt.");
  if (result.alreadyInstalled) {
    const key = `app.${item.directory}`;
    const modules = await fetchModulePackages(token, { signal });
    if (modules.some(module => modulePackageId(module) === key && module.installed)) {
      return `${key} ${item.version} ist bereits installiert.`;
    }
    if (!moduleKey.test(key)) throw new Error("Der Core hat keine gültige Paket-ID für dieses ZIP geliefert.");
    await changePackage(token, key, "install", signal);
    try {
      await changePackage(token, key, "enable", signal);
    } catch (error) {
      throw new Error(`${key} wurde installiert. Aktivierung fehlgeschlagen.\n${error.message}`);
    }
  }
  return `${item.appId} ${item.version} wurde installiert und aktiviert.`;
}

async function executeCommand(command, context) {
  const { token, signal } = context;
  const { kind, key } = command;
  if (kind.startsWith("user-")) return executeAdministrationCommand(command, context);
  if (kind.startsWith("product-")) return executeProductCommand(command, context);
  if (["ls", "cd", "pwd", "mkdir", "rmdir", "touch", "cat", "rm", "cp", "nano", "backup-create"].includes(kind)) {
    return executeTerminalFileCommand(command, context);
  }
  if (kind === "help") {
    if (command.topic === "notizen") {
      const notes = await executeTerminalFileCommand({ kind: "cat", path: terminalHelpNotesPath, allowMissing: true }, context);
      return notes.trim() ? notes : `Deine Befehlsnotizen sind leer. Öffne sie mit nano ${terminalHelpNotesPath}.`;
    }
    return formatTerminalHelp(command.topic);
  }
  if (kind === "whoami") {
    const { identity } = await fetchShell(token, { signal });
    if (typeof identity?.loginName !== "string" || !identity.loginName) throw new Error("Der Core hat den aktuellen Login nicht bestätigt.");
    return identity.loginName;
  }
  if (kind === "echo") return `${command.value}\n`;
  if (kind === "ping") {
    const health = await pingBackend(signal);
    return command.service ? `${command.service}.service\n${health}` : health;
  }
  if (kind === "errors") return readErrors(token, key, signal);
  if (kind === "diagnose-show") return showDiagnosticError(token, command.errorId, signal);
  if (kind === "journal") return readJournal(token, command, signal);
  if (kind === "test") {
    const result = await writeCoreDiagnosticTest(token, { signal });
    if (!result?.ok) throw new Error("Das Diagnosejournal hat den Testeintrag nicht bestätigt.");
    return `Testfehler gespeichert. Du findest ihn unter ? → System → Fehler.\nVorgang ${result.operationId}`;
  }
  if (kind === "list") return listPackages(token, command, signal);
  if (kind === "archive") return installArchive(token, command, signal);
  if (kind === "module-status") {
    const item = (await fetchModulePackages(token, { signal })).find(entry => modulePackageId(entry) === key);
    if (!item) throw new Error("Das Paket wurde im Core nicht gefunden. Suche die Paket-ID mit apt list.");
    return `${key} · ${modulePackageDisplayName(item)}\nStatus · ${packageStatus(item)}`;
  }
  if (command.needsConfirmation) {
    await context.confirmRemoval(key, signal);
    signal.throwIfAborted();
  }

  const item = await changePackage(token, key, kind, signal);
  if (kind === "uninstall") return `${key} wurde deinstalliert. Die gespeicherten App-Daten bleiben erhalten.`;
  if (kind === "enable") return `${key} ist aktiv.`;
  if (kind === "disable") return `${key} ist deaktiviert.`;
  return `${key} ${item.version || ""} wurde installiert.${item.enabled ? " Das Paket ist aktiv." : ` Aktivieren mit systemctl start ${key}.`}`;
}

export async function executeTerminalCommand(command, context) {
  const result = await executeCommand(command, context);
  return command.pipes ? executeTerminalTextPipeline(command, result, context) : result;
}
