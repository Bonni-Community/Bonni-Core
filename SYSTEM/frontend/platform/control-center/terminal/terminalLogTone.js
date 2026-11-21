import { moduleKey } from "./terminalLinuxCommands.js";

const liveHeader = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)(?: (CRITICAL|ERROR|WARN|INFO|DEBUG))?(?:\s|$)/u;
const loginModules = new Set(["auth", "auth.bootstrap", "bonni-core-auth"]);
const loginPaths = new Set(["/login", "/login/2fa"]);

function severityTone(level) {
  const severity = level.toLowerCase();
  if (severity === "error" || severity === "critical") return "error";
  if (severity === "warn") return "warning";
  return null;
}

function logSource({ module, moduleId, path, code } = {}) {
  if (loginPaths.has(path) || loginModules.has(moduleId) || loginModules.has(module)
    || code === "AUTH_LOGIN_SUCCESS" || code === "AUTH_LOGIN_FAILED") return "login";
  if (moduleKey.test(moduleId || "") || moduleKey.test(module || "")) return "application";
  return "system";
}

export function terminalLogTone(level, metadata) {
  return severityTone(level) || logSource(metadata);
}

export function parseLiveLogLine(line) {
  const header = liveHeader.exec(line);
  if (!header) {
    const tone = /^\[(?:CRITICAL )?ERROR\](?:\s|$)/u.test(line) ? "error" : "text";
    return { line, tone, message: line };
  }

  const [prefix, timestamp, level] = header;
  const metadataStart = line.indexOf(" {");
  let metadata;
  if (metadataStart >= 0) {
    try { metadata = JSON.parse(line.slice(metadataStart + 1)); }
    catch { /* Older log lines can end without complete metadata. */ }
  }
  const moduleId = [metadata?.moduleId, metadata?.module].find(id => typeof id === "string" && moduleKey.test(id));
  const message = line.slice(prefix.length, metadata ? metadataStart : undefined).trim();
  return { line, tone: level ? terminalLogTone(level, metadata) : "text", moduleId, timestamp, level, message, metadata };
}
