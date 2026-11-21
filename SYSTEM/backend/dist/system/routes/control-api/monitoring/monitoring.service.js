import { getRuntimeModuleSummary } from "../../../../platform/module-manager/loader/index.js";
import { getRuntimeReadyStatus } from "../../../runtime/index.js";
import { getSystemOverview } from "../overview/index.js";
import { getCoreUpdateCenterStatus } from "../update-center/index.js";
function resourceState(percent, warningAt, criticalAt) {
    if (!Number.isFinite(percent))
        return "unknown";
    if (percent >= criticalAt)
        return "unhealthy";
    if (percent >= warningAt)
        return "degraded";
    return "healthy";
}
function overallState(states) {
    if (states.includes("unhealthy"))
        return "unhealthy";
    if (states.includes("degraded"))
        return "degraded";
    if (states.every((state) => state === "unknown"))
        return "unknown";
    return "healthy";
}
export async function getSystemMonitoringStatus() {
    const checkedAt = new Date().toISOString();
    const [overview, readiness, moduleRuntime, updateCenter] = await Promise.all([
        getSystemOverview(),
        getRuntimeReadyStatus(),
        getRuntimeModuleSummary(),
        getCoreUpdateCenterStatus(),
    ]);
    const cpuPercent = Number(overview.system.cpu.percent || 0);
    const memoryPercent = Number(overview.system.memory.percent || 0);
    const storagePercent = Number(overview.system.storage.percent || 0);
    const moduleErrors = moduleRuntime.modules.filter((module) => module.status === "error");
    const components = [
        {
            key: "backend",
            label: "Bonni Core Backend",
            state: readiness.state === "unready" ? "unhealthy" : readiness.state === "degraded" ? "degraded" : "healthy",
            message: readiness.state === "ready" ? "Betriebsbereit" : readiness.state === "degraded" ? "Notlauf aktiv" : "Nicht betriebsbereit",
            target: "server",
        },
        {
            key: "database",
            label: "PostgreSQL",
            state: readiness.database.ready ? "healthy" : "unhealthy",
            message: readiness.database.ready ? overview.database.label : readiness.database.message,
            target: "server",
        },
        {
            key: "notlauf",
            label: "JSON-Notlauf",
            state: readiness.runtimeFallback.json.ok ? (readiness.runtimeFallback.active ? "degraded" : "healthy") : "unhealthy",
            message: readiness.runtimeFallback.active
                ? "Notlauf ist aktiv"
                : readiness.runtimeFallback.json.ok
                    ? "Als Rückfallebene bereit"
                    : "Rückfallebene nicht vollständig",
            target: "server",
        },
        {
            key: "module-runtime",
            label: "Erweiterungs-Laufzeit",
            state: moduleErrors.length ? "degraded" : "healthy",
            message: moduleErrors.length ? `${moduleErrors.length} Erweiterung(en) mit Laufzeitfehler` : `${moduleRuntime.counts.loaded} Erweiterung(en) geladen`,
            target: "store",
        },
    ];
    const resources = [
        {
            key: "cpu",
            label: "CPU",
            percent: cpuPercent,
            state: resourceState(cpuPercent, 85, 95),
            detail: overview.system.cpu.model,
        },
        {
            key: "memory",
            label: "Arbeitsspeicher",
            percent: memoryPercent,
            state: resourceState(memoryPercent, 85, 95),
            usedBytes: overview.system.memory.usedBytes,
            totalBytes: overview.system.memory.totalBytes,
        },
        {
            key: "storage",
            label: "Speicher",
            percent: storagePercent,
            state: resourceState(storagePercent, 80, 92),
            usedBytes: overview.system.storage.usedBytes,
            totalBytes: overview.system.storage.totalBytes,
            path: overview.system.storage.path,
        },
    ];
    const warnings = [];
    if (!readiness.database.ready) {
        warnings.push({
            key: "database-unavailable",
            severity: "critical",
            title: "Datenbank nicht erreichbar",
            message: readiness.database.message,
            target: "server",
        });
    }
    if (readiness.runtimeFallback.active) {
        warnings.push({
            key: "notlauf-active",
            severity: "warning",
            title: "Bonni Core arbeitet im Notlauf",
            message: "Schreibende Funktionen sind eingeschränkt, bis PostgreSQL wieder verfügbar ist.",
            target: "server",
        });
    }
    if (storagePercent >= 80) {
        warnings.push({
            key: "storage-high",
            severity: storagePercent >= 92 ? "critical" : "warning",
            title: "Speicherbelegung ist hoch",
            message: `${Math.round(storagePercent)} % des überwachten Speichers sind belegt.`,
            target: "system",
        });
    }
    if (memoryPercent >= 85) {
        warnings.push({
            key: "memory-high",
            severity: memoryPercent >= 95 ? "critical" : "warning",
            title: "Arbeitsspeicher ist stark ausgelastet",
            message: `${Math.round(memoryPercent)} % des Arbeitsspeichers sind belegt.`,
            target: "system",
        });
    }
    for (const module of moduleErrors) {
        warnings.push({
            key: `module-${module.key}`,
            severity: "warning",
            title: `${module.name} konnte nicht geladen werden`,
            message: module.error || "Die Erweiterung meldet einen Laufzeitfehler.",
            target: "store",
        });
    }
    if (["failed", "rolled-back"].includes(updateCenter.workflow?.status || "")) {
        const updateWorkflow = updateCenter.workflow;
        warnings.push({
            key: "update-failed",
            severity: "warning",
            title: updateWorkflow?.status === "rolled-back" ? "Update wurde zurückgerollt" : "Update wurde angehalten",
            message: updateWorkflow?.message || updateWorkflow?.error || "Die Update-Checkliste enthält einen Fehler.",
            target: "system",
        });
    }
    if (updateCenter.backup.restoreRequest?.status === "failed") {
        warnings.push({
            key: "restore-failed",
            severity: "critical",
            title: "Wiederherstellung fehlgeschlagen",
            message: String(updateCenter.backup.restoreRequest?.error || "Der Rückkehrpunkt konnte nicht eingespielt werden."),
            target: "system",
        });
    }
    const state = overallState([
        ...components.map((component) => component.state),
        ...resources.map((resource) => resource.state),
        ...warnings.map((warning) => warning.severity === "critical" ? "unhealthy" : "degraded"),
    ]);
    return {
        ok: state !== "unhealthy",
        area: "system-monitoring",
        state,
        checkedAt,
        version: overview.backend.version,
        uptimeSeconds: overview.backend.uptimeSeconds,
        hostname: overview.system.hostname,
        components,
        resources,
        warnings,
    };
}
