import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router as ExpressRouter,
} from "express";

let systemRouterPromise: Promise<ExpressRouter> | undefined;

async function loadSystemRouter(): Promise<ExpressRouter> {
  systemRouterPromise ??= import(
    "./control-api/system.routes.js"
  ).then((module) => module.systemRouter);

  return systemRouterPromise;
}

/**
 * Lazily loads the System router.
 *
 * The local System surface must stay available even while the platform
 * registry and module manifests are loaded. Importing the full System
 * router eagerly from local.routes/registerCoreRoutes can create an ESM circular
 * dependency through the module catalog and platform-component registry.
 *
 * Express accepts request handlers at mount points, so this proxy resolves the
 * real router only when the first /system request arrives and then keeps
 * it cached in memory.
 */
export const lazySystemRouter: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const router = await loadSystemRouter();
    return router(req, res, next);
  } catch (error) {
    return next(error);
  }
};
