import {
  createControlCenterLocalMember,
  fetchControlCenterUsers,
  updateControlCenterLocalMemberProfile,
} from "../../../system/api/controlCenterUsersApi.js";
import { executeErasureNow, readErasureCycle } from "../../../core/modules/security/identity/api/erasureApi.js";

const id = /^[a-z0-9][a-z0-9._:-]{0,159}$/iu;
const loginName = /^[a-z0-9][a-z0-9._-]{0,79}$/iu;
const creationFields = new Set(["loginName", "displayName", "firstName", "lastName", "nickname", "email", "phone", "birthDate", "joinedAt", "moduleAccess"]);

export function parseTerminalObject(input) {
  let result;
  try {
    result = JSON.parse(input);
  } catch {
    throw new Error('Gib die Angaben als JSON ein, zum Beispiel {"name":"Spezi"}.');
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Gib ein JSON-Objekt ein.");
  return result;
}

function validateRights(value) {
  if (!Array.isArray(value) || value.some(entry => (
    !["app", "add-on", "plug-in", "control-center"].includes(entry?.kind)
    || typeof entry.moduleKey !== "string" || !id.test(entry.moduleKey)
    || !Array.isArray(entry.permissions) || !entry.permissions.length
    || entry.permissions.some(permission => typeof permission !== "string" || !permission.trim())
  ))) {
    throw new Error('Verwende {"moduleAccess":[{"kind":"app","moduleKey":"app.stueberlapp","permissions":["manager"]}]}.');
  }
  return value;
}

export function parseAdministrationCommand(action, rest) {
  if (["list", "liste"].includes(action)) return { kind: "user-list", query: rest };
  if (["deletions", "löschliste", "loeschliste"].includes(action) && !rest) return { kind: "user-deletions" };
  if (["create", "anlegen", "erstellen"].includes(action)) {
    const [, login, name] = /^(\S+)(?:\s+(.+))?$/u.exec(rest) || [];
    const body = rest.startsWith("{") ? parseTerminalObject(rest) : { loginName: login, displayName: name };
    if (Object.keys(body).some(key => !creationFields.has(key))) {
      throw new Error("Das Passwort gibst du im verdeckten Eingabefeld ein. Erlaubte Felder sind " + [...creationFields].join(", ") + ".");
    }
    if (typeof body.loginName !== "string" || !loginName.test(body.loginName)) {
      throw new Error('Verwende useradd -c "Anzeigename" <Loginname>.');
    }
    if (Object.hasOwn(body, "moduleAccess")) validateRights(body.moduleAccess);
    return { kind: "user-create", body };
  }
  const [, target, argument = ""] = /^(\S+)(?:\s+(.+))?$/u.exec(rest) || [];
  if (["purge", "endgueltig-loeschen"].includes(action)) {
    if (!/^era_[a-f0-9]{64}$/u.test(target || "") || !["--endgueltig", "--endgültig"].includes(argument)) {
      throw new Error("Verwende user purge <Antrags-ID> --endgueltig. Die Antrags-ID steht in user deletions.");
    }
    return { kind: "user-purge", requestId: target };
  }
  if (!target || !id.test(target)) throw new Error("Gib einen Loginnamen oder eine Konto-ID ein.");
  if (["rights", "rechte"].includes(action)) {
    if (!argument) return { kind: "user-rights", target };
    const body = parseTerminalObject(argument);
    if (Object.keys(body).length !== 1) throw new Error("Übergib die vollständige Liste der Zugriffe als moduleAccess.");
    return { kind: "user-rights", target, body: { moduleAccess: validateRights(body.moduleAccess) } };
  }
  if (!argument && ["activate", "aktivieren", "deactivate", "deaktivieren"].includes(action)) {
    return { kind: "user-status", target, active: ["activate", "aktivieren"].includes(action) };
  }
  if (!argument && ["delete", "loeschen", "löschen"].includes(action)) return { kind: "user-delete", target };
  throw new Error("Unbekannter Benutzerbefehl. Mit help siehst du die verfügbaren Befehle.");
}

async function readAccounts(token, signal) {
  const result = await fetchControlCenterUsers(token, { signal });
  if (result?.ok !== true) throw new Error("Die Benutzerverwaltung ist gerade nicht verfügbar.");
  const accounts = (result.users || result.members || []).flatMap(row => (
    Array.isArray(row.accounts) ? row.accounts : row.accountId ? [row] : []
  ));
  return [...new Map(accounts.map(account => [account.accountId || account.id, account])).values()];
}

function accountLine(account) {
  return `${account.loginName} · ${account.displayName || account.type} · ${account.isActive ? "Aktiv" : "Deaktiviert"} · ${account.accountId || account.id}`;
}

export async function executeAdministrationCommand(command, { token, signal, actorAccountId, requestPassword }) {
  if (command.kind === "user-create") {
    let password = await requestPassword(command.body.loginName, signal);
    try {
      signal.throwIfAborted();
      const result = await createControlCenterLocalMember(token, { ...command.body, password }, { signal });
      if (result?.created !== true || !result.account?.id) throw new Error("Der Core hat den Benutzerzugang nicht bestätigt.");
      return `Benutzer ${result.account.loginName} angelegt · ${result.account.id}`;
    } finally {
      password = "";
    }
  }
  if (command.kind === "user-deletions") {
    const result = await readErasureCycle(token, signal);
    if (!Array.isArray(result?.cases)) throw new Error("Die Löschliste konnte nicht geladen werden.");
    return result.cases.slice(0, 30).map(row => `${row.id} · ${row.label} · ${row.state}`).join("\n")
      || "Die Löschliste ist leer.";
  }
  if (command.kind === "user-purge") {
    const result = await executeErasureNow(token, command.requestId, signal);
    if (result?.state !== "COMPLETED" || result.requestId !== command.requestId) {
      const blockers = Array.isArray(result?.blockers) ? result.blockers.join("\n") : "";
      throw new Error(`Löschung noch offen · ${result?.state || "Status unbekannt"}${blockers ? `\n${blockers}` : ""}`);
    }
    return [
      result.alreadyCompleted ? "Dieser Löschantrag ist bereits abgeschlossen." : "Endgültige Löschung abgeschlossen und geprüft.",
      result.backupId && `Sicherung vor der Löschung · ${result.backupId}`,
      result.followUpBackupPending && "Die Sicherung nach der Löschung steht noch aus.",
    ].filter(Boolean).join("\n");
  }
  if (command.kind === "user-delete" && command.target.toLowerCase() === "me") {
    return { message: "Löschantrag für dein Konto geöffnet.", panel: { kind: "erasure" } };
  }

  const accounts = await readAccounts(token, signal);
  if (command.kind === "user-list") {
    const query = command.query.toLowerCase();
    return accounts.filter(account => command.exactLogin
      ? account.loginName?.toLowerCase() === query
      : accountLine(account).toLowerCase().includes(query))
      .slice(0, 60).map(accountLine).join("\n") || "Keine passenden Benutzer gefunden.";
  }
  const target = command.target?.toLowerCase();
  const matches = accounts.filter(account => (account.accountId || account.id) === (command.target ?? actorAccountId)
    || (target && account.loginName?.toLowerCase() === target));
  if (matches.length !== 1) throw new Error("Benutzer nicht eindeutig gefunden. Suche mit getent passwd.");
  const account = matches[0];
  const accountId = account.accountId || account.id;
  if (command.kind === "user-delete") {
    if (!["MEMBER", "ADMIN"].includes(account.type)) throw new Error("Löschanträge sind für persönliche Konten vorgesehen.");
    return {
      message: `Löschantrag für ${account.loginName} geöffnet.`,
      panel: {
        kind: "erasure",
        targetAccountId: accountId === actorAccountId ? undefined : accountId,
        targetLabel: account.loginName,
      },
    };
  }
  if (command.kind === "user-rights" && !command.body) {
    return `${accountLine(account)}\n${JSON.stringify({ moduleAccess: account.moduleAccess || [] })}`;
  }
  const changes = command.body || { isActive: command.active };
  const result = await updateControlCenterLocalMemberProfile(token, accountId, changes, { signal });
  if (result?.updated !== true) throw new Error("Der Core hat die Änderung nicht bestätigt.");
  if (command.kind === "user-status") {
    if (result.account?.isActive !== command.active) throw new Error("Der gewünschte Kontostatus wurde nicht bestätigt.");
    return `${account.loginName} wurde ${command.active ? "aktiviert" : "deaktiviert"}.`;
  }
  if (result.moduleAccessChanged !== true) throw new Error("Der Core hat die neue Berechtigungsliste nicht übernommen.");
  return `Berechtigungen für ${account.loginName} gespeichert.`;
}
