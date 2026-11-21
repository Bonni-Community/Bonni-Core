import { moduleKey } from "../terminal/terminalLinuxCommands.js";

const germanLetters = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };

function searchable(value) {
  return value.normalize("NFC").toLowerCase()
    .replace(/[äöüß]/gu, letter => germanLetters[letter])
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function applicationId(moduleId, names) {
  let key = moduleId;
  while (key && moduleKey.test(key)) {
    if (names.has(key)) return key;
    const suffix = key.lastIndexOf(".");
    if (suffix < 0) break;
    key = key.slice(0, suffix);
  }
  return moduleId;
}

export function liveLogApplicationOptions(entries, names, selected) {
  const options = new Map([...names].filter(([id]) => moduleKey.test(id)));
  for (const { moduleId } of entries) {
    const id = applicationId(moduleId, names);
    if (id && !options.has(id)) options.set(id, id);
  }
  if (moduleKey.test(selected) && !options.has(selected)) options.set(selected, selected);
  return [...options].sort(([leftId, left], [rightId, right]) => (
    left.localeCompare(right, "de") || leftId.localeCompare(rightId)
  ));
}

export function filterLiveLogEntries(entries, { query, hiddenTones, application }, names) {
  const terms = searchable(query).split(" ").filter(Boolean);
  return entries.filter(entry => {
    if (hiddenTones.has(entry.tone)) return false;
    const id = applicationId(entry.moduleId, names);
    if (id && application !== "all" && application !== id && application !== entry.moduleId) return false;
    if (!terms.length) return true;
    const text = searchable(`${entry.line} ${names.get(id) || ""}`);
    return terms.every(term => text.includes(term));
  });
}
