import express from "express";

export default express;

export const Router = express.Router;
export const json = express.json;
export const urlencoded = express.urlencoded;
export const raw = express.raw;
export const text = express.text;

// Do not export a binding named `static`.
// `static` is a reserved word in strict mode and can break the runtime transform.
export const expressStatic = express.static;
export const serveStatic = express.static;

export type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router as ExpressRouter,
} from "express";
