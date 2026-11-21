import { privateValue, privateMessage, privateText } from "../../../scripts/runtime/log-privacy.mjs";
// Schema identifiers and stack locations remain useful. Request payloads,
// connection credentials, SQL parameter values and member data do not.
export function sanitizeDiagnosticText(value) {
    return String(value ?? "")
        .replace(/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?):\/\/[^\s<>"']+/gi, "[database-url redacted]")
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
        .replace(/([?&#](?:[^\s=&#]+)=)[^\s&#"']*/g, "$1[redacted]")
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, "[authorization redacted]")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[token redacted]")
        .replace(/((?:["']?)(?:password|passwd|secret|token|authorization|cookie|master[_-]?key|private[_-]?key|api[_-]?key|credential)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, "$1[redacted]")
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email redacted]")
        .replace(/(Key\s*\([^\n]*?\)\s*=\s*)\([^\n]*?\)/gi, "$1([values redacted])")
        .replace(/([A-Z]:[\\/]Users[\\/])[^\\/\s]+/gi, "$1[user]")
        .replace(/(\/(?:home|Users)\/)[^/\s]+/g, "$1[user]")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
export function sanitizeDiagnosticValue(value, key = "", seen = new WeakSet(), depth = 0) {
    return privateValue(value, key, seen, depth);
}
export function serializeDiagnosticError(error) {
    return privateValue(error instanceof Error ? error : { name: "Error", message: privateMessage(error) });
}
// Exports can include older retained records. Re-sanitize their JSON metadata
// as well as text; do not assume that a previous release already redacted it.
export function sanitizeDiagnosticExport(text) {
    return privateText(text);
}
