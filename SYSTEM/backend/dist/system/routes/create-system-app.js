import { erasureStatusRouter } from "../../platform/auth/users/erasure-status.routes.js";
import express from "express";
import helmet from "helmet";
import { registerClosedSystemFrontend } from "./system-frontend.js";
import { registerCoreRoutes, registerSnapshotBrandingReadRoutes, } from "./registerCoreRoutes.js";
import { currentUserMiddleware } from "../../platform/auth/middleware/current-user.middleware.js";
import { registerCoreAuth } from "../../platform/auth/registerCoreAuth.js";
import { registerModuleFrontends } from "../../platform/module-manager/frontend/module-frontend-runtime.js";
import { requestLogger } from "../../core/http/http.js";
import { notFound } from "../../core/http/http.js";
import { errorHandler } from "../../core/http/http.js";
import { localRouter } from "./local.routes.js";
import { createDatabaseContextMiddleware } from "../../core/database/database.js";
import { assertRunContainerMatchesDatabase } from "../runtime/run-container/index.js";
import { updateProbeGuard } from "../runtime/update-probe/index.js";
import { emergencyReadOnlyMethodGuard } from "../../../scripts/runtime/emergency-read-only-guard.mjs";
import { browserCors, createBrowserOriginGuard } from "../../core/http/browser-origin.js";
import { boundedAuthJson, createAuthIpGuard, createAuthSubjectGuard } from "../../core/http/auth-ingress.js";
const DEFAULT_JSON_BODY_LIMIT = "50mb";
const MAX_JSON_BODY_BYTES = 50 * 1024 * 1024;
const MAX_TRUST_PROXY_HOPS = 8;
export function resolveExpressJsonLimit(value) {
    const candidate = String(value ?? DEFAULT_JSON_BODY_LIMIT).trim().toLowerCase();
    const match = /^([1-9][0-9]{0,8})(b|kb|mb)?$/.exec(candidate);
    if (!match)
        throw new Error("EXPRESS_JSON_LIMIT_INVALID");
    const amount = Number(match[1]);
    const unit = match[2] ?? "b";
    const factor = unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1;
    if (!Number.isSafeInteger(amount) || amount * factor > MAX_JSON_BODY_BYTES) {
        throw new Error("EXPRESS_JSON_LIMIT_INVALID");
    }
    return `${amount}${unit}`;
}
export function resolveExpressTrustProxyHops(value) {
    const candidate = String(value ?? "0").trim();
    if (!/^(?:0|[1-8])$/.test(candidate)) {
        throw new Error("EXPRESS_TRUST_PROXY_HOPS_INVALID");
    }
    const hops = Number(candidate);
    if (!Number.isSafeInteger(hops) || hops < 0 || hops > MAX_TRUST_PROXY_HOPS) {
        throw new Error("EXPRESS_TRUST_PROXY_HOPS_INVALID");
    }
    return hops;
}
function createBaseExpressApp(surface = "platform") {
    const app = express();
    const trustedProxyHops = resolveExpressTrustProxyHops(process.env.EXPRESS_TRUST_PROXY_HOPS);
    // Default 0 keeps caller-supplied forwarding headers untrusted. The closed
    // Runtime Compose explicitly enables exactly its one nginx hop.
    app.set("trust proxy", trustedProxyHops === 0 ? false : trustedProxyHops);
    // CSP frame-ancestors is the authoritative, modern framing policy. Sending
    // X-Frame-Options as well is ignored by browsers and creates a misleading
    // console warning for intentionally embedded opaque feature modules.
    app.use(helmet({ frameguard: false }));
    app.use(requestLogger);
    app.use(createBrowserOriginGuard());
    app.use(browserCors);
    // Limit expensive public authentication work before parsing large bodies or
    // opening a database context. Aliases and local listeners share counters.
    app.use(createAuthIpGuard());
    app.use(boundedAuthJson);
    app.use(createAuthSubjectGuard());
    app.use("/api/privacy/erasure/status", express.json({ limit: "1kb", inflate: false }));
    app.use(express.json({ limit: resolveExpressJsonLimit(process.env.EXPRESS_JSON_LIMIT) }));
    app.use((req, res, next) => {
        res.locals.timecapsuleSurface = surface;
        req.timecapsuleSurface = surface;
        next();
    });
    app.use(createDatabaseContextMiddleware(surface));
    return app;
}
function registerErrorHandling(app) {
    app.use(notFound);
    app.use(errorHandler);
}
export async function createPlatformApp() {
    // Bonni-Core Base must be able to start after a clean database reset even
    // when runcontainer/runtime identity rows have not been synchronised yet.
    // The mismatch is visible in runtime/health APIs, but it must not prevent
    // the active platform backend from listening on PORT.
    await assertRunContainerMatchesDatabase().catch((error) => {
        console.warn("[bonni-core] RunContainer/database identity check skipped for platform start", {
            code: error?.code || error?.message || error?.name || "RUNCONTAINER_CHECK_FAILED",
            message: error instanceof Error ? error.message : String(error),
        });
        return null;
    });
    const app = createBaseExpressApp("platform");
    // Candidate containers must not become an unnoticed second writer merely
    // because all normal application routers can be loaded successfully.
    app.use(updateProbeGuard);
    app.use("/api/privacy/erasure", erasureStatusRouter);
    registerCoreAuth(app);
    registerCoreRoutes(app);
    const { registerModules } = await import("../../platform/module-manager/loader/index.js");
    await registerModules(app);
    await registerModuleFrontends(app);
    registerClosedSystemFrontend(app);
    registerErrorHandling(app);
    return app;
}
export async function createRedundantSystemApp(options = {}) {
    const app = createBaseExpressApp("local");
    // Notlauf-Backend: eigener Prozess, eigener Port, JSON-Runtime.
    // Es lädt bewusst keine Fachmodul-Router hart nach, damit das Rettungssystem
    // auch dann startet, wenn active oder die Datenbank nicht verfügbar ist.
    // The old Emergency image may coexist with a newer Active for 14 days. This
    // application gate is one layer of the writer lease: direct localhost ports
    // can never turn Emergency into a second productive database writer.
    app.use(emergencyReadOnlyMethodGuard);
    (options.registerBranding || registerSnapshotBrandingReadRoutes)(app);
    app.use(currentUserMiddleware);
    app.use("/api", localRouter);
    registerClosedSystemFrontend(app);
    registerErrorHandling(app);
    return app;
}
export async function createLocalSystemApp(options = {}) {
    const app = createBaseExpressApp("local");
    // Local/Sandbox/Notlauf must not depend on OIDC. The local listener exposes
    // only core runtime and System routes, not application modules.
    (options.registerBranding || registerSnapshotBrandingReadRoutes)(app);
    app.use(currentUserMiddleware);
    app.use("/api", localRouter);
    registerErrorHandling(app);
    return app;
}
