import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod";

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse({
      body: req.body,
      query: req.query,
      params: req.params
    });

    if (!result.success) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        details: result.error.flatten()
      });
    }

    // Use Zod's defaults, transforms and field allowlists in the handlers.
    // Express 5 exposes query through an inherited getter, so install a
    // request-local data property instead of assigning req.query.
    const parsed = result.data as Record<string, unknown>;
    if (Object.hasOwn(parsed, "body")) req.body = parsed.body;
    if (Object.hasOwn(parsed, "params")) req.params = parsed.params as Request["params"];
    if (Object.hasOwn(parsed, "query")) {
      Object.defineProperty(req, "query", {
        value: parsed.query,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    next();
  };
}
