import { createHmac } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

export const NFC_SECURITY_LEVEL = "IDENTIFICATION_ONLY" as const;
export const NFC_ASSURANCE = "identification-only" as const;

export class NfcError extends Error {
  constructor(public code: string, public statusCode = 400) { super(code); }
}

export function normalizeNfcCode(input: unknown): string {
  if (typeof input !== "string" || input.length > 128) throw new NfcError("NFC_CODE_INVALID");
  const text = input.trim().replace(/^BONNI:NFC:/i, "");
  // Keep leading zeroes; never guess decimal/hex conversions between readers.
  const uid = text.replace(/[:-]/g, "");
  if (/^[0-9a-f]{8,20}$/i.test(uid) && uid.length % 2 === 0) return uid.toUpperCase();
  throw new NfcError("NFC_CODE_INVALID");
}

export function nfcHash(input: unknown, key: string) {
  if (key.length < 16) throw new NfcError("NFC_KEY_UNAVAILABLE", 503);
  return createHmac("sha256", key).update(`bonni:member-medium:v1:${normalizeMemberCode(input)}`).digest("hex");
}

export function normalizeMemberCode(input: unknown) {
  if (typeof input === "string" && /^BONNI:MEMBER:/i.test(input)) {
    const code = input.slice("BONNI:MEMBER:".length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/.test(code)) throw new NfcError("NFC_CODE_INVALID");
    return `barcode:${code}`;
  }
  return `nfc:${normalizeNfcCode(input)}`;
}

export function registrationCode(code: string, kind: "NFC" | "BARCODE") {
  if (kind === "BARCODE") return /^BONNI:MEMBER:/i.test(code) ? code : `BONNI:MEMBER:${code}`;
  if (/^BONNI:MEMBER:/i.test(code)) throw new NfcError("NFC_CODE_INVALID");
  return code;
}

export type NfcActor = { accountId: string; roles: readonly string[]; permissions: readonly string[] };
export type NfcIdentity = Readonly<{
  memberId: string;
  personId: string;
  accountId: string | null;
  displayName: string;
  assurance: typeof NFC_ASSURANCE;
  securityLevel: typeof NFC_SECURITY_LEVEL;
}>;

function moduleAccessKey(moduleKey: string, profile: string) {
  const [kindValue] = moduleKey.split(".", 1);
  const kind = kindValue === "addon" ? "add-on" : kindValue === "plugin" ? "plug-in" : kindValue;
  const moduleSlug = moduleKey.replaceAll(".", "-");
  return {
    role: `access:${kind}:${moduleSlug}:${profile}`,
    permission: `module.${moduleSlug}.${profile}`,
  };
}

export function canIdentifyNfc(actor: NfcActor, moduleKey?: string, accessProfiles: readonly string[] = []) {
  const roles = Array.isArray(actor?.roles) ? actor.roles : [];
  const permissions = Array.isArray(actor?.permissions) ? actor.permissions : [];
  const normalizedRoles = new Set(roles.map(role => String(role).toLowerCase()));
  const normalizedPermissions = new Set(permissions.map(permission => String(permission).toLowerCase()));
  const admin = roles.some(role => ["ADMIN", "SYSTEM_ADMIN", "SYSTEM.ADMIN"].includes(String(role).toUpperCase()));
  if (admin || normalizedPermissions.has("auth.nfc.identify")) return true;
  if (!moduleKey && normalizedPermissions.has("auth.users.write")) return true;

  // The installed-module binding and its explicitly declared NFC profiles are
  // supplied by Core, never by the request or by the scanner application.
  if (moduleKey && accessProfiles.length) {
    return accessProfiles.some(profile => {
      const access = moduleAccessKey(moduleKey, String(profile).trim().toLowerCase());
      return normalizedRoles.has(access.role) || normalizedPermissions.has(access.permission);
    });
  }

  // Compatibility for the already released StüberlApp contract. New modules
  // must use an explicit nfcAccessProfiles declaration instead.
  return moduleKey === "app.stueberlapp" && (
    normalizedRoles.has("access:app:app-stueberlapp:barkeeper")
    || normalizedPermissions.has("module.app-stueberlapp.barkeeper")
  );
}

const publicFields = {
  id: true, memberId: true, loginAccountId: true, label: true, kind: true,
  createdAt: true, revokedAt: true, lastUsedAt: true,
} as const;

// Bounded, short-lived abuse guard. No raw tag identifiers are retained.
export function createNfcRateLimiter(now = Date.now) {
  const windows = new Map<string, { until: number; count: number }>();
  return (key: string, maximum = 30) => {
    const time = now();
    for (const [id, value] of windows) if (value.until <= time) windows.delete(id);
    let entry = windows.get(key);
    if (!entry) {
      if (windows.size >= 5000) throw new NfcError("NFC_TRY_LATER", 429);
      entry = { until: time + 60_000, count: 0 };
      windows.set(key, entry);
    }
    if (++entry.count > maximum) throw new NfcError("NFC_TRY_LATER", 429);
  };
}

