// Only fixed public reasons cross the module boundary; never expose ledger rows, IDs or exception text.
const reasonLabels = {
    BALANCE: "Ein Kontostand ist nicht ausgeglichen.", CREDIT: "Es ist noch Guthaben vorhanden.",
    CLAIM: "Es gibt offene Forderungen.", OPEN_TAB: "Ein Bierdeckel ist noch offen.",
    ORDER: "Eine Bestellung ist noch nicht abgeschlossen.", INVOICE: "Eine Rechnung ist noch offen.",
    PAYMENT: "Eine Zahlung ist noch nicht abgeschlossen.", RESERVATION: "Es gibt vorgemerkte Beträge.",
    TRANSFER: "Eine Übertragung ist noch nicht bestätigt.", CLARIFICATION: "Ein Vorgang ist in Klärung.",
    OFFLINE: "Die Warteschlangen der Geräte sind noch nicht vollständig bestätigt.",
    LEGACY: "Altbestände müssen noch geprüft werden.", DATA_UNAVAILABLE: "Daten konnten nicht vollständig geprüft werden.",
    IDENTITY: "Die Kontozuordnung muss geklärt werden.", RETENTION: "Aufbewahrung und Löschung müssen noch je Datenart geprüft werden.",
};
export function publicCheck(key, label, result) {
    const unknown = { key, label, status: "unverified", reasons: [reasonLabels.DATA_UNAVAILABLE] };
    if (!result || typeof result !== "object")
        return unknown;
    const { status, reasons } = result;
    if (!Array.isArray(reasons) || reasons.length > 32 || !reasons.every(x => typeof x === "string" && Object.hasOwn(reasonLabels, x)))
        return unknown;
    if (status === "clear" && reasons.length === 0)
        return { key, label, status, reasons: [] };
    if ((status !== "blocked" && status !== "unverified") || reasons.length === 0)
        return unknown;
    return { key, label, status, reasons: [...new Set(reasons)].map(x => reasonLabels[x]) };
}
export function aggregateChecks(modules) {
    const status = modules.some(m => m.status === "blocked") ? "blocked" :
        modules.length > 0 && modules.every(m => m.status === "clear") ? "clear" : "unverified";
    // An inspection is a momentary read. It is never an authorization to erase.
    return { status, canExecute: false, modules, checkedAt: new Date().toISOString() };
}
