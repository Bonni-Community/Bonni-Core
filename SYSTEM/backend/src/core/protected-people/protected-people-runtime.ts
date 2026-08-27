import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

import { env } from "../config/env.js";
import {
  getVerifiedRequestIdentity,
  getVerifiedRequestSessionAssurance,
} from "../../platform/auth/request-identity/request-identity-context.js";
import {
  consumeVerifiedChallenge,
  getStatus as getTwoFactorStatus,
} from "../modules/security/two-factor/service.js";
import { decryptAes256GcmToUtf8, encryptAes256Gcm } from "../../platform/security/crypto/symmetric.js";
import {
  deleteProtectedDocument,
  readProtectedDocument,
  storeProtectedDocument,
} from "../protected-documents/protected-document-storage.js";

export const PROTECTED_PEOPLE_CONTRACT_VERSION = "bonni.protected-people/v1" as const;
const PRIVATE_PURPOSE = "MODULE_PRIVATE_DATA_ACCESS";
const CIPHERTEXT_PREFIX = "people1";
const MAX_GRANT_MINUTES = 10;
const KONTOR_MANAGER_PRIVATE_PURPOSE = "KONTOR.MANAGER.PRIVATE_DATA";
const KONTOR_MEMBER_PAYMENT_PURPOSE = "KONTOR.MEMBER.PRIVATE_PAYMENT";
const SESSION_MFA_ACCESS_TOKEN = "bonni-session-mfa-v1";

const moduleCapabilities = Object.freeze({
  "app.kontorapp": new Set(["ADDRESS", "BANK", "SEPA", "EMERGENCY", "DOCUMENTS"]),
  "app.stueberlapp": new Set(["ADDRESS"]),
});

type ProtectedPeopleRuntimeOptions = {
  getTwoFactorStatus?: typeof getTwoFactorStatus;
  consumeVerifiedChallenge?: typeof consumeVerifiedChallenge;
};

function fail(code: string, statusCode = 400): never {
  throw Object.assign(new Error(code), { code, statusCode });
}

function text(value: unknown, max = 180) {
  return String(value ?? "").trim().slice(0, max);
}

function moduleKey(value: unknown) {
  const result = text(value, 160).toLowerCase();
  if (!/^(app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]$/.test(result)) {
    fail("PROTECTED_PEOPLE_MODULE_KEY_INVALID", 500);
  }
  return result;
}

function identity() {
  const current = getVerifiedRequestIdentity();
  if (!current?.accountId) fail("PROTECTED_PEOPLE_REQUEST_IDENTITY_REQUIRED", 401);
  return current;
}

function capability(boundModuleKey: string, value: unknown) {
  const result = text(value, 40).toUpperCase();
  if (!moduleCapabilities[boundModuleKey as keyof typeof moduleCapabilities]?.has(result)) {
    fail(`PROTECTED_PEOPLE_CAPABILITY_DENIED:${result}`, 403);
  }
  return result;
}

function purpose(value: unknown) {
  const result = text(value, 120).toUpperCase();
  if (!/^[A-Z][A-Z0-9._:-]{2,119}$/.test(result)) fail("PROTECTED_PEOPLE_PURPOSE_INVALID");
  return result;
}

function canonicalAccessScope(normalizedPurpose: string) {
  if (normalizedPurpose === KONTOR_MANAGER_PRIVATE_PURPOSE) return "ACCOUNTING_PAYMENT";
  if (normalizedPurpose === KONTOR_MEMBER_PAYMENT_PURPOSE) return "SELF_PAYMENT";
  fail("PROTECTED_PEOPLE_PURPOSE_SCOPE_UNSUPPORTED", 403);
}

function key(subjectId: string) {
  return createHmac("sha256", env.MASTER_KEY)
    .update("bonni:protected-people:v1")
    .update("\u0000")
    .update(subjectId)
    .digest();
}

function aad(subjectId: string, recordType: string, field: string) {
  return ["bonni.protected-people/v1", subjectId, recordType, field].join("|");
}

function encrypt(subjectId: string, recordType: string, field: string, value: unknown) {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (!normalized) return null;
  return `${CIPHERTEXT_PREFIX}.${encryptAes256Gcm(normalized, key(subjectId), aad(subjectId, recordType, field))}`;
}

function decrypt(subjectId: string, recordType: string, field: string, value: unknown) {
  if (!value) return null;
  const serialized = String(value);
  if (!serialized.startsWith(`${CIPHERTEXT_PREFIX}.`)) fail("PROTECTED_PEOPLE_CIPHERTEXT_INVALID", 500);
  return decryptAes256GcmToUtf8(
    serialized.slice(CIPHERTEXT_PREFIX.length + 1),
    key(subjectId),
    aad(subjectId, recordType, field),
  );
}

function tokenHash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fingerprint(value: unknown) {
  const normalized = String(value ?? "").replace(/\s+/g, "").toUpperCase();
  return createHmac("sha256", env.MASTER_KEY)
    .update("bonni:protected-people:fingerprint:v1")
    .update("\u0000")
    .update(normalized)
    .digest("hex");
}