export function createNfcService(db: PrismaClient, hashKey: string) {
  const limit = createNfcRateLimiter();
  async function audit(tx: Prisma.TransactionClient, event: string, actorId: string | null, tagId: string, result: "SUCCESS" | "DENIED" = "SUCCESS") {
    await tx.auditLog.create({ data: {
      category: "SECURITY", event, result, accountId: actorId,
      targetType: "SecurityNfcTag", targetId: tagId,
    } });
  }
  async function usableTag(tx: Prisma.TransactionClient, code: unknown) {
    const tag = await tx.securityNfcTag.findUnique({
      where: { codeHash: nfcHash(code, hashKey) },
      include: { member: { include: { person: true } }, loginAccount: true },
    });
    if (!tag || tag.revokedAt || tag.member.status === "FORMER_MEMBER" || tag.member.membershipStatus === "RESIGNED"
      || (tag.loginAccount && (!tag.loginAccount.isActive || tag.loginAccount.passwordRecoveryLockedAt
        || tag.loginAccount.personId !== tag.member.personId))) {
      throw new NfcError("NFC_NOT_AVAILABLE", 403);
    }
    return tag;
  }
  return Object.freeze({
    list(memberId: string) {
      return db.$transaction(tx => tx.securityNfcTag.findMany({
        where: { memberId }, select: publicFields, orderBy: { createdAt: "desc" },
      }));
    },
    async register(memberId: string, input: { code: string; label: string; kind?: "NFC" | "BARCODE"; loginAccountId?: string | null }, actorId: string) {
      const kind = input.kind || "NFC";
      const codeHash = nfcHash(registrationCode(input.code, kind), hashKey);
      const label = input.label.trim();
      if (!label || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw new NfcError("NFC_LABEL_INVALID");
      try {
        return await db.$transaction(async tx => {
          const member = await tx.memberProfile.findUnique({ where: { id: memberId } });
          if (!member || member.status === "FORMER_MEMBER" || member.membershipStatus === "RESIGNED") throw new NfcError("NFC_MEMBER_UNAVAILABLE", 404);
          if (input.loginAccountId) {
            const account = await tx.account.findUnique({ where: { id: input.loginAccountId } });
            if (!account?.isActive || account.personId !== member.personId || account.passwordRecoveryLockedAt
              || !["MEMBER", "ADMIN"].includes(account.type)) throw new NfcError("NFC_ACCOUNT_INVALID");
          }
          if (await tx.securityNfcTag.count({ where: { memberId, revokedAt: null } }) >= 20) throw new NfcError("NFC_TAG_LIMIT", 409);
          const tag = await tx.securityNfcTag.create({ data: {
            memberId, codeHash, label, kind, loginAccountId: input.loginAccountId || null, createdBy: actorId,
          }, select: publicFields });
          await audit(tx, "NFC_REGISTERED", actorId, tag.id);
          return tag;
        }, { isolationLevel: "Serializable" });
      } catch (error: any) {
        if (error?.code === "P2002") throw new NfcError("NFC_ALREADY_ASSIGNED", 409);
        throw error;
      }
    },
    revoke(memberId: string, tagId: string, actorId: string) {
      return db.$transaction(async tx => {
        const tag = await tx.securityNfcTag.findFirst({ where: { id: tagId, memberId } });
        if (!tag) throw new NfcError("NFC_NOT_FOUND", 404);
        if (tag.revokedAt) return { ok: true };
        await tx.securityNfcTag.update({ where: { id: tag.id }, data: { revokedAt: new Date(), revokedBy: actorId } });
        await audit(tx, "NFC_REVOKED", actorId, tag.id);
        return { ok: true };
      });
    },
    async identify(code: unknown, actor: NfcActor, moduleKey?: string, accessProfiles: readonly string[] = []): Promise<NfcIdentity> {
      if (!actor?.accountId) throw new NfcError("NFC_UNAUTHENTICATED", 401);
      if (!canIdentifyNfc(actor, moduleKey, accessProfiles)) throw new NfcError("NFC_FORBIDDEN", 403);
      limit(`actor:${actor.accountId}`);
      return db.$transaction(async tx => {
        const tag = await usableTag(tx, code);
        // Re-check revocation when updating, including a concurrent revoke.
        const updated = await tx.securityNfcTag.updateMany({ where: { id: tag.id, revokedAt: null }, data: { lastUsedAt: new Date() } });
        if (updated.count !== 1) throw new NfcError("NFC_NOT_AVAILABLE", 403);
        await audit(tx, "NFC_IDENTIFIED", actor.accountId, tag.id);
        return Object.freeze({
          memberId: tag.memberId, personId: tag.member.personId,
          accountId: tag.loginAccountId, displayName: tag.member.person.displayName,
          assurance: NFC_ASSURANCE,
          securityLevel: NFC_SECURITY_LEVEL,
        });
      });
    },
    // Returns an account locator only. Caller MUST still check the password,
    // account locks and existing MFA via the ordinary Core login flow.
    async loginLocator(code: unknown, ip: string) {
      limit(`login:${ip}`, 10);
      return db.$transaction(async tx => {
        const tag = await usableTag(tx, code);
        if (!tag.loginAccount || !["MEMBER", "ADMIN"].includes(tag.loginAccount.type)) throw new NfcError("NFC_NOT_AVAILABLE", 403);
        const updated = await tx.securityNfcTag.updateMany({ where: { id: tag.id, revokedAt: null }, data: { lastUsedAt: new Date() } });
        if (updated.count !== 1) throw new NfcError("NFC_NOT_AVAILABLE", 403);
        await audit(tx, "MEMBER_MEDIUM_LOGIN_PRESENTED", null, tag.id);
        return { tagId: tag.id, accountId: tag.loginAccount.id, loginName: tag.loginAccount.loginName };
      });
    },
  });
}
