import type { AuthContext } from "./authContext.js";

export type RequestUserContext = AuthContext & {
  id?: string;
  source?: string;
  status?: string;
};

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      user?: RequestUserContext;
    }
  }
}

export {};
