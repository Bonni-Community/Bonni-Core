import * as fs from "node:fs/promises";
import path from "node:path";

import {
  AccountType,
  ArchiveFolderKind,
  AuditCategory,
  AuditResult,
  type ArchiveFolder,
  type ArchiveFolderGrant,
  type Prisma,
} from "@prisma/client";

import { getPrismaClient } from "../../../core/database/database.js";
import { getRunSystemArchivRoot } from "../../boot/run-system/run-system.paths.js";

type DatabaseClient = ReturnType<typeof getPrismaClient> | Prisma.TransactionClient;

export type FolderPermissions = {
  list: boolean;
  read: boolean;
  copy: boolean;
  deposit: boolean;
  write: boolean;
  manage: boolean;
  share: boolean;
  export: boolean;
};

type ArchiveServiceError = Error & {
  statusCode: number;
  code: string;
  details?: unknown;
};

export type HumanAccount = {
  id: string;
  type: AccountType;
  loginName: string;
  personId: string;
};

const HUMAN_ACCOUNT_TYPES = new Set<AccountType>([AccountType.MEMBER, AccountType.ADMIN]);
const FORBIDDEN_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function archiveError(
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): ArchiveServiceError {
  return Object.assign(new Error(message), { statusCode, code, details });
}

function normalizeFolderName(value: unknown) {
  return String(value ?? "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("de-DE");
}

function validateFolderName(value: unknown) {
  const name = String(value ?? "").trim().normalize("NFKC");
  if (!name || name.length > 128) {
    throw archiveError(400, "INVALID_FOLDER_NAME", "Der Ordnername muss 1 bis 128 Zeichen lang sein.");
  }
  if (
    name === "."
    || name === ".."
    || FORBIDDEN_NAME_CHARACTERS.test(name)
    || WINDOWS_RESERVED_NAMES.test(name)
    || /[. ]$/.test(name)
  ) {
    throw archiveError(400, "INVALID_FOLDER_NAME", "Der Ordnername enthält unzulässige Zeichen.");
  }
  return name;
}

function isHumanAccount(account: Pick<HumanAccount, "type">) {
  return HUMAN_ACCOUNT_TYPES.has(account.type);
}

function activeGrantFilter(now = new Date()) {
  return {
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  } satisfies Prisma.ArchiveFolderGrantWhereInput;
}

function ownerPermissions(folder: Pick<ArchiveFolder, "kind" | "readOnly">): FolderPermissions {
  const writable = !folder.readOnly && folder.kind !== ArchiveFolderKind.DOCUMENTS;
  const shareable = folder.kind === ArchiveFolderKind.PERSONAL || folder.kind === ArchiveFolderKind.CUSTOM;
  return {
    list: true,
    read: true,
    copy: true,
    deposit: false,
    write: writable,
    manage: writable,
    share: shareable,
    export: true,
  };
}

function grantPermissions(grant: ArchiveFolderGrant): FolderPermissions {
  return {
    list: grant.canList,
    read: grant.canRead,
    copy: grant.canCopy,
    deposit: grant.canDeposit,
    write: grant.canWrite,
    manage: grant.canManage,
    share: grant.canShare,
    export: grant.canExport,
  };
}

async function ensureHumanAccount(
  database: DatabaseClient,
  accountId: string,
): Promise<HumanAccount> {
  const account = await database.account.findUnique({
    where: { id: accountId },
    select: { id: true, type: true, loginName: true, isActive: true, personId: true },
  });

  if (!account?.isActive) {
    throw archiveError(401, "ARCHIVE_ACCOUNT_INACTIVE", "Der Benutzerzugang ist nicht aktiv.");
  }
  if (!isHumanAccount(account)) {
    throw archiveError(
      403,
      "ARCHIVE_HUMAN_ACCOUNT_REQUIRED",
      "Persönliche Archivordner stehen nur menschlichen lokalen Konten zur Verfügung.",
    );
  }
  if (!account.personId) {
    throw archiveError(409, "ARCHIVE_PERSON_REQUIRED", "Dieser Account ist noch keinem Benutzer zugeordnet.");
  }
  return { ...account, personId: account.personId };
}

async function writeAudit(
  database: DatabaseClient,
  data: {
    event: string;
    accountId: string;
    targetType: string;
    targetId: string;
    metadata?: Prisma.InputJsonValue;
  },
) {
  await database.auditLog.create({
    data: {
      category: AuditCategory.DATA,
      event: data.event,
      result: AuditResult.SUCCESS,
      accountId: data.accountId,
      targetType: data.targetType,
      targetId: data.targetId,
      metadataJson: data.metadata,
    },
  });
}

async function upsertProvisionedFolder(
  transaction: Prisma.TransactionClient,
  input: {
    provisionKey: string;
    ownerPersonId: string;
    createdByAccountId: string;
    parentId?: string | null;
    name: string;
    kind: ArchiveFolderKind;
    readOnly: boolean;
  },
) {
  return transaction.archiveFolder.upsert({
    where: { provisionKey: input.provisionKey },
    update: {
      ownerPersonId: input.ownerPersonId,
      parentId: input.parentId ?? null,
      name: input.name,
      normalizedName: normalizeFolderName(input.name),
      kind: input.kind,
      readOnly: input.readOnly,
      systemManaged: true,
      deletedAt: null,
    },
    create: {
      provisionKey: input.provisionKey,
      ownerPersonId: input.ownerPersonId,
      parentId: input.parentId ?? null,
      name: input.name,
      normalizedName: normalizeFolderName(input.name),
      kind: input.kind,
      readOnly: input.readOnly,
      systemManaged: true,
      createdByAccountId: input.createdByAccountId,
    },
  });
}

export async function provisionAccountArchive(
  transaction: Prisma.TransactionClient,
  account: HumanAccount,
) {
  if (!isHumanAccount(account)) return null;

  const rootKey = `person:${account.personId}:root`;
  const existed = await transaction.archiveFolder.findUnique({
    where: { provisionKey: rootKey },
    select: { id: true },
  });
  const root = await upsertProvisionedFolder(transaction, {
    provisionKey: rootKey,
    ownerPersonId: account.personId,
    createdByAccountId: account.id,
    name: "Benutzerarchiv",
    kind: ArchiveFolderKind.ACCOUNT_ROOT,
    readOnly: false,
  });
  const personal = await upsertProvisionedFolder(transaction, {
    provisionKey: `person:${account.personId}:personal`,
    ownerPersonId: account.personId,
    createdByAccountId: account.id,
    parentId: root.id,
    name: "Persönlich",
    kind: ArchiveFolderKind.PERSONAL,
    readOnly: false,
  });
  const documents = await upsertProvisionedFolder(transaction, {
    provisionKey: `person:${account.personId}:documents`,
    ownerPersonId: account.personId,
    createdByAccountId: account.id,
    parentId: root.id,
    name: "Dokumente",
    kind: ArchiveFolderKind.DOCUMENTS,
    readOnly: true,
  });

  if (!existed) {
    await writeAudit(transaction, {
      event: "ARCHIVE_ACCOUNT_PROVISIONED",
      accountId: account.id,
      targetType: "ArchiveFolder",
      targetId: root.id,
      metadata: { personalFolderId: personal.id, documentsFolderId: documents.id },
    });
  }

  return { root, personal, documents };
}

async function ensurePhysicalStorage(folders: Array<Pick<ArchiveFolder, "storageKey">>) {
  const archiveRoot = path.resolve(getRunSystemArchivRoot());
  await Promise.all(folders.map(async (folder) => {
    const prefix = folder.storageKey.slice(0, 2) || "00";
    await fs.mkdir(path.join(archiveRoot, "objects", prefix, folder.storageKey), {
      recursive: true,
      mode: 0o700,
    });
  }));
}

export async function ensureAccountArchive(accountId: string) {
  const prisma = getPrismaClient();
  const account = await ensureHumanAccount(prisma, accountId);
  const provisioned = await prisma.$transaction((transaction) => (
    provisionAccountArchive(transaction, account)
  ));
  if (provisioned) {
    await ensurePhysicalStorage([
      provisioned.root,
      provisioned.personal,
      provisioned.documents,
    ]).catch((error) => {
      console.warn("Archivspeicher konnte noch nicht vorbereitet werden", {
        accountId,
        error: error instanceof Error ? error.message : error,
      });
    });
  }
  return provisioned ? { ...provisioned, account } : null;
}

async function resolveFolderAccess(
  database: DatabaseClient,
  account: HumanAccount,
  folder: ArchiveFolder,
) {
  if (folder.ownerPersonId === account.personId) {
    return { permissions: ownerPermissions(folder), grant: null as ArchiveFolderGrant | null };
  }

  let current: Pick<ArchiveFolder, "id" | "parentId"> | null = folder;
  for (let depth = 0; current && depth < 64; depth += 1) {
    const grant = await database.archiveFolderGrant.findFirst({
      where: {
        folderId: current.id,
        granteePersonId: account.personId,
        ...activeGrantFilter(),
      },
    });
    if (grant) return { permissions: grantPermissions(grant), grant };
    if (!current.parentId) break;
    current = await database.archiveFolder.findFirst({
      where: { id: current.parentId, deletedAt: null },
      select: { id: true, parentId: true },
    });
  }

  throw archiveError(403, "ARCHIVE_ACCESS_DENIED", "Für diesen Archivordner fehlt die Berechtigung.");
}

function serializeFolder(
  folder: ArchiveFolder & {
    ownerPerson?: {
      id: string;
      displayName: string;
      accounts?: Array<{ id: string; loginName: string }>;
    };
  },
  permissions: FolderPermissions,
  shared = false,
) {
  return {
    id: folder.id,
    parentId: folder.parentId,
    name: folder.name,
    kind: folder.kind,
    readOnly: folder.readOnly,
    systemManaged: folder.systemManaged,
    shared,
    owner: folder.ownerPerson ? {
      personId: folder.ownerPerson.id,
      accountId: folder.ownerPerson.accounts?.[0]?.id || null,
      loginName: folder.ownerPerson.accounts?.[0]?.loginName || "",
      displayName: folder.ownerPerson.displayName,
    } : null,
    permissions,
    updatedAt: folder.updatedAt.toISOString(),
  };
}

const folderOwnerInclude = {
  ownerPerson: {
    select: {
      id: true,
      displayName: true,
      accounts: {
        where: { isActive: true, type: { in: [AccountType.MEMBER, AccountType.ADMIN] } },
        select: { id: true, loginName: true },
        orderBy: [{ personAccountRole: "asc" }, { createdAt: "asc" }],
        take: 1,
      },
    },
  },
} satisfies Prisma.ArchiveFolderInclude;

export async function getArchiveFolderAccessContext(accountId: string, folderId: string) {
  const prisma = getPrismaClient();
  const account = await ensureHumanAccount(prisma, accountId);
  const folder = await prisma.archiveFolder.findFirst({
    where: { id: folderId, deletedAt: null },
    include: folderOwnerInclude,
  });
  if (!folder) {
    throw archiveError(404, "ARCHIVE_FOLDER_NOT_FOUND", "Der Archivordner wurde nicht gefunden.");
  }
  const access = await resolveFolderAccess(prisma, account, folder);
  return { prisma, account, folder, permissions: access.permissions };
}

export async function searchLogicalArchiveFolders(accountId: string, query: unknown) {
  const prisma = getPrismaClient();
  const account = await ensureHumanAccount(prisma, accountId);
  const normalizedQuery = normalizeFolderName(query);
  if (normalizedQuery.length < 2) return [];

  const candidates = await prisma.archiveFolder.findMany({
    where: {
      deletedAt: null,
      kind: { not: ArchiveFolderKind.ACCOUNT_ROOT },
      normalizedName: { contains: normalizedQuery },
    },
    include: folderOwnerInclude,
    orderBy: { updatedAt: "desc" },
    take: 80,
  });

  const visible = [];
  for (const folder of candidates) {
    try {
      const access = await resolveFolderAccess(prisma, account, folder);
      if (access.permissions.list || access.permissions.read) {
        visible.push(serializeFolder(
          folder,
          access.permissions,
          folder.ownerPersonId !== account.personId,
        ));
      }
    } catch (error: any) {
      if (error?.code !== "ARCHIVE_ACCESS_DENIED") throw error;
    }
  }

  return visible;
}

export async function getArchiveWorkspace(accountId: string) {
  const prisma = getPrismaClient();
  const provisioned = await ensureAccountArchive(accountId);
  if (!provisioned) {
    throw archiveError(403, "ARCHIVE_HUMAN_ACCOUNT_REQUIRED", "Für diesen Zugang gibt es kein persönliches Archiv.");
  }

  const [roots, grants, shareTargets] = await Promise.all([
    prisma.archiveFolder.findMany({
      where: { parentId: provisioned.root.id, deletedAt: null },
      include: folderOwnerInclude,
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    }),
    prisma.archiveFolderGrant.findMany({
      where: { granteePersonId: provisioned.account.personId, ...activeGrantFilter() },
      include: { folder: { include: folderOwnerInclude } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.person.findMany({
      where: {
        id: { not: provisioned.account.personId },
        accounts: {
          some: {
            isActive: true,
            type: { in: [AccountType.MEMBER, AccountType.ADMIN] },
          },
        },
      },
      select: {
        id: true,
        displayName: true,
        accounts: {
          where: { isActive: true, type: { in: [AccountType.MEMBER, AccountType.ADMIN] } },
          select: { id: true, loginName: true },
          orderBy: [{ personAccountRole: "asc" }, { createdAt: "asc" }],
          take: 1,
        },
      },
      orderBy: { displayName: "asc" },
    }),
  ]);

  return {
    ok: true,
    accountId,
    roots: roots.map((folder) => serializeFolder(folder, ownerPermissions(folder))),
    shared: grants
      .filter((grant) => !grant.folder.deletedAt)
      .map((grant) => serializeFolder(grant.folder, grantPermissions(grant), true)),
    shareTargets: shareTargets.flatMap((person) => person.accounts[0] ? [{
      personId: person.id,
      accountId: person.accounts[0].id,
      loginName: person.accounts[0].loginName,
      displayName: person.displayName,
    }] : []),
  };
}

export async function listLogicalArchiveFolder(accountId: string, folderId: string) {
  const prisma = getPrismaClient();
  const account = await ensureHumanAccount(prisma, accountId);
  const folder = await prisma.archiveFolder.findFirst({
    where: { id: folderId, deletedAt: null },
    include: folderOwnerInclude,
  });
  if (!folder) throw archiveError(404, "ARCHIVE_FOLDER_NOT_FOUND", "Der Archivordner wurde nicht gefunden.");
  const access = await resolveFolderAccess(prisma, account, folder);
  if (!access.permissions.list && !access.permissions.read) {
    throw archiveError(403, "ARCHIVE_LIST_DENIED", "Dieser Archivordner darf nicht aufgelistet werden.");
  }

  const children = await prisma.archiveFolder.findMany({
    where: { parentId: folder.id, deletedAt: null },
    include: folderOwnerInclude,
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });

  return {
    ok: true,
    folder: serializeFolder(folder, access.permissions, folder.ownerPersonId !== account.personId),
    parentId: folder.parentId,
    entries: children.map((child) => serializeFolder(
      child,
      folder.ownerPersonId === account.personId ? ownerPermissions(child) : access.permissions,
      child.ownerPersonId !== account.personId,
    )),
  };
}

export async function createLogicalArchiveFolder(
  accountId: string,
  input: { parentId?: unknown; name?: unknown },
) {
  const prisma = getPrismaClient();
  const context = await ensureAccountArchive(accountId);
  if (!context) throw archiveError(403, "ARCHIVE_HUMAN_ACCOUNT_REQUIRED", "Für diesen Zugang gibt es kein persönliches Archiv.");
  const parentId = String(input.parentId || "").trim();
  const name = validateFolderName(input.name);
  const parent = await prisma.archiveFolder.findFirst({
    where: { id: parentId, deletedAt: null },
  });
  if (!parent) throw archiveError(404, "ARCHIVE_FOLDER_NOT_FOUND", "Der Zielordner wurde nicht gefunden.");
  const access = await resolveFolderAccess(prisma, context.account, parent);
  if (parent.readOnly || parent.kind === ArchiveFolderKind.DOCUMENTS || !access.permissions.write) {
    throw archiveError(
      403,
      "ARCHIVE_FOLDER_READ_ONLY",
      "In diesem Ordner dürfen keine Unterordner angelegt werden.",
    );
  }

  try {
    const created = await prisma.$transaction(async (transaction) => {
      const folder = await transaction.archiveFolder.create({
        data: {
          parentId: parent.id,
          ownerPersonId: parent.ownerPersonId,
          createdByAccountId: accountId,
          name,
          normalizedName: normalizeFolderName(name),
          kind: ArchiveFolderKind.CUSTOM,
        },
        include: folderOwnerInclude,
      });
      await writeAudit(transaction, {
        event: "ARCHIVE_FOLDER_CREATED",
        accountId,
        targetType: "ArchiveFolder",
        targetId: folder.id,
        metadata: { parentId: parent.id, ownerPersonId: parent.ownerPersonId },
      });
      return folder;
    });
    await ensurePhysicalStorage([created]).catch(() => undefined);
    return { ok: true, folder: serializeFolder(created, ownerPermissions(created)) };
  } catch (error: any) {
    if (error?.code === "P2002") {
      throw archiveError(409, "ARCHIVE_FOLDER_EXISTS", "Ein Ordner mit diesem Namen existiert bereits.");
    }
    throw error;
  }
}

function grantPreset(value: unknown) {
  const preset = String(value || "read").trim().toLowerCase();
  if (preset === "exchange") {
    return {
      canList: true,
      canRead: true,
      canCopy: true,
      canDeposit: true,
      canWrite: true,
      canManage: false,
      canShare: false,
      canExport: true,
    };
  }
  return {
    canList: true,
    canRead: true,
    canCopy: true,
    canDeposit: false,
    canWrite: false,
    canManage: false,
    canShare: false,
    canExport: true,
  };
}

export async function grantArchiveFolderAccess(
  accountId: string,
  folderId: string,
  input: { granteeAccountId?: unknown; preset?: unknown; expiresAt?: unknown },
) {
  const prisma = getPrismaClient();
  const context = await ensureAccountArchive(accountId);
  if (!context) throw archiveError(403, "ARCHIVE_HUMAN_ACCOUNT_REQUIRED", "Für diesen Zugang gibt es kein persönliches Archiv.");
  const folder = await prisma.archiveFolder.findFirst({ where: { id: folderId, deletedAt: null } });
  if (!folder) throw archiveError(404, "ARCHIVE_FOLDER_NOT_FOUND", "Der Archivordner wurde nicht gefunden.");
  if (folder.ownerPersonId !== context.account.personId) {
    throw archiveError(403, "ARCHIVE_SHARE_OWNER_REQUIRED", "Nur der Eigentümer darf diesen Ordner freigeben.");
  }
  if (folder.kind !== ArchiveFolderKind.PERSONAL && folder.kind !== ArchiveFolderKind.CUSTOM) {
    throw archiveError(403, "ARCHIVE_FOLDER_NOT_SHAREABLE", "Dieser Systemordner kann nicht freigegeben werden.");
  }

  const granteeAccountId = String(input.granteeAccountId || "").trim();
  if (!granteeAccountId || granteeAccountId === accountId) {
    throw archiveError(400, "ARCHIVE_GRANTEE_INVALID", "Bitte einen anderen Benutzer auswählen.");
  }
  const grantee = await ensureHumanAccount(prisma, granteeAccountId);
  if (grantee.personId === context.account.personId) {
    throw archiveError(400, "ARCHIVE_GRANTEE_INVALID", "Dieser Account gehört bereits zum selben Benutzer.");
  }
  const expiresAt = input.expiresAt ? new Date(String(input.expiresAt)) : null;
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) {
    throw archiveError(400, "ARCHIVE_EXPIRY_INVALID", "Das Ablaufdatum muss in der Zukunft liegen.");
  }
  const permissions = grantPreset(input.preset);

  const grant = await prisma.$transaction(async (transaction) => {
    const saved = await transaction.archiveFolderGrant.upsert({
      where: { folderId_granteePersonId: { folderId, granteePersonId: grantee.personId } },
      update: {
        ...permissions,
        expiresAt,
        revokedAt: null,
        grantedByAccountId: accountId,
      },
      create: {
        folderId,
        granteePersonId: grantee.personId,
        grantedByAccountId: accountId,
        expiresAt,
        ...permissions,
      },
    });
    await writeAudit(transaction, {
      event: "ARCHIVE_FOLDER_SHARED",
      accountId,
      targetType: "ArchiveFolderGrant",
      targetId: saved.id,
      metadata: {
        folderId,
        granteeAccountId,
        granteePersonId: grantee.personId,
        preset: String(input.preset || "read"),
      },
    });
    return saved;
  });

  return { ok: true, grant: { ...grant, permissions: grantPermissions(grant) } };
}

export async function listArchiveFolderGrants(accountId: string, folderId: string) {
  const prisma = getPrismaClient();
  const account = await ensureHumanAccount(prisma, accountId);
  const folder = await prisma.archiveFolder.findFirst({ where: { id: folderId, deletedAt: null } });
  if (!folder) throw archiveError(404, "ARCHIVE_FOLDER_NOT_FOUND", "Der Archivordner wurde nicht gefunden.");
  if (folder.ownerPersonId !== account.personId) {
    throw archiveError(403, "ARCHIVE_SHARE_OWNER_REQUIRED", "Nur der Eigentümer darf Freigaben verwalten.");
  }
  const grants = await prisma.archiveFolderGrant.findMany({
    where: { folderId, ...activeGrantFilter() },
    include: {
      granteePerson: {
        select: {
          id: true,
          displayName: true,
          accounts: {
            where: { isActive: true, type: { in: [AccountType.MEMBER, AccountType.ADMIN] } },
            select: { id: true, loginName: true },
            orderBy: [{ personAccountRole: "asc" }, { createdAt: "asc" }],
            take: 1,
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return {
    ok: true,
    grants: grants.map((grant) => ({
      id: grant.id,
      grantee: grant.granteePerson.accounts[0] ? {
        personId: grant.granteePerson.id,
        accountId: grant.granteePerson.accounts[0].id,
        loginName: grant.granteePerson.accounts[0].loginName,
        displayName: grant.granteePerson.displayName,
      } : {
        personId: grant.granteePerson.id,
        accountId: null,
        loginName: "",
        displayName: grant.granteePerson.displayName,
      },
      permissions: grantPermissions(grant),
      expiresAt: grant.expiresAt?.toISOString() || null,
      createdAt: grant.createdAt.toISOString(),
    })),
  };
}

export async function revokeArchiveFolderGrant(
  accountId: string,
  folderId: string,
  grantId: string,
) {
  const prisma = getPrismaClient();
  const account = await ensureHumanAccount(prisma, accountId);
  const grant = await prisma.archiveFolderGrant.findFirst({
    where: { id: grantId, folderId },
    include: { folder: true },
  });
  if (!grant) throw archiveError(404, "ARCHIVE_GRANT_NOT_FOUND", "Die Freigabe wurde nicht gefunden.");
  if (grant.folder.ownerPersonId !== account.personId) {
    throw archiveError(403, "ARCHIVE_SHARE_OWNER_REQUIRED", "Nur der Eigentümer darf die Freigabe entziehen.");
  }
  const revoked = await prisma.$transaction(async (transaction) => {
    const saved = await transaction.archiveFolderGrant.update({
      where: { id: grant.id },
      data: { revokedAt: new Date() },
    });
    await writeAudit(transaction, {
      event: "ARCHIVE_FOLDER_SHARE_REVOKED",
      accountId,
      targetType: "ArchiveFolderGrant",
      targetId: saved.id,
      metadata: { folderId, granteePersonId: saved.granteePersonId },
    });
    return saved;
  });
  return { ok: true, revoked: true, grantId: revoked.id };
}
