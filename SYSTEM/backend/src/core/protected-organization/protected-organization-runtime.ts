import { createHash, createHmac } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

import { env } from "../config/env.js";
import { getVerifiedRequestIdentity } from "../../platform/auth/request-identity/request-identity-context.js";
import { getStatus as getTwoFactorStatus } from "../../platform/security/two-factor/services/two-factor.service.js";
import {
  decryptAes256GcmToUtf8,
  encryptAes256Gcm,
} from "../../platform/security/crypto/symmetric.js";
import {
  deleteProtectedDocument,
  readProtectedDocument,
  storeProtectedDocument,
} from "../protected-documents/protected-document-storage.js";

export const PROTECTED_ORGANIZATION_CONTRACT_VERSION =
  "bonni.protected-organization/v1" as const;
const CIPHERTEXT_PREFIX = "organization1";

type InstanceIdentityPort = {
  get(): Promise<Readonly<{ organizationId: string; tenantId: string }>>;
};

type ProtectedOrganizationRuntimeOptions = {
  getTwoFactorStatus?: typeof getTwoFactorStatus;
  storeDocument?: typeof storeProtectedDocument;
  readDocument?: typeof readProtectedDocument;
  deleteDocument?: typeof deleteProtectedDocument;
};

function fail(code: string, statusCode = 400): never {
  throw Object.assign(new Error(code), { code, statusCode });
}

function text(value: unknown, max = 180) {
  return String(value ?? "").trim().slice(0, max);
}

function purpose(value: unknown) {
  const result = text(value, 120).toUpperCase();
  if (!/^[A-Z][A-Z0-9._:-]{2,119}$/.test(result)) {
    fail("PROTECTED_ORGANIZATION_PURPOSE_INVALID");
  }
  return result;
}

function documentSourceReference(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const reference = String(value).trim();
  if (
    !reference
    || reference.length > 240
    || /[\u0000-\u001f\u007f]/u.test(reference)
  ) {
    fail("PROTECTED_ORGANIZATION_DOCUMENT_SOURCE_REFERENCE_INVALID");
  }
  return reference;
}

function documentSourceReferenceHash(moduleKey: string, reference: string) {
  return createHmac("sha256", env.MASTER_KEY)
    .update("bonni:protected-organization-document-source:v1")
    .update("\u0000")
    .update(moduleKey)
    .update("\u0000")
    .update(reference)
    .digest("hex");
}

function tokenHash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fingerprint(value: unknown) {
  return createHmac("sha256", env.MASTER_KEY)
    .update("bonni:protected-organization:fingerprint:v1")
    .update("\u0000")
    .update(String(value ?? "").replace(/\s+/g, "").toUpperCase())
    .digest("hex");
}

function key(organizationId: string) {
  return createHmac("sha256", env.MASTER_KEY)
    .update("bonni:protected-organization:v1")
    .update("\u0000")
    .update(organizationId)
    .digest();
}

function aad(organizationId: string, recordType: string, field: string) {
  return [
    "bonni.protected-organization/v1",
    organizationId,
    recordType,
    field,
  ].join("|");
}

function encrypt(
  organizationId: string,
  recordType: string,
  field: string,
  value: unknown,
) {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (!normalized) return null;
  return `${CIPHERTEXT_PREFIX}.${encryptAes256Gcm(
    normalized,
    key(organizationId),
    aad(organizationId, recordType, field),
  )}`;
}

function decrypt(
  organizationId: string,
  recordType: string,
  field: string,
  value: unknown,
) {
  if (!value) return null;
  const serialized = String(value);
  if (!serialized.startsWith(`${CIPHERTEXT_PREFIX}.`)) {
    fail("PROTECTED_ORGANIZATION_CIPHERTEXT_INVALID", 500);
  }
  return decryptAes256GcmToUtf8(
    serialized.slice(CIPHERTEXT_PREFIX.length + 1),
    key(organizationId),
    aad(organizationId, recordType, field),
  );
}