async function personForMember(core: PrismaClient, memberIdValue: unknown) {
  const memberId = text(memberIdValue);
  if (!memberId) fail("PROTECTED_PEOPLE_MEMBER_ID_REQUIRED");
  const member = await core.memberProfile.findUnique({
    where: { id: memberId },
    select: { id: true, personId: true },
  });
  if (!member) fail("PROTECTED_PEOPLE_MEMBER_NOT_FOUND", 404);
  return member;
}

async function audit(
  privacy: PrismaClient,
  boundModuleKey: string,
  input: {
    capability: string;
    purpose: string;
    operation: string;
    subjectId?: string | null;
    recordType?: string | null;
    recordId?: string | null;
    decision?: "ALLOWED" | "DENIED";
    reason?: string | null;
    metadataJson?: Record<string, unknown> | null;
  },
) {
  const current = getVerifiedRequestIdentity();
  await privacy.protectedDataAccessLog.create({
    data: {
      accountId: current?.accountId || null,
      moduleKey: boundModuleKey,
      dataDomain: "people",
      purpose: input.purpose,
      operation: input.operation,
      subjectId: input.subjectId || null,
      recordType: input.recordType || null,
      recordId: input.recordId || null,
      decision: input.decision || "ALLOWED",
      reason: input.reason || null,
      metadataJson: (input.metadataJson || {
        capability: input.capability,
      }) as Prisma.InputJsonValue,
    },
  });
}

