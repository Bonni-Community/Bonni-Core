import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import path from "node:path";
import { existsSync } from "node:fs";

import { registerCoreRoutes } from "./registerCoreRoutes.js";
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

const DEFAULT_JSON_BODY_LIMIT = "50mb";
const MAX_JSON_BODY_BYTES = 50 * 1024 * 1024;
const MAX_TRUST_PROXY_HOPS = 8;

export function resolveExpressJsonLimit(value: string | undefined): string {
  const candidate = String(value ?? DEFAULT_JSON_BODY_LIMIT).trim().toLowerCase();
  const match = /^([1-9][0-9]{0,8})(b|kb|mb)?$/.exec(candidate);
  if (!match) throw new Error("EXPRESS_JSON_LIMIT_INVALID");
  const amount = Number(match[1]);
  const unit = match[2] ?? "b";
  const factor = unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1;
  if (!Number.isSafeInteger(amount) || amount * factor > MAX_JSON_BODY_BYTES) {
    throw new Error("EXPRESS_JSON_LIMIT_INVALID");
  }
  return `${amount}${unit}`;
}

export function resolveExpressTrustProxyHops(value: string | undefined): number {
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

function applyPreflightHeaders(req: Request, res: Response) {
  const origin = req.headers.origin;
  const requestedHeaders = req.headers["access-control-request-headers"];

  // Development and local fallback must work without a frontend .env. We echo
  // the browser origin instead of using "*" so Authorization preflights are
  // accepted by Firefox/Chromium for localhost and 127.0.0.1.
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    typeof requestedHeaders === "string"
      ? requestedHeaders
      : "Authorization, Content-Type, X-Requested-With",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function createBaseExpressApp(surface: "platform" | "local" = "platform"): Express {
  const app = express();
  const trustedProxyHops = resolveExpressTrustProxyHops(process.env.EXPRESS_TRUST_PROXY_HOPS);
  // Default 0 keeps caller-supplied forwarding headers untrusted. The closed
  // Runtime Compose explicitly enables exactly its one nginx hop.
  app.set("trust proxy", trustedProxyHops === 0 ? false : trustedProxyHops);

  app.use((req, res, next) => {
    applyPreflightHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  });

  // CSP frame-ancestors is the authoritative, modern framing policy. Sending
  // X-Frame-Options as well is ignored by browsers and creates a misleading
  // console warning for intentionally embedded opaque feature modules.
  app.use(helmet({ frameguard: false }));
  app.use(cors({ origin: true, credentials: false, optionsSuccessStatus: 204 }));
  app.use(express.json({ limit: resolveExpressJsonLimit(process.env.EXPRESS_JSON_LIMIT) }));
  app.use((req, res, next) => {
    res.locals.timecapsuleSurface = surface;
    (req as typeof req & { timecapsuleSurface?: "platform" | "local" }).timecapsuleSurface = surface;
    next();
  });
  app.use(createDatabaseContextMiddleware(surface));
  app.use(requestLogger);

  return app;
}


function sendIndexIfExists(res: Response, indexFile: string, next: NextFunction) {
  if (!existsSync(indexFile)) {
    next();
    return;
  }

  res.sendFile(indexFile);
}

function registerClosedSystemFrontend(app: Express) {
  const frontendRoot = process.env.FRONTEND_DIST_ROOT ?? path.resolve(process.cwd(), "public");
  const systemFrontend = path.join(frontendRoot, "system");
  if (existsSync(systemFrontend)) {
    app.use(express.static(systemFrontend, { index: false }));
    app.get(/^\/(?!api(?:\/|$)).*$/, (_req, res, next) => {
      sendIndexIfExists(res, path.join(systemFrontend, "index.html"), next);
    });
  }
}

function registerErrorHandling(app: Express) {
  app.use(notFound);
  app.use(errorHandler);
}

export async function createPlatformApp(): Promise<Express> {
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

  registerCoreAuth(app);
  registerCoreRoutes(app);

  const { registerModules } = await import(
    "../../platform/module-manager/loader/index.js"
  );

  await registerModules(app);
  await registerModuleFrontends(app);

  registerClosedSystemFrontend(app);

  registerErrorHandling(app);

  return app;
}


export async function createRedundantSystemApp(): Promise<Express> {
  const app = createBaseExpressApp("local");

  // Notlauf-Backend: eigener Prozess, eigener Port, JSON-Runtime.
  // Es lädt bewusst keine Fachmodul-Router hart nach, damit das Rettungssystem
  // auch dann startet, wenn active oder die Datenbank nicht verfügbar ist.
  app.use(currentUserMiddleware);
  app.use("/api", localRouter);

  registerClosedSystemFrontend(app);
  registerErrorHandling(app);

  return app;
}

export async function createLocalSystemApp(): Promise<Express> {
  const app = createBaseExpressApp("local");

  // Local/Sandbox/Notlauf must not depend on OIDC. The local listener exposes
  // only core runtime and System routes, not application modules.
  app.use(currentUserMiddleware);
  app.use("/api", localRouter);

  registerErrorHandling(app);

  return app;
}
