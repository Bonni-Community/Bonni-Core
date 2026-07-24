import { getPrismaClient } from "../../../core/database/database.js";
import {
  assertCanManageUsers,
  UserMutationError,
} from "./users.mutations.service.js";

type CurrentUserContext = {
  accountId?: string | null;
  id?: string | null;
  loginName?: string | null;
};

type CreateMeetingInput = {
  title?: unknown;
  scheduledFor?: unknown;
  agendaText?: unknown;
};

type UpdateAttendanceInput = {
  present?: unknown;
};

type UpdateMeetingDraftInput = {
  agendaText?: unknown;
  protocolText?: unknown;
};

type UploadMeetingProtocolInput = {
  fileName?: unknown;
  mimeType?: unknown;
  dataBase64?: unknown;
};

const MAX_PROTOCOL_FILE_BYTES = 15 * 1024 * 1024;
const ALLOWED_PROTOCOL_EXTENSIONS = new Set([
  "doc",
  "docx",
  "odt",
  "pdf",
  "rtf",
  "txt",
]);

function cleanText(value: unknown, maxLength = 180) {
  return String(value || "").trim().slice(0, maxLength);
}

function optionalLongText(value: unknown, maxLength: number) {
  const text = String(value || "").trim().slice(0, maxLength);
  return text || null;
}

function safeFileName(value: unknown) {
  const fileName = cleanText(value, 180)
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!fileName) {
    throw new UserMutationError("KONTOR_PROTOCOL_FILE_REQUIRED", "Bitte eine Protokolldatei auswählen.");
  }

  const extension = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : "";
  if (!extension || !ALLOWED_PROTOCOL_EXTENSIONS.has(extension)) {
    throw new UserMutationError(
      "KONTOR_PROTOCOL_FILE_TYPE_INVALID",
      "Erlaubt sind PDF-, Word-, OpenDocument-, RTF- und Textdateien.",
    );
  }
  return fileName;
}

function safeMimeType(value: unknown) {
  const mimeType = cleanText(value, 120).toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType)
    ? mimeType
    : "application/octet-stream";
}

function protocolFileData(value: unknown) {
  const encoded = String(value || "")
    .replace(/^data:[^;,]+;base64,/i, "")
    .replace(/\s+/g, "");
  if (!encoded || !/^[a-z0-9+/]*={0,2}$/i.test(encoded)) {
    throw new UserMutationError("KONTOR_PROTOCOL_FILE_INVALID", "Die Protokolldatei ist ungültig.");
  }
  if (encoded.length > Math.ceil(MAX_PROTOCOL_FILE_BYTES / 3) * 4 + 4) {
    throw new UserMutationError(
      "KONTOR_PROTOCOL_FILE_TOO_LARGE",
      "Die Protokolldatei darf höchstens 15 MB groß sein.",
      413,
    );
  }

  const data = Buffer.from(encoded, "base64");
  const normalizedInput = encoded.replace(/=+$/, "");
  const normalizedOutput = data.toString("base64").replace(/=+$/, "");
  if (!data.length || normalizedInput !== normalizedOutput) {
    throw new UserMutationError("KONTOR_PROTOCOL_FILE_INVALID", "Die Protokolldatei ist ungültig.");
  }
  if (data.length > MAX_PROTOCOL_FILE_BYTES) {
    throw new UserMutationError(
      "KONTOR_PROTOCOL_FILE_TOO_LARGE",
      "Die Protokolldatei darf höchstens 15 MB groß sein.",
      413,
    );
  }
  return data;
}

