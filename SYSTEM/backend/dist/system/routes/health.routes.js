import { Router } from "express";
import { getRuntimeLiveStatus, getRuntimeReadyStatus } from "../runtime/index.js";
import { getRuntimeModuleSummary } from "../../platform/module-manager/loader/index.js";
export const healthRouter = Router();
// Backward-compatible health endpoint. Prefer /api/health/live and
// /api/health/ready for runtime/proxy checks.
healthRouter.get("/", (_req, res) => {
    res.json(getRuntimeLiveStatus());
});
healthRouter.get("/live", (_req, res) => {
    res.json(getRuntimeLiveStatus());
});
healthRouter.get("/ready", async (_req, res, next) => {
    try {
        const status = await getRuntimeReadyStatus();
        res.status(status.ok ? 200 : 503).json(status);
    }
    catch (error) {
        next(error);
    }
});
// Strikter lokaler Update-Gate: Ein erfolgreicher Listen-Callback allein ist
// noch kein Beweis, dass Datenbank und Module nach einem Update verwendbar sind.
healthRouter.get("/local-update-ready", async (_req, res, next) => {
    try {
        const readiness = await getRuntimeReadyStatus();
        const modules = await getRuntimeModuleSummary();
        const ok = Boolean(readiness.state === "ready"
            && readiness.database.ready
            && modules.counts.error === 0);
        res.status(ok ? 200 : 503).json({ ...readiness, ok, modules });
    }
    catch (error) {
        next(error);
    }
});
// Strict Candidate gate used by the external update runner. A degraded JSON
// fallback is intentionally insufficient for promotion.
healthRouter.get("/update-probe", async (_req, res, next) => {
    try {
        const readiness = await getRuntimeReadyStatus();
        const modules = await getRuntimeModuleSummary();
        const runtime = readiness.runtime;
        const imageVersionMatches = !runtime.imageVersion || runtime.imageVersion === runtime.version;
        const ok = Boolean(runtime.updateProbeMode
            && runtime.slotRole === "candidate"
            && readiness.state === "ready"
            && readiness.database.ready
            && modules.counts.error === 0
            && imageVersionMatches);
        res.status(ok ? 200 : 503).json({
            ...readiness,
            ok,
            probe: {
                enabled: runtime.updateProbeMode,
                expectedRole: "candidate",
                roleMatches: runtime.slotRole === "candidate",
                imageVersion: runtime.imageVersion,
                imageVersionMatches,
                databaseRequired: true,
                modules,
            },
        });
    }
    catch (error) {
        next(error);
    }
});
