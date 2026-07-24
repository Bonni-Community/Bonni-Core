import type { NextFunction, Request, Response } from "express";

import {
  createKontorMeeting,
  getKontorMeetingAttendance,
  getKontorMeetingProtocolFile,
  listKontorMeetings,
  updateKontorMeetingDraft,
  updateKontorMeetingAttendance,
  uploadKontorMeetingProtocol,
} from "./meetings.service.js";
import { UserMutationError } from "./users.mutations.service.js";

function sendMeetingError(res: Response, error: unknown, fallbackCode: string, fallbackMessage: string) {
  if (error instanceof UserMutationError) {
    res.status(error.status).json({ ok: false, code: error.code, message: error.message });
    return;
  }

  console.error(`[system/users/meetings] ${fallbackMessage}`, error);
  res.status(500).json({ ok: false, code: fallbackCode, message: fallbackMessage });
}

export async function listKontorMeetingsController(
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  try {
    res.json(await listKontorMeetings((req as any).user));
  } catch (error) {
    sendMeetingError(res, error, "KONTOR_MEETINGS_LIST_FAILED", "Tagungen konnten nicht geladen werden.");
  }
}

export async function createKontorMeetingController(
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  try {
    res.status(201).json(await createKontorMeeting(req.body || {}, (req as any).user));
  } catch (error) {
    sendMeetingError(res, error, "KONTOR_MEETING_CREATE_FAILED", "Tagung konnte nicht einberufen werden.");
  }
}

export async function updateKontorMeetingDraftController(
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  try {
    res.json(await updateKontorMeetingDraft(req.params.meetingId, req.body || {}, (req as any).user));
  } catch (error) {
    sendMeetingError(res, error, "KONTOR_MEETING_DRAFT_UPDATE_FAILED", "Entwurf konnte nicht gespeichert werden.");
  }
}

export async function uploadKontorMeetingProtocolController(
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  try {
    res.json(await uploadKontorMeetingProtocol(req.params.meetingId, req.body || {}, (req as any).user));
  } catch (error) {
    sendMeetingError(res, error, "KONTOR_PROTOCOL_UPLOAD_FAILED", "Protokoll konnte nicht hochgeladen werden.");
  }
}

export async function downloadKontorMeetingProtocolController(
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  try {
    const file = await getKontorMeetingProtocolFile(req.params.meetingId, (req as any).user);
    const encodedFileName = encodeURIComponent(file.fileName).replace(
      /['()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", String(file.sizeInBytes));
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodedFileName}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(file.data);
  } catch (error) {
    sendMeetingError(res, error, "KONTOR_PROTOCOL_DOWNLOAD_FAILED", "Protokoll konnte nicht heruntergeladen werden.");
  }
}

export async function getKontorMeetingAttendanceController(
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  try {
    res.json(await getKontorMeetingAttendance(req.params.meetingId, (req as any).user));
  } catch (error) {
    sendMeetingError(res, error, "KONTOR_ATTENDANCE_LOAD_FAILED", "Präsenzliste konnte nicht geladen werden.");
  }
}

export async function updateKontorMeetingAttendanceController(
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  try {
    res.json(await updateKontorMeetingAttendance(
      req.params.meetingId,
      req.params.memberId,
      req.body || {},
      (req as any).user,
    ));
  } catch (error) {
    sendMeetingError(res, error, "KONTOR_ATTENDANCE_UPDATE_FAILED", "Präsenzliste konnte nicht gespeichert werden.");
  }
}
