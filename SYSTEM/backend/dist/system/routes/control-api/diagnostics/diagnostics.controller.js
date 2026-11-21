import { readRouteParam } from "../../../../core/http/route-param.js";
import { readCoreDiagnosticError } from "../../../../core/logger/coreLogStorage.js";
import { validDiagnosticId } from "../../../../core/logger/diagnostic-journal.js";
import { getSystemDiagnostics, getSystemDiagnosticsLogFile, getSystemDiagnosticsJournal, getSystemDiagnosticsLogs, } from "./diagnostics.service.js";
export function getDiagnosticsController(_req, res) {
    res.json(getSystemDiagnostics());
}
export async function getDiagnosticErrorController(req, res, next) {
    res.setHeader("Cache-Control", "no-store");
    const id = readRouteParam(req.params.errorId).toLowerCase();
    if (!validDiagnosticId(id)) {
        res.status(400).json({ message: "Gib die vollständige Fehler-ID aus dem Live-Terminal an." });
        return;
    }
    try {
        const result = await readCoreDiagnosticError(id);
        if (!result) {
            res.status(404).json({ message: "Diese Fehler-ID wurde in den aufbewahrten Core-Protokollen nicht gefunden." });
            return;
        }
        res.json(result);
    }
    catch (error) {
        next(error);
    }
}
export async function getDiagnosticsLogsController(req, res, next) {
    try {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        const stream = String(req.query.stream || "").toLowerCase();
        const category = String(req.query.category || "all");
        const moduleId = typeof req.query.moduleId === "string" ? req.query.moduleId : undefined;
        if (req.query.download === "1" || req.query.download === "true") {
            if (stream === "journal" || stream === "journal-error") {
                const content = await getSystemDiagnosticsJournal(category, {
                    errorsOnly: stream === "journal-error",
                    operationId: typeof req.query.operationId === "string" ? req.query.operationId : undefined,
                    moduleId,
                });
                res.setHeader("Content-Disposition", 'attachment; filename="bonni-core-gesamt.log"');
                res.type("text/plain").send(content);
                return;
            }
            const selected = stream === "error" ? "error" : "log";
            const fileName = selected === "error" ? "bonni-core-error.txt" : "bonni-core.log";
            const content = await getSystemDiagnosticsLogFile(selected);
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Content-Disposition", `attachment; filename=\"${fileName}\"`);
            res.type("text/plain").send(content);
            return;
        }
        const limit = Number(req.query.limit || 500);
        res.json(await getSystemDiagnosticsLogs(limit, category, moduleId));
    }
    catch (error) {
        next(error);
    }
}
