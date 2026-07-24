import type {
  AuthContext,
} from "../../platform/auth/session/authContext.js";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export {};