export function createModuleProtectedOrganizationRuntime(
  moduleKeyValue: string,
  organization: PrismaClient,
  privacy: PrismaClient,
  instanceIdentity: InstanceIdentityPort,
  options: ProtectedOrganizationRuntimeOptions = {},
) {
  const moduleKey = text(moduleKeyValue, 160).toLowerCase();
  if (moduleKey !== "app.kontorapp") {
    fail("PROTECTED_ORGANIZATION_MODULE_DENIED", 403);
  }
  const readTwoFactorStatus = options.getTwoFactorStatus || getTwoFactorStatus;
  const documentStorage = Object.freeze({
    store: options.storeDocument || storeProtectedDocument,
    read: options.readDocument || readProtectedDocument,
    delete: options.deleteDocument || deleteProtectedDocument,
  });

  async function twoFactorProtectionState(accountId: string) {
    const status = await readTwoFactorStatus(accountId);
    const available = status.enabled === true
      && status.provider?.externallyManaged === true
      && status.provider?.configured === true;
    return {
      available,
      enrolled: status.privateDataProtectionEnrolled === true || available,
    };
  }

  async function requireGrant(grantToken: unknown, normalizedPurpose: string) {
    const current = getVerifiedRequestIdentity();
    if (!current?.accountId) {
      fail("PROTECTED_ORGANIZATION_REQUEST_IDENTITY_REQUIRED", 401);
    }
    // Vor der ersten Plugin-Einrichtung ist 2FA optional. Nach der ersten
    // Aktivierung bleibt der Schutz dauerhaft verriegelt: Ein deaktiviertes
    // oder entferntes Plugin darf die Daten nicht wieder freigeben.
    const protection = await twoFactorProtectionState(current.accountId);
    if (!protection.enrolled) return current;
    if (!protection.available) {
      fail("PROTECTED_ORGANIZATION_2FA_PROVIDER_REQUIRED", 423);
    }
    const rawToken = text(grantToken, 300);
    if (!rawToken) fail("PROTECTED_ORGANIZATION_2FA_GRANT_REQUIRED", 401);
    const grant = await privacy.protectedDataAccessGrant.findUnique({
      where: { tokenHash: tokenHash(rawToken) },
    });
    if (
      !grant
      || grant.accountId !== current.accountId
      || grant.moduleKey !== moduleKey
      || grant.dataDomain !== "protected"
      || grant.purpose !== normalizedPurpose
      || grant.subjectId
      || grant.revokedAt
      || grant.expiresAt <= new Date()
    ) {
      fail("PROTECTED_ORGANIZATION_2FA_GRANT_INVALID", 401);
    }
    return current;
  }

  async function audit(input: {
    purpose: string;
    operation: string;
    organizationId: string;
    recordType?: string | null;
    recordId?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    const current = getVerifiedRequestIdentity();
    await privacy.protectedDataAccessLog.create({
      data: {
        accountId: current?.accountId || null,
        moduleKey,
        dataDomain: "organization",
        purpose: input.purpose,
        operation: input.operation,
        subjectId: input.organizationId,
        recordType: input.recordType || null,
        recordId: input.recordId || null,
        decision: "ALLOWED",
        metadataJson: (input.metadata || {}) as Prisma.InputJsonValue,
      },
    });
  }

  function publicContract(
    organizationId: string,
    contract: {
      id: string;
      contractType: string;
      titleEncrypted: string;
      counterpartyEncrypted: string | null;
      contractNumberEncrypted: string | null;
      billingIntervalEncrypted: string | null;
      amountEncrypted: string | null;
      paymentMethodEncrypted: string | null;
      paymentAccountEncrypted: string | null;
      notesEncrypted: string | null;
      documentFileNameEncrypted: string | null;
      documentMimeTypeEncrypted: string | null;
      documentSizeInBytes: number | null;
      documentChecksum: string | null;
      documentDataEncrypted: string | null;
      startsAt: Date | null;
      endsAt: Date | null;
      noticeAt: Date | null;
      nextDueAt: Date | null;
      status: string;
      createdAt: Date;
      updatedAt: Date;
    },
  ) {
    const fileName = decrypt(
      organizationId,
      "contract",
      "documentFileName",
      contract.documentFileNameEncrypted,
    );
    return Object.freeze({
      id: contract.id,
      organizationId,
      contractType: contract.contractType,
      title: decrypt(organizationId, "contract", "title", contract.titleEncrypted),
      counterparty: decrypt(
        organizationId,
        "contract",
        "counterparty",
        contract.counterpartyEncrypted,
      ),
      contractNumber: decrypt(
        organizationId,
        "contract",
        "contractNumber",
        contract.contractNumberEncrypted,
      ),
      billingInterval: decrypt(
        organizationId,
        "contract",
        "billingInterval",
        contract.billingIntervalEncrypted,
      ),
      expectedAmount: decrypt(
        organizationId,
        "contract",
        "amount",
        contract.amountEncrypted,
      ),
      paymentMethod: decrypt(
        organizationId,
        "contract",
        "paymentMethod",
        contract.paymentMethodEncrypted,
      ),
      paymentAccount: decrypt(
        organizationId,
        "contract",
        "paymentAccount",
        contract.paymentAccountEncrypted,
      ),
      notes: decrypt(organizationId, "contract", "notes", contract.notesEncrypted),
      startDate: contract.startsAt,
      endDate: contract.endsAt,
      noticeDate: contract.noticeAt,
      nextDueDate: contract.nextDueAt,
      status: contract.status,
      document: fileName
        ? Object.freeze({
            fileName,
            mimeType: decrypt(
              organizationId,
              "contract",
              "documentMimeType",
              contract.documentMimeTypeEncrypted,
            ),
            sizeInBytes: contract.documentSizeInBytes,
            checksum: contract.documentChecksum,
          })
        : null,
      hasDocument: Boolean(contract.documentDataEncrypted),
      createdAt: contract.createdAt,
      updatedAt: contract.updatedAt,
    });
  }

  async function findOrganizationContract(organizationId: string, contractId: unknown) {
    const id = text(contractId, 180);
    if (!id) fail("PROTECTED_ORGANIZATION_CONTRACT_ID_REQUIRED");
    const contract = await organization.organizationContract.findFirst({
      where: { id, organizationId },
    });
    if (!contract) fail("PROTECTED_ORGANIZATION_CONTRACT_NOT_FOUND", 404);
    return contract;
  }

  function publicDocument(organizationId: string, row: {
    id: string;
    categoryEncrypted: string;
    titleEncrypted: string;
    descriptionEncrypted: string | null;
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
      category: decrypt(organizationId, "document", "category", row.categoryEncrypted),
      title: decrypt(organizationId, "document", "title", row.titleEncrypted),
      description: decrypt(organizationId, "document", "description", row.descriptionEncrypted),
      fileName: decrypt(organizationId, "document", "fileName", row.fileNameEncrypted),
      mimeType: decrypt(organizationId, "document", "mimeType", row.mimeTypeEncrypted),
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

  return Object.freeze({
    contractVersion: PROTECTED_ORGANIZATION_CONTRACT_VERSION,

    async getCollectionIdentity(input: {
      purpose: string;
      grantToken: string;
    }) {
      const normalizedPurpose = purpose(input.purpose);
      await requireGrant(input.grantToken, normalizedPurpose);
      const { organizationId } = await instanceIdentity.get();
      const [profile, bank] = await Promise.all([
        organization.organizationProfile.findUnique({ where: { organizationId } }),
        organization.organizationBankAccount.findFirst({
          where: { organizationId, purpose: "COLLECTION", active: true },
          orderBy: { updatedAt: "desc" },
        }),
      ]);
      await audit({
        purpose: normalizedPurpose,
        operation: "COLLECTION_IDENTITY_READ",
        organizationId,
        recordType: "OrganizationBankAccount",
        recordId: bank?.id || null,
      });
      if (!profile || !bank) return null;
      return Object.freeze({
        organizationId,
        name: decrypt(organizationId, "profile", "legalName", profile.legalNameEncrypted),
        creditorIdentifier: decrypt(
          organizationId,
          "profile",
          "creditorIdentifier",
          profile.creditorIdentifierEncrypted,
        ),
        bankAccountId: bank.id,
        iban: decrypt(organizationId, "bank", "iban", bank.ibanEncrypted),
        bic: decrypt(organizationId, "bank", "bic", bank.bicEncrypted),
        ibanLast4: bank.ibanLast4,
        messageFormat: "pain.008.001.08",
        updatedAt: bank.updatedAt,
      });
    },

    async saveCollectionIdentity(input: {
      purpose: string;
      grantToken: string;
      name: string;
      creditorIdentifier: string;
      iban: string;
      bic?: string | null;
    }) {
      const normalizedPurpose = purpose(input.purpose);
      await requireGrant(input.grantToken, normalizedPurpose);
      const { organizationId } = await instanceIdentity.get();
      const name = text(input.name, 180);
      const iban = text(input.iban, 80).replace(/\s+/g, "").toUpperCase();
      const bic = text(input.bic, 20).replace(/\s+/g, "").toUpperCase();
      const creditorIdentifier = text(input.creditorIdentifier, 80)
        .replace(/\s+/g, "")
        .toUpperCase();
      if (!name || !iban || !creditorIdentifier) {
        fail("PROTECTED_ORGANIZATION_COLLECTION_INPUT_INVALID");
      }
      const existingBank = await organization.organizationBankAccount.findFirst({
        where: { organizationId, purpose: "COLLECTION", active: true },
        orderBy: { updatedAt: "desc" },
      });
      const [profile, bank] = await organization.$transaction(async (transaction) => {
        const savedProfile = await transaction.organizationProfile.upsert({
          where: { organizationId },
          update: {
            legalNameEncrypted: encrypt(organizationId, "profile", "legalName", name)!,
            creditorIdentifierEncrypted: encrypt(
              organizationId,
              "profile",
              "creditorIdentifier",
              creditorIdentifier,
            ),
            creditorIdentifierHash: fingerprint(creditorIdentifier),
          },
          create: {
            organizationId,
            legalNameEncrypted: encrypt(organizationId, "profile", "legalName", name)!,
            creditorIdentifierEncrypted: encrypt(
              organizationId,
              "profile",
              "creditorIdentifier",
              creditorIdentifier,
            ),
            creditorIdentifierHash: fingerprint(creditorIdentifier),
          },
        });
        const bankData = {
          accountHolderEncrypted: encrypt(organizationId, "bank", "accountHolder", name)!,
          ibanEncrypted: encrypt(organizationId, "bank", "iban", iban)!,
          bicEncrypted: encrypt(organizationId, "bank", "bic", bic),
          ibanLast4: iban.slice(-4),
          verifiedAt: new Date(),
          active: true,
        };
        const savedBank = existingBank
          ? await transaction.organizationBankAccount.update({
              where: { id: existingBank.id },
              data: bankData,
            })
          : await transaction.organizationBankAccount.create({
              data: {
                organizationId,
                purpose: "COLLECTION",
                ...bankData,
              },
            });
        return [savedProfile, savedBank] as const;
      });
      await audit({
        purpose: normalizedPurpose,
        operation: "COLLECTION_IDENTITY_UPSERT",
        organizationId,
        recordType: "OrganizationBankAccount",
        recordId: bank.id,
        metadata: { ibanLast4: bank.ibanLast4 },
      });
      return Object.freeze({
        organizationId,
        profileId: profile.organizationId,
        bankAccountId: bank.id,
        ibanLast4: bank.ibanLast4,
        updatedAt: bank.updatedAt,
      });
    },

    async listContracts(input: {
      purpose: string;
      grantToken: string;
      contractIds?: string[];
    }) {
      const normalizedPurpose = purpose(input.purpose);
      await requireGrant(input.grantToken, normalizedPurpose);
      const { organizationId } = await instanceIdentity.get();
      const contractIds = Array.isArray(input.contractIds)
        ? [...new Set(input.contractIds.map((value) => text(value, 180)).filter(Boolean))].slice(0, 500)
        : [];
      const contracts = await organization.organizationContract.findMany({
        where: {
          organizationId,
          ...(contractIds.length ? { id: { in: contractIds } } : {}),
        },
        orderBy: [{ status: "asc" }, { nextDueAt: "asc" }, { createdAt: "desc" }],
      });
      await audit({
        purpose: normalizedPurpose,
        operation: "ORGANIZATION_CONTRACT_LIST",
        organizationId,
        recordType: "OrganizationContract",
        metadata: { count: contracts.length, filtered: Boolean(contractIds.length) },
      });
      return Object.freeze(contracts.map((contract) => publicContract(organizationId, contract)));
    },

    async getContract(input: {
      purpose: string;
      grantToken: string;
      contractId: string;
    }) {
      const normalizedPurpose = purpose(input.purpose);
      await requireGrant(input.grantToken, normalizedPurpose);
      const { organizationId } = await instanceIdentity.get();
      const contract = await findOrganizationContract(organizationId, input.contractId);
      await audit({
        purpose: normalizedPurpose,
        operation: "ORGANIZATION_CONTRACT_READ",
        organizationId,
        recordType: "OrganizationContract",
        recordId: contract.id,
      });
      return publicContract(organizationId, contract);
    },

    async createContract(input: {
      purpose: string;
      grantToken: string;
      contractType: string;
      title: string;
      counterparty: string;
      contractNumber?: string | null;
      billingInterval?: string | null;
      expectedAmount?: string | null;
      paymentMethod?: string | null;
      paymentAccount?: string | null;
      notes?: string | null;
      startDate?: Date | null;
      endDate?: Date | null;
      noticeDate?: Date | null;
      nextDueDate?: Date | null;
      status?: string;
      document?: {
        fileName: string;
        mimeType: string;
        sizeInBytes: number;
        checksum: string;
        data: Uint8Array;
      } | null;
    }) {
      const normalizedPurpose = purpose(input.purpose);
      await requireGrant(input.grantToken, normalizedPurpose);
      const { organizationId } = await instanceIdentity.get();
      const title = text(input.title, 200);
      const counterparty = text(input.counterparty, 200);
      const contractType = text(input.contractType, 40).toUpperCase();
      if (!title || !counterparty || !contractType) {
        fail("PROTECTED_ORGANIZATION_CONTRACT_INPUT_INVALID");
      }
      if (input.document?.checksum) {
        const duplicate = await organization.organizationContract.findFirst({
          where: { organizationId, documentChecksum: text(input.document.checksum, 128) },
          select: { id: true },
        });
        if (duplicate) fail("PROTECTED_ORGANIZATION_CONTRACT_DOCUMENT_DUPLICATE", 409);
      }
      const documentData = input.document?.data
        ? Buffer.from(input.document.data).toString("base64")
        : null;
      const contract = await organization.organizationContract.create({
        data: {
          organizationId,
          contractType,
          titleEncrypted: encrypt(organizationId, "contract", "title", title)!,
          counterpartyEncrypted: encrypt(
            organizationId,
            "contract",
            "counterparty",
            counterparty,
          ),
          contractNumberEncrypted: encrypt(
            organizationId,
            "contract",
            "contractNumber",
            input.contractNumber,
          ),
          billingIntervalEncrypted: encrypt(
            organizationId,
            "contract",
            "billingInterval",
            input.billingInterval,
          ),
          amountEncrypted: encrypt(
            organizationId,
            "contract",
            "amount",
            input.expectedAmount,
          ),
          paymentMethodEncrypted: encrypt(
            organizationId,
            "contract",
            "paymentMethod",
            input.paymentMethod,
          ),
          paymentAccountEncrypted: encrypt(
            organizationId,
            "contract",
            "paymentAccount",
            input.paymentAccount,
          ),
          notesEncrypted: encrypt(organizationId, "contract", "notes", input.notes),
          documentFileNameEncrypted: encrypt(
            organizationId,
            "contract",
            "documentFileName",
            input.document?.fileName,
          ),
          documentMimeTypeEncrypted: encrypt(
            organizationId,
            "contract",
            "documentMimeType",
            input.document?.mimeType,
          ),
          documentSizeInBytes: input.document?.sizeInBytes ?? null,
          documentChecksum: input.document?.checksum || null,
          documentDataEncrypted: encrypt(
            organizationId,
            "contract",
            "documentData",
            documentData,
          ),
          startsAt: input.startDate || null,
          endsAt: input.endDate || null,
          noticeAt: input.noticeDate || null,
          nextDueAt: input.nextDueDate || null,
          status: text(input.status, 30).toUpperCase() || "ACTIVE",
        },
      });
      await audit({
        purpose: normalizedPurpose,
        operation: "ORGANIZATION_CONTRACT_CREATE",
        organizationId,
        recordType: "OrganizationContract",
        recordId: contract.id,
        metadata: {
          contractType: contract.contractType,
          hasDocument: Boolean(input.document),
          documentChecksum: input.document?.checksum || null,
        },
      });
      return publicContract(organizationId, contract);
    },

    async updateContract(input: {
      purpose: string;
      grantToken: string;
      contractId: string;
      changes: Record<string, unknown>;
      document?: {
        fileName: string;
        mimeType: string;
        sizeInBytes: number;
        checksum: string;
        data: Uint8Array;
      } | null;
    }) {
      const normalizedPurpose = purpose(input.purpose);
      await requireGrant(input.grantToken, normalizedPurpose);
      const { organizationId } = await instanceIdentity.get();
      const existing = await findOrganizationContract(organizationId, input.contractId);
      if (input.document?.checksum) {
        const duplicate = await organization.organizationContract.findFirst({
          where: {
            organizationId,
            documentChecksum: text(input.document.checksum, 128),
            id: { not: existing.id },
          },
          select: { id: true },
        });
        if (duplicate) fail("PROTECTED_ORGANIZATION_CONTRACT_DOCUMENT_DUPLICATE", 409);
      }
      const changes = input.changes || {};
      const data: Prisma.OrganizationContractUpdateInput = {};
      if (changes.contractType !== undefined) data.contractType = text(changes.contractType, 40).toUpperCase();
      if (changes.title !== undefined) {
        const title = text(changes.title, 200);
        if (!title) fail("PROTECTED_ORGANIZATION_CONTRACT_INPUT_INVALID");
        data.titleEncrypted = encrypt(organizationId, "contract", "title", title)!;
      }
      if (changes.counterparty !== undefined) {
        const counterparty = text(changes.counterparty, 200);
        if (!counterparty) fail("PROTECTED_ORGANIZATION_CONTRACT_INPUT_INVALID");
        data.counterpartyEncrypted = encrypt(
          organizationId,
          "contract",
          "counterparty",
          counterparty,
        );
      }
      const encryptedFields = [
        ["contractNumber", "contractNumberEncrypted"],
        ["billingInterval", "billingIntervalEncrypted"],
        ["expectedAmount", "amountEncrypted"],
        ["paymentMethod", "paymentMethodEncrypted"],
        ["paymentAccount", "paymentAccountEncrypted"],
        ["notes", "notesEncrypted"],
      ] as const;
      for (const [source, target] of encryptedFields) {
        if (changes[source] !== undefined) {
          data[target] = encrypt(organizationId, "contract", source === "expectedAmount" ? "amount" : source, changes[source]);
        }
      }
      if (changes.startDate !== undefined) data.startsAt = changes.startDate as Date | null;
      if (changes.endDate !== undefined) data.endsAt = changes.endDate as Date | null;
      if (changes.noticeDate !== undefined) data.noticeAt = changes.noticeDate as Date | null;
      if (changes.nextDueDate !== undefined) data.nextDueAt = changes.nextDueDate as Date | null;
      if (changes.status !== undefined) data.status = text(changes.status, 30).toUpperCase();
      if (input.document) {
        data.documentFileNameEncrypted = encrypt(
          organizationId,
          "contract",
          "documentFileName",
          input.document.fileName,
        );
        data.documentMimeTypeEncrypted = encrypt(
          organizationId,
          "contract",
          "documentMimeType",
          input.document.mimeType,
        );
        data.documentSizeInBytes = input.document.sizeInBytes;
        data.documentChecksum = input.document.checksum;
        data.documentDataEncrypted = encrypt(
          organizationId,
          "contract",
          "documentData",
          Buffer.from(input.document.data).toString("base64"),
        );
      }
      const contract = await organization.organizationContract.update({
        where: { id: existing.id },
        data,
      });
      await audit({
        purpose: normalizedPurpose,
        operation: "ORGANIZATION_CONTRACT_UPDATE",
        organizationId,
        recordType: "OrganizationContract",
        recordId: contract.id,
        metadata: {
          fields: Object.keys(changes),
          hasNewDocument: Boolean(input.document),
        },
      });
      return publicContract(organizationId, contract);
    },

    async getContractDocument(input: {
      purpose: string;
      grantToken: string;
      contractId: string;
    }) {
      const normalizedPurpose = purpose(input.purpose);
      await requireGrant(input.grantToken, normalizedPurpose);
      const { organizationId } = await instanceIdentity.get();
      const contract = await findOrganizationContract(organizationId, input.contractId);
      const encoded = decrypt(
        organizationId,
        "contract",
        "documentData",
        contract.documentDataEncrypted,
      );
      if (!encoded) fail("PROTECTED_ORGANIZATION_CONTRACT_DOCUMENT_NOT_FOUND", 404);
      await audit({
        purpose: normalizedPurpose,
        operation: "ORGANIZATION_CONTRACT_DOCUMENT_READ",
        organizationId,
        recordType: "OrganizationContract",
        recordId: contract.id,
        metadata: { documentChecksum: contract.documentChecksum },
      });
      return Object.freeze({
        fileName: decrypt(
          organizationId,
          "contract",
          "documentFileName",
          contract.documentFileNameEncrypted,
        ),
        mimeType: decrypt(
          organizationId,
          "contract",
          "documentMimeType",
          contract.documentMimeTypeEncrypted,
        ),
        sizeInBytes: contract.documentSizeInBytes,
        checksum: contract.documentChecksum,
        data: Buffer.from(encoded, "base64"),
      });
    },

    async listDocuments(input: {
      purpose: string;
      grantToken: string;
      includeArchived?: boolean;
    }) {
      const normalizedPurpose = purpose(input.purpose);
      await requireGrant(input.grantToken, normalizedPurpose);
      const { organizationId } = await instanceIdentity.get();
      const rows = await organization.organizationDocument.findMany({
        where: {
          organizationId,
          status: input.includeArchived === false ? "ACTIVE" : { not: "DELETED" },
        },
        orderBy: [{ archivedAt: "asc" }, { validUntil: "desc" }, { createdAt: "desc" }],
      });
      await audit({
        purpose: normalizedPurpose,
        operation: "ORGANIZATION_DOCUMENT_LIST",
        organizationId,
        recordType: "OrganizationDocument",
        metadata: { count: rows.length },
      });
      return Object.freeze(rows.map((row) => publicDocument(organizationId, row)));
    },

    async createDocument(input: {
      purpose: string;
      grantToken: string;
      category?: string;
      title?: string;
      description?: string | null;
      fileName: string;
      mimeType?: string;
      data: Uint8Array;
      validFrom?: Date | null;
      validUntil?: Date | null;
      sourceReference?: string;
    }) {
      const normalizedPurpose = purpose(input.purpose);
      const current = await requireGrant(input.grantToken, normalizedPurpose);
      const { organizationId } = await instanceIdentity.get();
      const fileName = text(input.fileName, 255);
      const title = text(input.title || fileName, 200);
      const category = text(input.category || "SONSTIGES", 100);
      const mimeType = text(input.mimeType || "application/octet-stream", 180).toLowerCase();
      const bytes = Buffer.from(input.data || []);
      const sourceReference = documentSourceReference(input.sourceReference);
      const sourceReferenceHash = sourceReference
        ? documentSourceReferenceHash(moduleKey, sourceReference)
        : null;
      if (!fileName || !title || !category) fail("PROTECTED_ORGANIZATION_DOCUMENT_INPUT_INVALID");

      const findBoundDocument = () => sourceReferenceHash
        ? organization.organizationDocument.findUnique({
            where: {
              organizationId_sourceModuleKey_sourceReferenceHash: {
                organizationId,
                sourceModuleKey: moduleKey,
                sourceReferenceHash,
              },
            },
          })
        : Promise.resolve(null);
      const replayBoundDocument = async (row: any) => {
        const checksum = createHash("sha256").update(bytes).digest("hex");
        if (
          row.status === "DELETED"
          || row.checksum !== checksum
          || row.sizeInBytes !== bytes.length
        ) {
          fail("PROTECTED_ORGANIZATION_DOCUMENT_SOURCE_CONFLICT", 409);
        }
        await audit({
          purpose: normalizedPurpose,
          operation: "ORGANIZATION_DOCUMENT_CREATE_REPLAY",
          organizationId,
          recordType: "OrganizationDocument",
          recordId: row.id,
          metadata: { checksum: row.checksum, sizeInBytes: row.sizeInBytes },
        });
        return publicDocument(organizationId, row);
      };

      const existing = await findBoundDocument();
      if (existing) return replayBoundDocument(existing);

      const stored = await documentStorage.store({
        domain: "organization",
        subjectId: organizationId,
        bytes,
      });
      let row: any;
      try {
        row = await organization.organizationDocument.create({
          data: {
            organizationId,
            sourceModuleKey: sourceReferenceHash ? moduleKey : null,
            sourceReferenceHash,
            categoryEncrypted: encrypt(organizationId, "document", "category", category)!,
            titleEncrypted: encrypt(organizationId, "document", "title", title)!,
            descriptionEncrypted: encrypt(organizationId, "document", "description", input.description),
            fileNameEncrypted: encrypt(organizationId, "document", "fileName", fileName)!,
            mimeTypeEncrypted: encrypt(organizationId, "document", "mimeType", mimeType)!,
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
      } catch (error) {
        await documentStorage.delete({
          domain: "organization",
          subjectId: organizationId,
          objectKey: stored.objectKey,
        });
        const concurrent = await findBoundDocument();
        if (concurrent) return replayBoundDocument(concurrent);
        throw error;
      }
      await audit({
        purpose: normalizedPurpose,
        operation: "ORGANIZATION_DOCUMENT_CREATE",
        organizationId,
        recordType: "OrganizationDocument",
        recordId: row.id,
        metadata: { checksum: row.checksum, sizeInBytes: row.sizeInBytes },
      });
      return publicDocument(organizationId, row);
    },

    async getDocument(input: {
      purpose: string;
      grantToken: string;
      documentId: string;
    }) {
      const normalizedPurpose = purpose(input.purpose);
      await requireGrant(input.grantToken, normalizedPurpose);
      const { organizationId } = await instanceIdentity.get();
      const row = await organization.organizationDocument.findFirst({
        where: { id: text(input.documentId), organizationId, status: { not: "DELETED" } },
      });
      if (!row) fail("PROTECTED_ORGANIZATION_DOCUMENT_NOT_FOUND", 404);
      const data = await documentStorage.read({ domain: "organization", subjectId: organizationId, objectKey: row.objectKey });
      await audit({
        purpose: normalizedPurpose,
        operation: "ORGANIZATION_DOCUMENT_READ",
        organizationId,
        recordType: "OrganizationDocument",
        recordId: row.id,
        metadata: { checksum: row.checksum },
      });
      return Object.freeze({ ...publicDocument(organizationId, row), data });
    },

    async archiveDocument(input: {
      purpose: string;
      grantToken: string;
      documentId: string;
      archived: boolean;
    }) {
      const normalizedPurpose = purpose(input.purpose);
      await requireGrant(input.grantToken, normalizedPurpose);
      const { organizationId } = await instanceIdentity.get();
      const existing = await organization.organizationDocument.findFirst({
        where: { id: text(input.documentId), organizationId, status: { not: "DELETED" } },
      });
      if (!existing) fail("PROTECTED_ORGANIZATION_DOCUMENT_NOT_FOUND", 404);
      const row = await organization.organizationDocument.update({
        where: { id: existing.id },
        data: {
          archivedAt: input.archived ? new Date() : null,
          status: input.archived ? "ARCHIVED" : "ACTIVE",
        },
      });
      await audit({
        purpose: normalizedPurpose,
        operation: input.archived ? "ORGANIZATION_DOCUMENT_ARCHIVE" : "ORGANIZATION_DOCUMENT_RESTORE",
        organizationId,
        recordType: "OrganizationDocument",
        recordId: row.id,
      });
      return publicDocument(organizationId, row);
    },

    async deleteDocument(input: {
      purpose: string;
      grantToken: string;
      documentId: string;
    }) {
      const normalizedPurpose = purpose(input.purpose);
      await requireGrant(input.grantToken, normalizedPurpose);
      const { organizationId } = await instanceIdentity.get();
      const existing = await organization.organizationDocument.findFirst({
        where: { id: text(input.documentId), organizationId, status: { not: "DELETED" } },
      });
      if (!existing) fail("PROTECTED_ORGANIZATION_DOCUMENT_NOT_FOUND", 404);
      if (existing.sourceModuleKey || existing.sourceReferenceHash) {
        fail("PROTECTED_ORGANIZATION_DOCUMENT_SOURCE_BOUND_DELETE_DENIED", 409);
      }
      await documentStorage.delete({ domain: "organization", subjectId: organizationId, objectKey: existing.objectKey });
      await organization.organizationDocument.update({
        where: { id: existing.id },
        data: { status: "DELETED", archivedAt: new Date() },
      });
      await audit({
        purpose: normalizedPurpose,
        operation: "ORGANIZATION_DOCUMENT_DELETE",
        organizationId,
        recordType: "OrganizationDocument",
        recordId: existing.id,
        metadata: { checksum: existing.checksum },
      });
      return Object.freeze({ deleted: true, documentId: existing.id });
    },
  });
}
