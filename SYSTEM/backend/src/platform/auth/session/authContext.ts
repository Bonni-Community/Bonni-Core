import type { Request } from "express";

export type AuthContext = {
  accountId: string;
  loginName: string;
  accountType?: string;
  type?: string;
  sessionId?: string;
  credentialRevision: number;
  roles: string[];
  permissions: string[];
};

export type AuthenticatedRequest = Request & {
  auth?: AuthContext;
};