function protocolFileSummary(file: {
  fileName: string;
  mimeType: string;
  sizeInBytes: number;
  uploadedAt: Date;
  updatedAt: Date;
} | null) {
  if (!file) return null;
  return {
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeInBytes: file.sizeInBytes,
    uploadedAt: file.uploadedAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

function requiredId(value: unknown, code: string, message: string) {
  const id = cleanText(value, 180);
  if (!id) throw new UserMutationError(code, message);
  return id;
}

function meetingDate(value: unknown) {
  const raw = cleanText(value, 40);
  if (!raw) {
    throw new UserMutationError("KONTOR_MEETING_DATE_REQUIRED", "Bitte ein Datum für die Tagung auswählen.");
  }

  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw);
  if (Number.isNaN(date.getTime())) {
    throw new UserMutationError("KONTOR_MEETING_DATE_INVALID", "Das Tagungsdatum ist ungültig.");
  }
  return date;
}

function booleanValue(value: unknown) {
  if (typeof value === "boolean") return value;
  if (value === 1 || String(value).trim().toLowerCase() === "true") return true;
  if (value === 0 || String(value).trim().toLowerCase() === "false") return false;
  throw new UserMutationError("KONTOR_ATTENDANCE_INVALID", "Der Anwesenheitsstatus ist ungültig.");
}

async function assertMeetingAccess(currentUser?: CurrentUserContext | null) {
  const prisma = getPrismaClient();
  await assertCanManageUsers(prisma, currentUser, { allowKontorManager: true });
  return prisma;
}

export async function listKontorMeetings(currentUser?: CurrentUserContext | null) {
  const prisma = await assertMeetingAccess(currentUser);
  const meetings = await prisma.kontorMeeting.findMany({
    include: {
      _count: {
        select: { attendance: true },
      },
      attendance: {
        where: { present: true },
        select: { id: true },
      },
      protocolFile: {
        select: {
          fileName: true,
          mimeType: true,
          sizeInBytes: true,
          uploadedAt: true,
          updatedAt: true,
        },
      },
    },
    orderBy: [
      { scheduledFor: "desc" },
      { createdAt: "desc" },
    ],
  });

  return {
    ok: true,
    meetings: meetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      scheduledFor: meeting.scheduledFor.toISOString(),
      agendaText: meeting.agendaText,
      protocolText: meeting.protocolText,
      hasDraft: Boolean(meeting.protocolText?.trim() || meeting.agendaText?.trim()),
      hasProtocol: Boolean(meeting.protocolFile),
      protocolFile: protocolFileSummary(meeting.protocolFile),
      recordedAttendanceCount: meeting._count.attendance,
      presentCount: meeting.attendance.length,
      createdAt: meeting.createdAt.toISOString(),
      updatedAt: meeting.updatedAt.toISOString(),
    })),
  };
}

export async function createKontorMeeting(
  input: CreateMeetingInput,
  currentUser?: CurrentUserContext | null,
) {
  const prisma = await assertMeetingAccess(currentUser);
  const title = cleanText(input.title, 180);
  if (!title) {
    throw new UserMutationError("KONTOR_MEETING_TITLE_REQUIRED", "Bitte einen Titel für die Tagung eingeben.");
  }

  const meeting = await prisma.kontorMeeting.create({
    data: {
      title,
      scheduledFor: meetingDate(input.scheduledFor),
      agendaText: optionalLongText(input.agendaText, 12_000),
      createdById: cleanText(currentUser?.accountId || currentUser?.id, 180) || null,
    },
  });

  return {
    ok: true,
    created: true,
    meeting: {
      id: meeting.id,
      title: meeting.title,
      scheduledFor: meeting.scheduledFor.toISOString(),
      agendaText: meeting.agendaText,
      protocolText: meeting.protocolText,
      hasDraft: Boolean(meeting.agendaText?.trim()),
      hasProtocol: false,
      protocolFile: null,
      presentCount: 0,
    },
  };
}

export async function updateKontorMeetingDraft(
  meetingIdValue: unknown,
  input: UpdateMeetingDraftInput,
  currentUser?: CurrentUserContext | null,
) {
  const prisma = await assertMeetingAccess(currentUser);
  const meetingId = requiredId(meetingIdValue, "KONTOR_MEETING_ID_REQUIRED", "Die Tagungs-ID fehlt.");
  const existing = await prisma.kontorMeeting.findUnique({ where: { id: meetingId }, select: { id: true } });
  if (!existing) {
    throw new UserMutationError("KONTOR_MEETING_NOT_FOUND", "Die Tagung wurde nicht gefunden.", 404);
  }

  const meeting = await prisma.kontorMeeting.update({
    where: { id: meetingId },
    data: {
      agendaText: optionalLongText(input.agendaText, 12_000),
      protocolText: optionalLongText(input.protocolText, 120_000),
    },
    select: {
      id: true,
      agendaText: true,
      protocolText: true,
      updatedAt: true,
    },
  });

  return {
    ok: true,
    meeting: {
      id: meeting.id,
      agendaText: meeting.agendaText,
      protocolText: meeting.protocolText,
      hasDraft: Boolean(meeting.protocolText?.trim() || meeting.agendaText?.trim()),
      updatedAt: meeting.updatedAt.toISOString(),
    },
  };
}