export function createModuleProtectedPeopleRuntime(
  moduleKeyValue: string,
  core: PrismaClient,
  people: PrismaClient,
  privacy: PrismaClient,
  options: ProtectedPeopleRuntimeOptions = {},
) {
  const boundModuleKey = moduleKey(moduleKeyValue);
  const readTwoFactorStatus = options.getTwoFactorStatus || getTwoFactorStatus;
  const consumeChallenge = options.consumeVerifiedChallenge || consumeVerifiedChallenge;

  async function twoFactorProtectionState(accountId: string) {
    const status = await readTwoFactorStatus(accountId);
    const available = status.enabled === true
      && status.available === true
      && status.provider?.configured === true
      && status.provider?.available !== false;
    return {
      available,
      enrolled: status.privateDataProtectionEnrolled === true || status.enabled === true,
      providerId: String(status.provider?.id || "").trim().toLowerCase(),
      credentialRevision: Number(status.credentialRevision ?? -1),
    };
  }

  function publicDocument(personId: string, row: {
    id: string;
    memberId: string | null;
    categoryEncrypted: string;
    titleEncrypted: string;
    fileNameEncrypted: string;
    mimeTypeEncrypted: string;
    sizeInBytes: number;
    checksum: string;
    validFrom: Date | null;
    validUntil: Date | null;
    archivedAt: Date | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return Object.freeze({
      id: row.id,
      memberId: row.memberId,
      category: decrypt(personId, "document", "category", row.categoryEncrypted),
      title: decrypt(personId, "document", "title", row.titleEncrypted),
      fileName: decrypt(personId, "document", "fileName", row.fileNameEncrypted),
      mimeType: decrypt(personId, "document", "mimeType", row.mimeTypeEncrypted),
      sizeInBytes: row.sizeInBytes,
      checksum: row.checksum,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      archivedAt: row.archivedAt,
      status: row.status,
      storage: "protected",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async function requireGrant(input: {
    token: unknown;
    purpose: string;
    subjectId?: string | null;
    subjectIds?: string[];
  }) {
    const current = identity();
    // Ohne jemals eingerichtetes Plugin bleibt 2FA optional. War der Schutz
    // jedoch einmal aktiv, kann er nur zusammen mit den geschuetzten Daten
    // entfernt werden. Das Deaktivieren des Plugins entsperrt nichts.
    const protection = await twoFactorProtectionState(current.accountId);
    if (!protection.enrolled) return null;
    if (!protection.available) {
      fail("PROTECTED_PEOPLE_2FA_PROVIDER_REQUIRED", 423);
    }
    const rawToken = text(input.token, 300);
    if (!rawToken) fail("PROTECTED_PEOPLE_2FA_GRANT_REQUIRED", 401);
    if (rawToken === SESSION_MFA_ACCESS_TOKEN) {
      const assurance = getVerifiedRequestSessionAssurance();
      if (
        boundModuleKey !== "app.kontorapp"
        || assurance?.accountId !== current.accountId
        || assurance.credentialRevision !== current.credentialRevision
        || assurance.credentialRevision !== protection.credentialRevision
        || !assurance.mfaVerifiedAt
        || assurance.mfaProviderId !== protection.providerId
      ) fail("PROTECTED_PEOPLE_SESSION_MFA_INVALID", 401);
      return null;
    }
    const grant = await privacy.protectedDataAccessGrant.findUnique({
      where: { tokenHash: tokenHash(rawToken) },
    });
    if (
      !grant
      || grant.accountId !== current.accountId
      || grant.moduleKey !== boundModuleKey
      || grant.dataDomain !== "protected"
      || grant.purpose !== input.purpose
      || grant.credentialRevision !== current.credentialRevision
      || grant.credentialRevision !== protection.credentialRevision
      || grant.providerId !== protection.providerId
      || grant.accessScope !== canonicalAccessScope(input.purpose)
      || grant.revokedAt
      || grant.expiresAt <= new Date()
      || (grant.subjectId && grant.subjectId !== input.subjectId
        && !(input.subjectIds || []).includes(grant.subjectId))
    ) fail("PROTECTED_PEOPLE_2FA_GRANT_INVALID", 401);
    return grant;
  }

  return Object.freeze({
    contractVersion: PROTECTED_PEOPLE_CONTRACT_VERSION,

    async issueAccessGrant(input: {
      challengeId: string;
      purpose: string;
      subjectId?: string | null;
      minutes?: number;
    }) {
      const current = identity();
      const normalizedPurpose = purpose(input.purpose);
      const accessScope = canonicalAccessScope(normalizedPurpose);
      const minutes = Math.min(Math.max(Number(input.minutes || MAX_GRANT_MINUTES), 1), MAX_GRANT_MINUTES);
      const consumed = await consumeChallenge({
        accountId: current.accountId,
        challengeId: text(input.challengeId),
        purpose: PRIVATE_PURPOSE,
        maxAgeMinutes: minutes,
        moduleKey: boundModuleKey,
        accessScope,
        subjectId: input.subjectId || null,
      });
      if (consumed.accessScope !== `${boundModuleKey}:${accessScope}`) {
        fail("PROTECTED_PEOPLE_CHALLENGE_SCOPE_INVALID", 500);
      }
      const rawToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + minutes * 60 * 1000);
      const grant = await privacy.protectedDataAccessGrant.create({
        data: {
          tokenHash: tokenHash(rawToken),
          accountId: current.accountId,
          moduleKey: boundModuleKey,
          dataDomain: "protected",
          purpose: normalizedPurpose,
          subjectId: text(input.subjectId) || null,
          challengeId: text(input.challengeId),
          credentialRevision: consumed.credentialRevision,
          providerId: consumed.providerId,
          accessScope,
          expiresAt,
        },
      });
      await audit(privacy, boundModuleKey, {
        capability: "GRANT",
        purpose: normalizedPurpose,
        operation: "GRANT_ISSUED",
        subjectId: grant.subjectId,
        recordType: "ProtectedDataAccessGrant",
        recordId: grant.id,
      });
      return Object.freeze({ token: rawToken, expiresAt });
    },

    async getPrimaryAddresses(input: { personIds: string[]; purpose: string }) {
      const normalizedCapability = capability(boundModuleKey, "ADDRESS");
      const normalizedPurpose = purpose(input.purpose);
      identity();
      const personIds = [...new Set((input.personIds || []).map((entry) => text(entry)).filter(Boolean))].slice(0, 500);
      const rows = personIds.length
        ? await people.peopleAddress.findMany({
            where: { personId: { in: personIds }, type: "PRIMARY" },
            orderBy: { createdAt: "asc" },
          })
        : [];
      await audit(privacy, boundModuleKey, {
        capability: normalizedCapability,
        purpose: normalizedPurpose,
        operation: "ADDRESS_LIST",
        metadataJson: { capability: normalizedCapability, subjectCount: personIds.length, recordCount: rows.length },
      });
      return Object.freeze(rows.map((row) => Object.freeze({
        id: row.id,
        personId: row.personId,
        type: row.type,
        street: decrypt(row.personId, "address", "street", row.streetEncrypted),
        houseNumber: decrypt(row.personId, "address", "houseNumber", row.houseNumberEncrypted),
        postalCode: decrypt(row.personId, "address", "postalCode", row.postalCodeEncrypted),
        city: decrypt(row.personId, "address", "city", row.cityEncrypted),
        country: decrypt(row.personId, "address", "country", row.countryEncrypted),
        note: decrypt(row.personId, "address", "note", row.noteEncrypted),
        updatedAt: row.updatedAt,
      })));
    },

    async upsertPrimaryAddress(input: {
      personId: string;
      purpose: string;
      address: Record<string, unknown>;
    }) {
      const normalizedCapability = capability(boundModuleKey, "ADDRESS");
      const normalizedPurpose = purpose(input.purpose);
      identity();
      const personId = text(input.personId);
      if (!personId) fail("PROTECTED_PEOPLE_PERSON_ID_REQUIRED");
      const address = input.address || {};
      const existing = await people.peopleAddress.findFirst({ where: { personId, type: "PRIMARY" } });
      const data = {
        recipientEncrypted: encrypt(personId, "address", "recipient", address.recipient),
        streetEncrypted: encrypt(personId, "address", "street", address.street),
        houseNumberEncrypted: encrypt(personId, "address", "houseNumber", address.houseNumber),
        postalCodeEncrypted: encrypt(personId, "address", "postalCode", address.postalCode),
        cityEncrypted: encrypt(personId, "address", "city", address.city),
        countryEncrypted: encrypt(personId, "address", "country", address.country),
        noteEncrypted: encrypt(personId, "address", "note", address.note),
      };
      const row = existing
        ? await people.peopleAddress.update({ where: { id: existing.id }, data })
        : await people.peopleAddress.create({ data: { personId, type: "PRIMARY", ...data } });
      await audit(privacy, boundModuleKey, {
        capability: normalizedCapability,
        purpose: normalizedPurpose,
        operation: "ADDRESS_UPSERT",
        subjectId: personId,
        recordType: "PeopleAddress",
        recordId: row.id,
      });
      return Object.freeze({ id: row.id, personId: row.personId, updatedAt: row.updatedAt });
    },

    async getPaymentAccount(input: { memberId: string; purpose: string; grantToken: string }) {
      const normalizedCapability = capability(boundModuleKey, "BANK");
      const normalizedPurpose = purpose(input.purpose);
      const member = await personForMember(core, input.memberId);
      await requireGrant({ token: input.grantToken, purpose: normalizedPurpose, subjectId: member.id });
      const row = await people.peopleBankAccount.findFirst({
        where: { memberId: member.id, revokedAt: null },
        orderBy: [{ preferred: "desc" }, { updatedAt: "desc" }],
      });
      await audit(privacy, boundModuleKey, {
        capability: normalizedCapability,
        purpose: normalizedPurpose,
        operation: "BANK_READ",
        subjectId: member.id,
        recordType: "PeopleBankAccount",
        recordId: row?.id || null,
      });
      if (!row) return null;
      return Object.freeze({
        id: row.id,
        memberId: member.id,
        accountHolder: decrypt(member.personId, "bank", "accountHolder", row.accountHolderEncrypted),
        iban: decrypt(member.personId, "bank", "iban", row.ibanEncrypted),
        bic: decrypt(member.personId, "bank", "bic", row.bicEncrypted),
        paypal: decrypt(member.personId, "bank", "paypal", row.paypalEncrypted),
        ibanLast4: row.ibanLast4,
        preferred: row.preferred,
        preferredMethod: row.preferredMethod,
        verifiedAt: row.verifiedAt,
        updatedAt: row.updatedAt,
      });
    },

    async getPaymentReadiness(input: { memberIds: string[]; purpose: string }) {
      const bankCapability = capability(boundModuleKey, "BANK");
      capability(boundModuleKey, "SEPA");
      const normalizedPurpose = purpose(input.purpose);
      identity();
      const memberIds = [...new Set(
        (input.memberIds || []).map((entry) => text(entry)).filter(Boolean),
      )].slice(0, 2_000);
      const [accounts, mandates] = memberIds.length
        ? await Promise.all([
            people.peopleBankAccount.findMany({
              where: { memberId: { in: memberIds }, revokedAt: null },
              orderBy: [{ preferred: "desc" }, { updatedAt: "desc" }],
            }),
            people.peopleSepaMandate.findMany({
              where: { memberId: { in: memberIds } },
              orderBy: { signedAt: "desc" },
            }),
          ])
        : [[], []];
      const accountByMember = new Map<string, typeof accounts[number]>();
      for (const account of accounts) {
        if (account.memberId && !accountByMember.has(account.memberId)) {
          accountByMember.set(account.memberId, account);
        }
      }
      const mandateByMember = new Map<string, typeof mandates[number]>();
      for (const mandate of mandates) {
        if (mandate.memberId && !mandateByMember.has(mandate.memberId)) {
          mandateByMember.set(mandate.memberId, mandate);
        }
      }
      await audit(privacy, boundModuleKey, {
        capability: bankCapability,
        purpose: normalizedPurpose,
        operation: "PAYMENT_READINESS_LIST",
        metadataJson: {
          capability: "BANK+SEPA_METADATA",
          subjectCount: memberIds.length,
        },
      });
      return Object.freeze(memberIds.map((memberId) => {
        const account = accountByMember.get(memberId);
        const mandate = mandateByMember.get(memberId);
        return Object.freeze({
          memberId,
          configured: Boolean(account?.ibanLast4),
          ibanLast4: account?.ibanLast4 || null,
          preferredMethod: account?.preferredMethod || null,
          verifiedAt: account?.verifiedAt || null,
          mandate: mandate ? Object.freeze({
            id: mandate.id,
            signedAt: mandate.signedAt,
            sequenceType: mandate.sequenceType,
            status: mandate.status,
            revokedAt: mandate.revokedAt,
          }) : null,
        });
      }));
    },

    async savePaymentAccount(input: {
      memberId: string;
      purpose: string;
      grantToken: string;
      accountHolder: string;
      iban: string;
      bic?: string | null;
      paypal?: string | null;
      preferredMethod?: string;
    }) {
      const normalizedCapability = capability(boundModuleKey, "BANK");
      const normalizedPurpose = purpose(input.purpose);
      const member = await personForMember(core, input.memberId);
      await requireGrant({ token: input.grantToken, purpose: normalizedPurpose, subjectId: member.id });
      const iban = text(input.iban, 80).replace(/\s+/g, "").toUpperCase();
      const accountHolder = text(input.accountHolder, 180);
      const preferredMethod = text(input.preferredMethod || "BANK_TRANSFER", 30).toUpperCase();
      if (!accountHolder || !/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) {
        fail("PROTECTED_PEOPLE_BANK_INPUT_INVALID");
      }
      if (!new Set(["BANK_TRANSFER", "DIRECT_DEBIT"]).has(preferredMethod)) {
        fail("PROTECTED_PEOPLE_PAYMENT_METHOD_INVALID");
      }
      const existing = await people.peopleBankAccount.findFirst({
        where: { memberId: member.id, revokedAt: null },
        orderBy: [{ preferred: "desc" }, { updatedAt: "desc" }],
      });
      const data = {
        personId: member.personId,
        memberId: member.id,
        type: "SEPA" as const,
        accountHolderEncrypted: encrypt(member.personId, "bank", "accountHolder", accountHolder),
        ibanEncrypted: encrypt(member.personId, "bank", "iban", iban),
        bicEncrypted: encrypt(member.personId, "bank", "bic", input.bic),
        paypalEncrypted: encrypt(member.personId, "bank", "paypal", input.paypal),
        ibanLast4: iban.slice(-4),
        preferred: true,
        preferredMethod,
        verifiedAt: new Date(),
      };
      const row = existing
        ? await people.peopleBankAccount.update({ where: { id: existing.id }, data })
        : await people.peopleBankAccount.create({ data });
      await audit(privacy, boundModuleKey, {
        capability: normalizedCapability,
        purpose: normalizedPurpose,
        operation: "BANK_UPSERT",
        subjectId: member.id,
        recordType: "PeopleBankAccount",
        recordId: row.id,
        metadataJson: { capability: normalizedCapability, ibanLast4: row.ibanLast4 },
      });
      return Object.freeze({ id: row.id, ibanLast4: row.ibanLast4, preferredMethod, verifiedAt: row.verifiedAt });
    },

    async listPaymentAccounts(input: {
      memberIds: string[];
      purpose: string;
      grantToken: string;
    }) {
      const normalizedCapability = capability(boundModuleKey, "BANK");
      const normalizedPurpose = purpose(input.purpose);
      const memberIds = [...new Set(
        (input.memberIds || []).map((entry) => text(entry)).filter(Boolean),
      )].slice(0, 2_000);
      await requireGrant({
        token: input.grantToken,
        purpose: normalizedPurpose,
        subjectIds: memberIds,
      });
      const members = memberIds.length
        ? await core.memberProfile.findMany({
            where: { id: { in: memberIds } },
            select: { id: true, personId: true },
          })
        : [];
      const peopleByMember = new Map(members.map((member) => [member.id, member.personId]));
      const rows = memberIds.length
        ? await people.peopleBankAccount.findMany({
            where: { memberId: { in: memberIds }, revokedAt: null },
            orderBy: [{ preferred: "desc" }, { updatedAt: "desc" }],
          })
        : [];
      await audit(privacy, boundModuleKey, {
        capability: normalizedCapability,
        purpose: normalizedPurpose,
        operation: "BANK_LIST",
        metadataJson: { capability: normalizedCapability, subjectCount: memberIds.length, recordCount: rows.length },
      });
      return Object.freeze(rows.map((row) => {
        const personId = peopleByMember.get(row.memberId || "");
        if (!personId) fail("PROTECTED_PEOPLE_MEMBER_LINK_INVALID", 500);
        return Object.freeze({
          id: row.id,
          memberId: row.memberId,
          accountHolder: decrypt(personId, "bank", "accountHolder", row.accountHolderEncrypted),
          iban: decrypt(personId, "bank", "iban", row.ibanEncrypted),
          bic: decrypt(personId, "bank", "bic", row.bicEncrypted),
          ibanLast4: row.ibanLast4,
          preferredMethod: row.preferredMethod,
          verifiedAt: row.verifiedAt,
        });
      }));
    },

    async listSepaMandates(input: {
      memberIds: string[];
      purpose: string;
      grantToken: string;
      activeOnly?: boolean;
    }) {
      const normalizedCapability = capability(boundModuleKey, "SEPA");
      const normalizedPurpose = purpose(input.purpose);
      const memberIds = [...new Set(
        (input.memberIds || []).map((entry) => text(entry)).filter(Boolean),
      )].slice(0, 2_000);
      await requireGrant({
        token: input.grantToken,
        purpose: normalizedPurpose,
        subjectIds: memberIds,
      });
      const members = memberIds.length
        ? await core.memberProfile.findMany({
            where: { id: { in: memberIds } },
            select: { id: true, personId: true },
          })
        : [];
      const peopleByMember = new Map(members.map((member) => [member.id, member.personId]));
      const rows = memberIds.length
        ? await people.peopleSepaMandate.findMany({
            where: {
              memberId: { in: memberIds },
              ...(input.activeOnly === false ? {} : { status: "ACTIVE", revokedAt: null }),
            },
            orderBy: { signedAt: "desc" },
          })
        : [];
      await audit(privacy, boundModuleKey, {
        capability: normalizedCapability,
        purpose: normalizedPurpose,
        operation: "SEPA_LIST",
        metadataJson: { capability: normalizedCapability, subjectCount: memberIds.length, recordCount: rows.length },
      });
      return Object.freeze(rows.map((row) => {
        const personId = peopleByMember.get(row.memberId || "");
        if (!personId) fail("PROTECTED_PEOPLE_MEMBER_LINK_INVALID", 500);
        return Object.freeze({
          id: row.id,
          memberId: row.memberId,
          bankAccountId: row.bankAccountId,
          mandateReference: decrypt(personId, "sepa", "mandateReference", row.mandateReferenceEncrypted),
          creditorIdentifier: decrypt(personId, "sepa", "creditorIdentifier", row.creditorIdentifierEncrypted),
          signedAt: row.signedAt,
          sequenceType: row.sequenceType,
          status: row.status,
          revokedAt: row.revokedAt,
        });
      }));
    },

    async createSepaMandate(input: {
      memberId: string;
      purpose: string;
      grantToken: string;
      mandateReference: string;
      creditorIdentifier: string;
      signedAt: string | Date;
      sequenceType?: string;
    }) {
      const normalizedCapability = capability(boundModuleKey, "SEPA");
      const normalizedPurpose = purpose(input.purpose);
      const member = await personForMember(core, input.memberId);
      await requireGrant({
        token: input.grantToken,
        purpose: normalizedPurpose,
        subjectId: member.id,
      });
      const mandateReference = text(input.mandateReference, 180);
      const creditorIdentifier = text(input.creditorIdentifier, 180).toUpperCase();
      const signedAt = new Date(input.signedAt);
      const sequenceType = text(input.sequenceType || "RCUR", 10).toUpperCase();
      if (!mandateReference || !creditorIdentifier || Number.isNaN(signedAt.getTime()) || !new Set(["FRST", "RCUR", "OOFF", "FNAL"]).has(sequenceType)) {
        fail("PROTECTED_PEOPLE_SEPA_INPUT_INVALID");
      }
      const bank = await people.peopleBankAccount.findFirst({
        where: { memberId: member.id, revokedAt: null },
        orderBy: [{ preferred: "desc" }, { updatedAt: "desc" }],
      });
      if (!bank) fail("PROTECTED_PEOPLE_BANK_ACCOUNT_REQUIRED", 409);
      await people.peopleSepaMandate.updateMany({
        where: { memberId: member.id, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
      const row = await people.peopleSepaMandate.create({
        data: {
          personId: member.personId,
          memberId: member.id,
          bankAccountId: bank.id,
          mandateReferenceEncrypted: encrypt(member.personId, "sepa", "mandateReference", mandateReference)!,
          mandateReferenceFingerprint: fingerprint(mandateReference),
          creditorIdentifierHash: fingerprint(creditorIdentifier),
          creditorIdentifierEncrypted: encrypt(member.personId, "sepa", "creditorIdentifier", creditorIdentifier)!,
          signedAt,
          sequenceType,
          status: "ACTIVE",
        },
      });
      await audit(privacy, boundModuleKey, {
        capability: normalizedCapability,
        purpose: normalizedPurpose,
        operation: "SEPA_CREATE",
        subjectId: member.id,
        recordType: "PeopleSepaMandate",
        recordId: row.id,
      });
      return Object.freeze({ id: row.id, memberId: row.memberId, signedAt: row.signedAt, status: row.status });
    },

    async getEmergencyContacts(input: { memberId: string; purpose: string; grantToken: string }) {
      const normalizedCapability = capability(boundModuleKey, "EMERGENCY");
      const normalizedPurpose = purpose(input.purpose);
      const member = await personForMember(core, input.memberId);
      await requireGrant({
        token: input.grantToken,
        purpose: normalizedPurpose,
        subjectId: member.id,
      });
      const rows = await people.peopleEmergencyContact.findMany({
        where: { personId: member.personId },
        orderBy: { priority: "asc" },
      });
      await audit(privacy, boundModuleKey, {
        capability: normalizedCapability,
        purpose: normalizedPurpose,
        operation: "EMERGENCY_LIST",
        subjectId: member.id,
        metadataJson: { capability: normalizedCapability, recordCount: rows.length },
      });
      return Object.freeze(rows.map((row) => Object.freeze({
        id: row.id,
        name: decrypt(member.personId, "emergency", "name", row.nameEncrypted),
        relationship: decrypt(member.personId, "emergency", "relationship", row.relationshipEncrypted),
        phone: decrypt(member.personId, "emergency", "phone", row.phoneEncrypted),
        email: decrypt(member.personId, "emergency", "email", row.emailEncrypted),
        note: decrypt(member.personId, "emergency", "note", row.noteEncrypted),
        priority: row.priority,
      })));
    },

    async replaceEmergencyContacts(input: {
      memberId: string;
      purpose: string;
      grantToken: string;
      contacts: Array<Record<string, unknown>>;
    }) {
      const normalizedCapability = capability(boundModuleKey, "EMERGENCY");
      const normalizedPurpose = purpose(input.purpose);
      const member = await personForMember(core, input.memberId);
      await requireGrant({
        token: input.grantToken,
        purpose: normalizedPurpose,
        subjectId: member.id,
      });
      const contacts = Array.isArray(input.contacts) ? input.contacts.slice(0, 20) : [];
      await people.$transaction(async (transaction) => {
        await transaction.peopleEmergencyContact.deleteMany({ where: { personId: member.personId } });
        for (const [index, contact] of contacts.entries()) {
          const name = text(contact.name, 180);
          if (!name) continue;
          await transaction.peopleEmergencyContact.create({
            data: {
              personId: member.personId,
              nameEncrypted: encrypt(member.personId, "emergency", "name", name)!,
              relationshipEncrypted: encrypt(member.personId, "emergency", "relationship", contact.relationship),
              phoneEncrypted: encrypt(member.personId, "emergency", "phone", contact.phone || contact.mobile),
              emailEncrypted: encrypt(member.personId, "emergency", "email", contact.email),
              noteEncrypted: encrypt(member.personId, "emergency", "note", contact.notes || contact.note),
              priority: index,
            },
          });
        }
      });
      await audit(privacy, boundModuleKey, {
        capability: normalizedCapability,
        purpose: normalizedPurpose,
        operation: "EMERGENCY_REPLACE",
        subjectId: member.id,
        metadataJson: { capability: normalizedCapability, recordCount: contacts.length },
      });
      return Object.freeze({ memberId: member.id, count: contacts.length });
    },

    async listDocuments(input: {
      memberId: string;
      purpose: string;
      grantToken: string;
      includeArchived?: boolean;
    }) {
      const normalizedCapability = capability(boundModuleKey, "DOCUMENTS");
      const normalizedPurpose = purpose(input.purpose);
      const member = await personForMember(core, input.memberId);
      await requireGrant({ token: input.grantToken, purpose: normalizedPurpose, subjectId: member.id });
      const rows = await people.peopleDocument.findMany({
        where: {
          memberId: member.id,
          status: input.includeArchived === false ? "ACTIVE" : { not: "DELETED" },
        },
        orderBy: [{ archivedAt: "asc" }, { validUntil: "desc" }, { createdAt: "desc" }],
      });
      await audit(privacy, boundModuleKey, {
        capability: normalizedCapability,
        purpose: normalizedPurpose,
        operation: "DOCUMENT_LIST",
        subjectId: member.id,
        recordType: "PeopleDocument",
        metadataJson: { capability: normalizedCapability, recordCount: rows.length },
      });
      return Object.freeze(rows.map((row) => publicDocument(member.personId, row)));
    },

    async createDocument(input: {
      memberId: string;
      purpose: string;
      grantToken: string;
      category?: string;
      title?: string;
      fileName: string;
      mimeType?: string;
      data: Uint8Array;
      validFrom?: Date | null;
      validUntil?: Date | null;
    }) {
      const normalizedCapability = capability(boundModuleKey, "DOCUMENTS");
      const normalizedPurpose = purpose(input.purpose);
      const member = await personForMember(core, input.memberId);
      const current = identity();
      await requireGrant({ token: input.grantToken, purpose: normalizedPurpose, subjectId: member.id });
      const fileName = text(input.fileName, 255);
      const title = text(input.title || fileName, 200);
      const category = text(input.category || "SONSTIGES", 100);
      const mimeType = text(input.mimeType || "application/octet-stream", 180).toLowerCase();
      if (!fileName || !title || !category) fail("PROTECTED_PEOPLE_DOCUMENT_INPUT_INVALID");
      const stored = await storeProtectedDocument({
        domain: "people",
        subjectId: member.personId,
        bytes: input.data,
      });
      try {
        const row = await people.peopleDocument.create({
          data: {
            personId: member.personId,
            memberId: member.id,
            categoryEncrypted: encrypt(member.personId, "document", "category", category)!,
            titleEncrypted: encrypt(member.personId, "document", "title", title)!,
            fileNameEncrypted: encrypt(member.personId, "document", "fileName", fileName)!,
            mimeTypeEncrypted: encrypt(member.personId, "document", "mimeType", mimeType)!,
            sizeInBytes: stored.sizeInBytes,
            checksum: stored.checksum,
            objectKey: stored.objectKey,
            validFrom: input.validFrom || null,
            validUntil: input.validUntil || null,
            uploadedByAccountId: current.accountId,
            encryptionVersion: stored.encryptionVersion,
            keyVersion: stored.keyVersion,
            storageVersion: stored.storageVersion,
          },
        });
        await audit(privacy, boundModuleKey, {
          capability: normalizedCapability,
          purpose: normalizedPurpose,
          operation: "DOCUMENT_CREATE",
          subjectId: member.id,
          recordType: "PeopleDocument",
          recordId: row.id,
          metadataJson: { capability: normalizedCapability, checksum: row.checksum, sizeInBytes: row.sizeInBytes },
        });
        return publicDocument(member.personId, row);
      } catch (error) {
        await deleteProtectedDocument({ domain: "people", subjectId: member.personId, objectKey: stored.objectKey });
        throw error;
      }
    },

    async getDocument(input: {
      memberId: string;
      documentId: string;
      purpose: string;
      grantToken: string;
    }) {
      const normalizedCapability = capability(boundModuleKey, "DOCUMENTS");
      const normalizedPurpose = purpose(input.purpose);
      const member = await personForMember(core, input.memberId);
      await requireGrant({ token: input.grantToken, purpose: normalizedPurpose, subjectId: member.id });
      const row = await people.peopleDocument.findFirst({
        where: { id: text(input.documentId), memberId: member.id, status: { not: "DELETED" } },
      });
      if (!row) fail("PROTECTED_PEOPLE_DOCUMENT_NOT_FOUND", 404);
      const data = await readProtectedDocument({ domain: "people", subjectId: member.personId, objectKey: row.objectKey });
      await audit(privacy, boundModuleKey, {
        capability: normalizedCapability,
        purpose: normalizedPurpose,
        operation: "DOCUMENT_READ",
        subjectId: member.id,
        recordType: "PeopleDocument",
        recordId: row.id,
        metadataJson: { capability: normalizedCapability, checksum: row.checksum },
      });
      return Object.freeze({ ...publicDocument(member.personId, row), data });
    },

    async archiveDocument(input: {
      memberId: string;
      documentId: string;
      purpose: string;
      grantToken: string;
      archived: boolean;
    }) {
      const normalizedCapability = capability(boundModuleKey, "DOCUMENTS");
      const normalizedPurpose = purpose(input.purpose);
      const member = await personForMember(core, input.memberId);
      await requireGrant({ token: input.grantToken, purpose: normalizedPurpose, subjectId: member.id });
      const existing = await people.peopleDocument.findFirst({
        where: { id: text(input.documentId), memberId: member.id, status: { not: "DELETED" } },
      });
      if (!existing) fail("PROTECTED_PEOPLE_DOCUMENT_NOT_FOUND", 404);
      const row = await people.peopleDocument.update({
        where: { id: existing.id },
        data: {
          archivedAt: input.archived ? new Date() : null,
          status: input.archived ? "ARCHIVED" : "ACTIVE",
        },
      });
      await audit(privacy, boundModuleKey, {
        capability: normalizedCapability,
        purpose: normalizedPurpose,
        operation: input.archived ? "DOCUMENT_ARCHIVE" : "DOCUMENT_RESTORE",
        subjectId: member.id,
        recordType: "PeopleDocument",
        recordId: row.id,
      });
      return publicDocument(member.personId, row);
    },

    async deleteDocument(input: {
      memberId: string;
      documentId: string;
      purpose: string;
      grantToken: string;
    }) {
      const normalizedCapability = capability(boundModuleKey, "DOCUMENTS");
      const normalizedPurpose = purpose(input.purpose);
      const member = await personForMember(core, input.memberId);
      await requireGrant({ token: input.grantToken, purpose: normalizedPurpose, subjectId: member.id });
      const existing = await people.peopleDocument.findFirst({
        where: { id: text(input.documentId), memberId: member.id, status: { not: "DELETED" } },
      });
      if (!existing) fail("PROTECTED_PEOPLE_DOCUMENT_NOT_FOUND", 404);
      await deleteProtectedDocument({ domain: "people", subjectId: member.personId, objectKey: existing.objectKey });
      await people.peopleDocument.update({
        where: { id: existing.id },
        data: { status: "DELETED", archivedAt: new Date() },
      });
      await audit(privacy, boundModuleKey, {
        capability: normalizedCapability,
        purpose: normalizedPurpose,
        operation: "DOCUMENT_DELETE",
        subjectId: member.id,
        recordType: "PeopleDocument",
        recordId: existing.id,
        metadataJson: { capability: normalizedCapability, checksum: existing.checksum },
      });
      return Object.freeze({ deleted: true, documentId: existing.id });
    },
  });
}
