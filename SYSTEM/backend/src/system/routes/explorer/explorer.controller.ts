import type { Request, Response, NextFunction } from "express";

import {
  createArchiveDirectory,
  listArchiveDirectory,
} from "./explorer.service.js";
import {
  createLogicalArchiveFolder,
  getArchiveWorkspace,
  grantArchiveFolderAccess,
  listArchiveFolderGrants,
  listLogicalArchiveFolder,
  revokeArchiveFolderGrant,
  searchLogicalArchiveFolders,
} from "./archive-account.service.js";
import {
  downloadArchiveFile,
  listArchiveFiles,
  renameArchiveFileDisplayName,
  searchArchiveFiles,
  uploadArchiveFile,
} from "./archive-file.service.js";
import {
  approveAccountLink,
  getAccountLinkOverview,
  rejectAccountLink,
  requestAccountLink,
} from "./account-link.service.js";

function firstString(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return typeof value === "string" ? value : "";
}

function accountIdFrom(req: Request) {
  const accountId = String(req.auth?.accountId || req.user?.accountId || req.user?.id || "").trim();
  if (!accountId) {
    throw Object.assign(new Error("Nicht angemeldet."), {
      statusCode: 401,
      code: "UNAUTHENTICATED",
    });
  }
  return accountId;
}

function decodedHeader(req: Request, name: string) {
  const value = req.header(name) || "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function contentDispositionValue(fileName: string) {
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/gu, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `attachment; filename="archive-file"; filename*=UTF-8''${encoded}`;
}

export async function listArchiveDirectoryController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.json(await listArchiveDirectory(firstString(req.query.path)));
  } catch (error) {
    next(error);
  }
}

export async function createArchiveDirectoryController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await createArchiveDirectory({
      path: firstString(req.body?.path),
      name: firstString(req.body?.name),
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

export async function getArchiveWorkspaceController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.json(await getArchiveWorkspace(accountIdFrom(req)));
  } catch (error) {
    next(error);
  }
}

export async function listLogicalArchiveFolderController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const accountId = accountIdFrom(req);
    const folderId = firstString(req.params.folderId);
    const [listing, files] = await Promise.all([
      listLogicalArchiveFolder(accountId, folderId),
      listArchiveFiles(accountId, folderId),
    ]);
    res.json({ ...listing, files });
  } catch (error) {
    next(error);
  }
}

export async function uploadArchiveFileController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await uploadArchiveFile(
      accountIdFrom(req),
      firstString(req.params.folderId),
      {
        bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        originalName: decodedHeader(req, "x-archive-original-name"),
        displayName: decodedHeader(req, "x-archive-display-name"),
        mimeType: decodedHeader(req, "x-archive-content-type"),
      },
    );
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

export async function renameArchiveFileDisplayNameController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.json(await renameArchiveFileDisplayName(
      accountIdFrom(req),
      firstString(req.params.fileId),
      req.body?.displayName,
    ));
  } catch (error) {
    next(error);
  }
}

export async function downloadArchiveFileController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await downloadArchiveFile(
      accountIdFrom(req),
      firstString(req.params.fileId),
    );
    res.setHeader("Content-Type", result.mimeType);
    res.setHeader("Content-Length", String(result.bytes.length));
    res.setHeader("Content-Disposition", contentDispositionValue(result.downloadName));
    res.setHeader("Cache-Control", "private, no-store");
    res.send(result.bytes);
  } catch (error) {
    next(error);
  }
}

export async function searchArchiveWorkspaceController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const accountId = accountIdFrom(req);
    const query = firstString(req.query.q);
    const [folders, files] = await Promise.all([
      searchLogicalArchiveFolders(accountId, query),
      searchArchiveFiles(accountId, query),
    ]);
    res.json({ ok: true, query, folders, files });
  } catch (error) {
    next(error);
  }
}

export async function createLogicalArchiveFolderController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await createLogicalArchiveFolder(accountIdFrom(req), {
      parentId: req.body?.parentId,
      name: req.body?.name,
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

export async function listArchiveFolderGrantsController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.json(await listArchiveFolderGrants(
      accountIdFrom(req),
      firstString(req.params.folderId),
    ));
  } catch (error) {
    next(error);
  }
}

export async function grantArchiveFolderAccessController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await grantArchiveFolderAccess(
      accountIdFrom(req),
      firstString(req.params.folderId),
      {
        granteeAccountId: req.body?.granteeAccountId,
        preset: req.body?.preset,
        expiresAt: req.body?.expiresAt,
      },
    );
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

export async function revokeArchiveFolderGrantController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.json(await revokeArchiveFolderGrant(
      accountIdFrom(req),
      firstString(req.params.folderId),
      firstString(req.params.grantId),
    ));
  } catch (error) {
    next(error);
  }
}

export async function getAccountLinksController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.json(await getAccountLinkOverview(accountIdFrom(req)));
  } catch (error) {
    next(error);
  }
}

export async function requestAccountLinkController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.status(201).json(await requestAccountLink(accountIdFrom(req), req.body?.targetLoginName));
  } catch (error) {
    next(error);
  }
}

export async function approveAccountLinkController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.json(await approveAccountLink(accountIdFrom(req), firstString(req.params.requestId)));
  } catch (error) {
    next(error);
  }
}

export async function rejectAccountLinkController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    res.json(await rejectAccountLink(accountIdFrom(req), firstString(req.params.requestId)));
  } catch (error) {
    next(error);
  }
}
