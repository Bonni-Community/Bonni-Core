import type { NextFunction, Request, Response } from "express";

import {
  createLocalMember,
  deleteLocalMemberAccount,
  getMemberDetailsById,
  updateLocalMemberAccess,
  updateLocalMemberProfile,
  updateMemberById,
  UserMutationError,
} from "./users.mutations.service.js";
import { AccountSecurityTransitionError } from "../../../core/modules/security/two-factor/account-security-transition.js";
import { getSystemUsersOverview } from "./users.service.js";

export async function getUsersOverviewController(
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  try {
    res.json(await getSystemUsersOverview((req as any).user));
  } catch (error) {
    console.error("[system/users] Unerwarteter Fehler", error);
    res.status(200).json({
      ok: false,
      area: "users",
      status: "error",
      checkedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
      stats: {
        members: 0,
        activeMembers: 0,
        accounts: 0,
        activeAccounts: 0,
        activeSessions: 0,
        terminalSessions: 0,
        roles: 0,
        invitations: 0,
      },
      filters: {
        roles: [],
        statuses: ["Aktiviert", "Deaktiviert"],
      },
      members: [],
      users: [],
    });
  }
}

export async function getMemberDetailsController(
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  try {
    res.json(await getMemberDetailsById(req.params.memberId, (req as any).user));
  } catch (error) {
    if (error instanceof UserMutationError) {
      res.status(error.status).json({
        ok: false,
        code: error.code,
        message: error.message,
      });
      return;
    }

    console.error("[system/users] Mitgliedsdetails konnten nicht geladen werden", error);
    res.status(500).json({
      ok: false,
      code: "MEMBER_DETAILS_FAILED",
      message: "Mitgliedsdetails konnten nicht geladen werden.",
    });
  }
}

export async function createLocalMemberController(
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  try {
    const result = await createLocalMember(req.body || {}, (req as any).user);
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof UserMutationError) {
      res.status(error.status).json({
        ok: false,
        code: error.code,
        message: error.message,
      });
      return;
    }

    console.error("[system/users] Benutzer konnte nicht erstellt werden", error);
    res.status(500).json({
      ok: false,
      code: "LOCAL_MEMBER_CREATE_FAILED",
      message: "Mitglied konnte nicht erstellt werden.",
    });
  }
}

export async function updateLocalMemberProfileController(
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  try {
    res.json(await updateLocalMemberProfile(req.params.accountId, req.body || {}, (req as any).user));
  } catch (error) {
    if (error instanceof UserMutationError) {
      res.status(error.status).json({
        ok: false,
        code: error.code,
        message: error.message,
      });
      return;
    }

    console.error("[system/users] Benutzer konnte nicht aktualisiert werden", error);
    res.status(500).json({
      ok: false,
      code: "LOCAL_MEMBER_UPDATE_FAILED",
      message: "Benutzer konnte nicht gespeichert werden.",
    });
  }
}

export async function updateMemberByIdController(
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  try {
    res.json(await updateMemberById(req.params.memberId, req.body || {}, (req as any).user));
  } catch (error) {
    if (error instanceof UserMutationError) {
      res.status(error.status).json({
        ok: false,
        code: error.code,
        message: error.message,
      });
      return;
    }

    console.error("[system/users] Mitglied konnte nicht aktualisiert werden", error);
    res.status(500).json({
      ok: false,
      code: "MEMBER_UPDATE_FAILED",
      message: "Mitglied konnte nicht gespeichert werden.",
    });
  }
}

export async function updateLocalMemberAccessController(
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  try {
    res.json(await updateLocalMemberAccess(req.params.accountId, req.body || {}, (req as any).user));
  } catch (error) {
    if (error instanceof AccountSecurityTransitionError) {
      res.status(error.statusCode).json({ ok: false, code: error.code, message: error.message });
      return;
    }
    if (error instanceof UserMutationError) {
      res.status(error.status).json({
        ok: false,
        code: error.code,
        message: error.message,
      });
      return;
    }

    console.error("[system/users] Zugangsdaten konnten nicht aktualisiert werden", error);
    res.status(500).json({
      ok: false,
      code: "LOCAL_MEMBER_ACCESS_UPDATE_FAILED",
      message: "Zugangsdaten konnten nicht gespeichert werden.",
    });
  }
}

export async function deleteLocalMemberAccountController(
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  try {
    res.json(await deleteLocalMemberAccount(req.params.accountId, (req as any).user));
  } catch (error) {
    if (error instanceof UserMutationError) {
      res.status(error.status).json({
        ok: false,
        code: error.code,
        message: error.message,
      });
      return;
    }

    console.error("[system/users] Benutzerzugang konnte nicht gelöscht werden", error);
    res.status(500).json({
      ok: false,
      code: "LOCAL_MEMBER_DELETE_FAILED",
      message: "Benutzerzugang konnte nicht gelöscht werden.",
    });
  }
}