export async function uploadKontorMeetingProtocol(
  meetingIdValue: unknown,
  input: UploadMeetingProtocolInput,
  currentUser?: CurrentUserContext | null,
) {
  const prisma = await assertMeetingAccess(currentUser);
  const meetingId = requiredId(meetingIdValue, "KONTOR_MEETING_ID_REQUIRED", "Die Tagungs-ID fehlt.");
  const meeting = await prisma.kontorMeeting.findUnique({ where: { id: meetingId }, select: { id: true } });
  if (!meeting) {
    throw new UserMutationError("KONTOR_MEETING_NOT_FOUND", "Die Tagung wurde nicht gefunden.", 404);
  }

  const fileName = safeFileName(input.fileName);
  const data = protocolFileData(input.dataBase64);
  const mimeType = safeMimeType(input.mimeType);
  const protocolFile = await prisma.kontorMeetingProtocolFile.upsert({
    where: { meetingId },
    update: {
      fileName,
      mimeType,
      sizeInBytes: data.length,
      data,
      uploadedAt: new Date(),
    },
    create: {
      meetingId,
      fileName,
      mimeType,
      sizeInBytes: data.length,
      data,
    },
    select: {
      fileName: true,
      mimeType: true,
      sizeInBytes: true,
      uploadedAt: true,
      updatedAt: true,
    },
  });

  return {
    ok: true,
    protocolFile: protocolFileSummary(protocolFile),
  };
}

export async function getKontorMeetingProtocolFile(
  meetingIdValue: unknown,
  currentUser?: CurrentUserContext | null,
) {
  const prisma = await assertMeetingAccess(currentUser);
  const meetingId = requiredId(meetingIdValue, "KONTOR_MEETING_ID_REQUIRED", "Die Tagungs-ID fehlt.");
  const meeting = await prisma.kontorMeeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true,
      protocolFile: {
        select: {
          fileName: true,
          mimeType: true,
          sizeInBytes: true,
          data: true,
        },
      },
    },
  });
  if (!meeting) {
    throw new UserMutationError("KONTOR_MEETING_NOT_FOUND", "Die Tagung wurde nicht gefunden.", 404);
  }
  if (!meeting.protocolFile) {
    throw new UserMutationError(
      "KONTOR_PROTOCOL_FILE_NOT_FOUND",
      "Für diese Tagung wurde noch kein Protokoll hochgeladen.",
      404,
    );
  }

  return {
    fileName: meeting.protocolFile.fileName,
    mimeType: meeting.protocolFile.mimeType,
    sizeInBytes: meeting.protocolFile.sizeInBytes,
    data: Buffer.from(meeting.protocolFile.data),
  };
}

export async function getKontorMeetingAttendance(
  meetingIdValue: unknown,
  currentUser?: CurrentUserContext | null,
) {
  const prisma = await assertMeetingAccess(currentUser);
  const meetingId = requiredId(
    meetingIdValue,
    "KONTOR_MEETING_ID_REQUIRED",
    "Die Tagungs-ID fehlt.",
  );

  const meeting = await prisma.kontorMeeting.findUnique({
    where: { id: meetingId },
    select: { id: true, title: true, scheduledFor: true },
  });
  if (!meeting) {
    throw new UserMutationError("KONTOR_MEETING_NOT_FOUND", "Die Tagung wurde nicht gefunden.", 404);
  }

  const attendance = await prisma.kontorMeetingAttendance.findMany({
    where: { meetingId },
    select: { memberId: true, present: true, updatedAt: true },
  });

  return {
    ok: true,
    meeting: {
      id: meeting.id,
      title: meeting.title,
      scheduledFor: meeting.scheduledFor.toISOString(),
    },
    attendance: attendance.map((entry) => ({
      memberId: entry.memberId,
      present: entry.present,
      updatedAt: entry.updatedAt.toISOString(),
    })),
  };
}

export async function updateKontorMeetingAttendance(
  meetingIdValue: unknown,
  memberIdValue: unknown,
  input: UpdateAttendanceInput,
  currentUser?: CurrentUserContext | null,
) {
  const prisma = await assertMeetingAccess(currentUser);
  const meetingId = requiredId(meetingIdValue, "KONTOR_MEETING_ID_REQUIRED", "Die Tagungs-ID fehlt.");
  const memberId = requiredId(memberIdValue, "MEMBER_ID_REQUIRED", "Die Mitglieds-ID fehlt.");
  const present = booleanValue(input.present);

  const [meeting, member] = await Promise.all([
    prisma.kontorMeeting.findUnique({ where: { id: meetingId }, select: { id: true } }),
    prisma.memberProfile.findUnique({ where: { id: memberId }, select: { id: true } }),
  ]);
  if (!meeting) {
    throw new UserMutationError("KONTOR_MEETING_NOT_FOUND", "Die Tagung wurde nicht gefunden.", 404);
  }
  if (!member) {
    throw new UserMutationError("MEMBER_NOT_FOUND", "Das Mitglied wurde nicht gefunden.", 404);
  }

  const attendance = await prisma.kontorMeetingAttendance.upsert({
    where: {
      meetingId_memberId: { meetingId, memberId },
    },
    update: { present },
    create: { meetingId, memberId, present },
  });

  return {
    ok: true,
    attendance: {
      meetingId: attendance.meetingId,
      memberId: attendance.memberId,
      present: attendance.present,
      updatedAt: attendance.updatedAt.toISOString(),
    },
  };
}
