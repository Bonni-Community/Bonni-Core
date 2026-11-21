import { parseAdministrationCommand } from "./terminalAdministration.js";

export const moduleKey = /^(?:app|addon|plugin|bridge)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const fileCommands = ["ls", "cd", "pwd", "mkdir", "rmdir", "touch", "cat", "rm", "cp", "nano"];
const linuxCommand = /^(?:apt|systemctl|journalctl|useradd|usermod|userdel|id|getent|whoami|sudo|ping|ls|cd|pwd|mkdir|rmdir|touch|cat|rm|cp|nano|echo|sort|cut|clear|help)(?:\s|&|\||$)/u;
const backupCommand = /^(?:bonni\s+)?backup(?:\s|&|$)/iu;
const levelNames = { crit: 2, critical: 2, err: 3, error: 3, warning: 4, warn: 4, notice: 5, info: 6, debug: 7 };

export function isLinuxCommand(text) {
  return linuxCommand.test(text) || backupCommand.test(text);
}

function decodeWord(word) {
  return word.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/gu, (_part, single, double, escaped) => (
    single ?? (double === undefined ? escaped : double.replace(/\\(["\\$\x60])/gu, "$1"))
  ));
}

function tokenize(text) {
  const token = /&&|\||(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s'"\\&|;<>$\x60()])+/uy;
  const expressions = [];
  let parts = [[]];
  let start = 0;
  let end = 0;
  for (let offset = 0; offset < text.length;) {
    if (/\s/u.test(text[offset])) {
      offset++;
      continue;
    }
    if (text[offset] === "#") break;
    token.lastIndex = offset;
    const word = token.exec(text)?.[0];
    if (!word) throw new Error("Ungültiges Anführungszeichen oder nicht unterstützter Shell-Operator.");
    if (word === "&&") {
      expressions.push({ parts, text: text.slice(start, end).trim() });
      parts = [[]];
      start = token.lastIndex;
    } else if (word === "|") {
      parts.push([]);
    } else {
      parts.at(-1).push(decodeWord(word));
    }
    end = token.lastIndex;
    offset = end;
  }
  expressions.push({ parts, text: text.slice(start, end).trim() });
  if (expressions.some(expression => expression.parts.some(words => !words.length))) {
    throw new Error("Nach && und | muss ein vollständiger Befehl stehen.");
  }
  return expressions;
}

function readOptions(words, definitions = {}) {
  const args = [];
  const options = new Map();
  let positionalOnly = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (!positionalOnly && word === "--") {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !word.startsWith("-") || word === "-") {
      args.push(word);
      continue;
    }
    const equals = word.indexOf("=");
    const flag = equals < 0 ? word : word.slice(0, equals);
    const spec = Object.hasOwn(definitions, flag) && definitions[flag];
    if (!spec || options.has(spec[0])) throw new Error("Unbekannte oder doppelte Option. Mit help siehst du die verfügbaren Optionen.");
    const [name, takesValue] = spec;
    const value = equals >= 0 ? word.slice(equals + 1) : takesValue ? words[++index] : true;
    if (value === undefined || (!takesValue && value !== true)) throw new Error("Die Option erwartet ein anderes Argument.");
    options.set(name, value);
  }
  return { args, options };
}

function aptCommand(words, parseAppCommand) {
  const { args: [action, target, ...extra], options } = readOptions(words, {
    "--installed": ["installed"], "-y": ["yes"], "--assume-yes": ["yes"], "--dev": ["dev"],
  });
  if (action === "list" && !extra.length && !options.has("dev") && !options.has("yes")) {
    return { kind: "list", query: target || "", installedOnly: options.has("installed") };
  }
  if (action === "install" && target && !extra.length && !options.has("installed")) {
    return parseAppCommand("install", [target.replace(/^\.\//u, ""), ...(options.has("dev") ? ["--dev"] : [])]);
  }
  if (action === "remove" && target && !extra.length && !options.has("installed") && !options.has("dev")) {
    return { ...parseAppCommand("uninstall", [target, "--confirm"]), needsConfirmation: !options.has("yes") };
  }
  throw new Error("Verwende apt list [--installed], apt install <Paket-ID> oder apt remove [-y] <Paket-ID>.");
}

function systemctlCommand([action, target, ...extra], parseAppCommand) {
  const unit = target?.replace(/\.service$/u, "") || "bonni-core";
  if (!extra.length && action === "status") {
    if (unit === "bonni-core") return { kind: "ping", service: unit };
    if (moduleKey.test(unit)) return { kind: "module-status", key: unit };
  }
  if (!extra.length && ["start", "stop"].includes(action) && moduleKey.test(unit)) {
    return parseAppCommand(action === "start" ? "activate" : "deactivate", [unit]);
  }
  throw new Error("Verwende systemctl status bonni-core oder systemctl status|start|stop <Paket-ID>.");
}

function journalCommand(words) {
  const { args, options } = readOptions(words, {
    "-u": ["unit", true], "--unit": ["unit", true], "-p": ["level", true], "--priority": ["level", true],
    "-n": ["lines", true], "--lines": ["lines", true], "-r": ["reverse"], "--reverse": ["reverse"],
  });
  const unit = options.get("unit")?.replace(/\.service$/u, "");
  const level = options.get("level") ?? "info";
  const count = options.get("lines") ?? "20";
  if (args.length || (unit !== undefined && unit !== "bonni-core" && !moduleKey.test(unit))
    || !/^(?:[1-9]\d?|100)$/u.test(count) || (!Object.hasOwn(levelNames, level) && !/^[0-7]$/u.test(level))) {
    throw new Error("Verwende journalctl [-u bonni-core|Paket-ID] [-p err|warning|info] [-n 1–100].");
  }
  return { kind: "journal", unit, priority: levelNames[level] ?? Number(level), count: Number(count), reverse: options.has("reverse") };
}

function accountCommand(command, words) {
  if (command === "useradd") {
    const { args: [loginName, ...extra], options } = readOptions(words, { "-c": ["name", true], "--comment": ["name", true] });
    if (!loginName || extra.length) throw new Error('Verwende useradd -c "Anzeigename" <Login>.');
    return parseAdministrationCommand("create", JSON.stringify({ loginName, displayName: options.get("name") || loginName }));
  }
  if (command === "usermod") {
    const { args: [target, ...extra], options } = readOptions(words, { "-L": ["lock"], "--lock": ["lock"], "-U": ["unlock"], "--unlock": ["unlock"] });
    if (!target || extra.length || options.size !== 1) throw new Error("Verwende usermod -L <Login> oder usermod -U <Login>.");
    return parseAdministrationCommand(options.has("lock") ? "deactivate" : "activate", target);
  }
  const { args: [target, ...extra] } = readOptions(words);
  if (command === "userdel" && target && !extra.length) return parseAdministrationCommand("delete", target);
  if (command === "id" && !extra.length) return target ? parseAdministrationCommand("rights", target) : { kind: "user-rights" };
  if (command === "getent" && target === "passwd" && extra.length <= 1) {
    return { kind: "user-list", query: extra[0] || "", exactLogin: extra.length === 1 };
  }
  throw new Error("Verwende id [Login], getent passwd [Login] oder userdel <Login>.");
}

function directoryCommand(command, words) {
  const definitions = {
    ls: { "-a": ["all"], "--all": ["all"], "-l": ["long"], "-la": ["both"], "-al": ["both"] },
    mkdir: { "-p": ["parents"], "--parents": ["parents"] },
    rmdir: { "-p": ["parents"], "--parents": ["parents"] },
    rm: { "-r": ["recursive"], "-R": ["recursive"], "--recursive": ["recursive"], "-f": ["force"], "--force": ["force"], "-rf": ["both"], "-fr": ["both"] },
    cp: { "-R": ["recursive"], "-r": ["recursive"], "--recursive": ["recursive"] },
  };
  const { args, options } = readOptions(words, definitions[command]);
  if (command === "backup" && ["create", "erstellen"].includes(args[0]) && args.length <= 2) {
    return { kind: "backup-create", path: args[1] };
  }
  if (command === "pwd" && !args.length) return { kind: "pwd" };
  if (command === "cd" && args.length <= 1) return { kind: "cd", path: args[0] ?? "/" };
  if (command === "ls" && args.length <= 1) {
    return { kind: "ls", path: args[0], showHidden: options.has("all") || options.has("both"), long: options.has("long") || options.has("both") };
  }
  if (command === "cp" && args.length === 2 && args.every(Boolean)) {
    return { kind: "cp", path: args[0], target: args[1], recursive: options.has("recursive") };
  }
  if (args.length === 1 && args[0]) {
    if (command === "mkdir" || command === "rmdir") return { kind: command, path: args[0], parents: options.has("parents") };
    if (command === "rm") {
      return { kind: "rm", path: args[0], recursive: options.has("recursive") || options.has("both"), force: options.has("force") || options.has("both") };
    }
    if (["touch", "cat", "nano"].includes(command)) return { kind: command, path: args[0] };
  }
  throw new Error("Gib einen passenden Datei- oder Ordnerpfad an. help zeigt die verfügbaren Befehle.");
}

function parseCommand(words, parseAppCommand) {
  if (words[0] === "sudo") words = words.slice(1);
  if (words[0]?.toLowerCase() === "bonni" && words[1]?.toLowerCase() === "backup") words = words.slice(1);
  const [command, ...args] = words;
  if (command?.toLowerCase() === "backup") return directoryCommand("backup", [args[0]?.toLowerCase(), ...args.slice(1)].filter(value => value !== undefined));
  if (command === "apt") return aptCommand(args, parseAppCommand);
  if (command === "systemctl") return systemctlCommand(args, parseAppCommand);
  if (command === "journalctl") return journalCommand(args);
  if (["id", "getent", "useradd", "usermod", "userdel"].includes(command)) return accountCommand(command, args);
  if (fileCommands.includes(command)) return directoryCommand(command, args);
  if (command === "echo") return { kind: "echo", value: args.join(" ") };
  if (command === "sort" || command === "cut") {
    const { file, stage } = textPipe(command, args);
    if (!file) throw new Error(`Verwende ${command} <Optionen> <Datei> oder setze ${command} hinter |.`);
    return { kind: "cat", path: file, pipes: [stage] };
  }
  if (command === "ping" && (args.length === 0 || (args.length === 1 && args[0] === "bonni-core"))) return { kind: "ping" };
  if (["clear", "whoami"].includes(command) && !args.length) return { kind: command };
  if (command === "help") return { kind: "help", topic: args.join(" ").toLowerCase() };
  throw new Error("Unbekannter oder unvollständiger Befehl. Mit help siehst du die verfügbaren Befehle.");
}

function grepFilter(words) {
  const { args: [query, ...extra], options } = readOptions(words, {
    "-F": ["fixed"], "--fixed-strings": ["fixed"], "-i": ["ignoreCase"], "--ignore-case": ["ignoreCase"],
    "-Fi": ["both"], "-iF": ["both"],
  });
  if (!query || extra.length || !(options.has("fixed") || options.has("both"))) {
    throw new Error("Verwende grep -F <Suchtext> oder grep -Fi <Suchtext>.");
  }
  return { query, ignoreCase: options.has("ignoreCase") || options.has("both") };
}

function cutRanges(list) {
  const invalid = "Gib Positionen ab 1 an, zum Beispiel 1,3-5 oder 2-.";
  return list.split(",").map(part => {
    if (/^\d+$/u.test(part)) {
      const position = Number(part);
      if (!Number.isSafeInteger(position) || position < 1) throw new Error(invalid);
      return [position, position];
    }
    const range = /^(\d*)-(\d*)$/u.exec(part);
    if (!range || (!range[1] && !range[2])) throw new Error(invalid);
    const first = range[1] ? Number(range[1]) : 1;
    const last = range[2] ? Number(range[2]) : Infinity;
    if (!Number.isSafeInteger(first) || first < 1 || last < first || (range[2] && !Number.isSafeInteger(last))) throw new Error(invalid);
    return [first, last];
  });
}

function textPipe(kind, words) {
  if (kind === "sort") {
    const { args, options } = readOptions(words, { "-r": ["reverse"], "-n": ["numeric"], "-u": ["unique"] });
    if (args.length > 1) throw new Error("Verwende sort [-r] [-n] [-u] mit höchstens einer Datei.");
    return { file: args[0], stage: { kind, reverse: options.has("reverse"), numeric: options.has("numeric"), unique: options.has("unique") } };
  }
  const { args, options } = readOptions(words, {
    "-f": ["fields", true], "--fields": ["fields", true],
    "-b": ["bytes", true], "--bytes": ["bytes", true],
    "-c": ["characters", true], "--characters": ["characters", true],
    "-d": ["delimiter", true], "--delimiter": ["delimiter", true],
  });
  const modes = ["fields", "bytes", "characters"].filter(mode => options.has(mode));
  const delimiter = options.get("delimiter") ?? "\t";
  if (args.length > 1 || modes.length !== 1 || [...delimiter].length !== 1 || (options.has("delimiter") && modes[0] !== "fields")) {
    throw new Error("Verwende cut -f <Felder> [-d <Trennzeichen>], cut -b <Bytes> oder cut -c <Zeichen>.");
  }
  const [mode] = modes;
  return { file: args[0], stage: { kind, mode, delimiter, ranges: cutRanges(options.get(mode)) } };
}

function parsePipe([kind, ...words], isLast) {
  if (kind === "grep") return { kind, ...grepFilter(words) };
  if (kind === "sort" || kind === "cut") {
    const { stage, file } = textPipe(kind, words);
    if (file !== undefined) throw new Error(`Hinter | liest ${kind} die vorherige Ausgabe.`);
    return stage;
  }
  if (kind === "tee") {
    const { args: [path, ...extra], options } = readOptions(words, { "-a": ["append"], "--append": ["append"] });
    if (!isLast || !path || extra.length) throw new Error("Verwende tee [-a] <Dateiname> als letzten Schritt einer Pipe.");
    return { kind, path, append: options.has("append") };
  }
  throw new Error("Hinter | sind grep -F, sort, cut und tee verfügbar.");
}

export function parseLinuxLine(text, parseAppCommand) {
  return tokenize(text).map(({ parts: [words, ...pipes], text: expression }) => {
    const command = parseCommand(words, parseAppCommand);
    if (pipes.length && !["journal", "list", "user-list", "ls", "cat", "echo", "pwd", "whoami", "ping"].includes(command.kind)) {
      throw new Error("Eine Pipe ist für lesende Befehle wie journalctl, ls und cat verfügbar.");
    }
    const stages = [...(command.pipes || []), ...pipes.map((pipe, index) => parsePipe(pipe, index === pipes.length - 1))];
    return { ...command, ...(stages.length ? { pipes: stages } : {}), text: expression, historyText: text };
  });
}

export function filterTerminalOutput(output, { query, ignoreCase }) {
  const needle = ignoreCase ? query.toLowerCase() : query;
  const plainText = typeof output === "string";
  const lines = plainText ? output.split("\n") : output;
  const matches = lines.filter(line => {
    const text = plainText ? line : line.text;
    return (ignoreCase ? text.toLowerCase() : text).includes(needle);
  });
  if (!matches.length) throw new Error("grep hat keine passende Zeile gefunden.");
  return plainText ? matches.join("\n") : matches;
}
