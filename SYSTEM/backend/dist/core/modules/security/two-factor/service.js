import { prisma } from "../../../database/prisma.js";
import { verifyExactLocalPassword } from "../../identity/local-password-policy.js";
import { cancelPendingRecoveryAfterCredentialChange } from "../account-recovery/credential-transition.js";
import { assertInteractiveTwoFactorAccount as assertInteractiveLocalAccount, } from "./account-eligibility.js";
import { buildTotpOtpauthUri, buildTotpQrCodeDataUrl, decryptSecret, encryptSecret, enrollmentPasswordHash, fingerprintSecret, generateEnrollmentPassword, generateRecoveryCode, generateTotpSecret, matchTotpCounter, normalizeRecoveryCode, recoveryCodeHash, verifyEnrollmentPasswordHash, } from "./totp.js";
import { getRegisteredExternalTwoFactorProviderById, } from "./provider-registry.js";
const db = prisma;
const LOCAL_PROVIDER_ID = "local";
const LOCAL_PROOF_FIELDS = Object.freeze([{
        name: "code",
        label: "Authenticator-Code",
        type: "password",
        autocomplete: "one-time-code",
    }]);
const LOCKOUT_SCOPE_PREFIX = "2FA:";
const BASE_LOCK_MINUTES = 3;
const MAX_LOCK_MINUTES = 24 * 60;
function fail(code, statusCode = 400, details) {
    throw Object.assign(new Error(code), { code, statusCode, details });
}
function boundedInteger(value, fallback, min, max) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(Math.max(Math.round(parsed), min), max) : fallback;
}
export function getLocalTwoFactorPolicy() {
    return Object.freeze({
        maxAttempts: boundedInteger(process.env.TWO_FACTOR_MAX_ATTEMPTS, 8, 1, 20),
        challengeExpiresSeconds: boundedInteger(process.env.TWO_FACTOR_CHALLENGE_EXPIRES_SECONDS, 60, 30, 600),
        enrollmentExpiresMinutes: boundedInteger(process.env.TWO_FACTOR_ENROLLMENT_EXPIRES_MINUTES, 24 * 60, 5, 7 * 24 * 60),
        proofFields: LOCAL_PROOF_FIELDS,
    });
}
function addSeconds(seconds) {
    return new Date(Date.now() + seconds * 1000);
}
function addMinutes(minutes) {
    return new Date(Date.now() + minutes * 60 * 1000);
}
function scopeKey(purpose) {
    return `${LOCKOUT_SCOPE_PREFIX}${purpose}`;
}
function lockMinutes(level) {
    return Math.min(BASE_LOCK_MINUTES * (2 ** Math.max(level, 0)), MAX_LOCK_MINUTES);
}
function safeProviderProofFields(value) {
    if (!Array.isArray(value))
        return Object.freeze([]);
    const names = new Set();
    const fields = [];
    for (const item of value.slice(0, 3)) {
        if (!item || typeof item !== "object")
            continue;
        const source = item;
        const name = source.name;
        if ((name !== "code" && name !== "token" && name !== "password") || names.has(name))
            continue;
        const type = source.type === "text" ? "text" : "password";
        const autocomplete = source.autocomplete === "one-time-code"
            || source.autocomplete === "current-password"
            || source.autocomplete === "off"
            ? source.autocomplete
            : undefined;
        names.add(name);
        fields.push(Object.freeze({
            name,
            label: String(source.label || name).slice(0, 80),
            type,
            autocomplete,
            help: source.help === undefined ? undefined : String(source.help).slice(0, 240),
        }));
    }
    return Object.freeze(fields);
}
async function externalContext(providerId, enrolled) {
    const registered = getRegisteredExternalTwoFactorProviderById(providerId);
    if (!registered) {
        return {
            id: providerId,
            label: providerId,
            externallyManaged: true,
            enrolled,
            configured: false,
            available: false,
            proofFields: Object.freeze([]),
            maxAttempts: getLocalTwoFactorPolicy().maxAttempts,
            challengeExpiresSeconds: getLocalTwoFactorPolicy().challengeExpiresSeconds,
        };
    }
    try {
        const state = await registered.getState();
        return {
            id: registered.id,
            label: String(registered.label || registered.id).slice(0, 80),
            externallyManaged: true,
            enrolled,
            configured: state.enabled === true && state.configured === true,
            available: state.enabled === true && state.configured === true,
            proofFields: safeProviderProofFields(state.policy?.proofFields),
            maxAttempts: boundedInteger(state.policy?.maxAttempts, 8, 1, 20),
            challengeExpiresSeconds: boundedInteger(state.policy?.challengeExpiresSeconds, 60, 30, 600),
        };
    }
    catch {
        return {
            id: registered.id,
            label: String(registered.label || registered.id).slice(0, 80),
            externallyManaged: true,
            enrolled,
            configured: false,
            available: false,
            proofFields: Object.freeze([]),
            maxAttempts: getLocalTwoFactorPolicy().maxAttempts,
            challengeExpiresSeconds: getLocalTwoFactorPolicy().challengeExpiresSeconds,
        };
    }
}
async function activeLocalCredential(account) {
    const credentials = await db.securityTwoFactorCredential.findMany({
        where: { accountId: account.id, method: "TOTP", status: "ACTIVE" },
        orderBy: { confirmedAt: "desc" },
        take: 2,
    });
    if (credentials.length > 1)
        fail("TWO_FACTOR_CREDENTIAL_STATE_AMBIGUOUS", 409);
    const current = credentials.find((entry) => (entry.enrollmentSlot === account.id
        && entry.credentialRevision === account.credentialRevision));
    if (current)
        return current;
    // One-time, evidence-based Core-0.1.19 compatibility migration. Only one
    // already active local credential may be adopted; ambiguous rows fail closed.
    if (credentials.length !== 1)
        return null;
    const legacy = credentials[0];
    if (legacy.enrollmentSlot !== null
        || (legacy.credentialRevision !== -1 && legacy.credentialRevision !== account.credentialRevision))
        return null;
    const adopted = await db.securityTwoFactorCredential.updateMany({
        where: {
            id: legacy.id,
            accountId: account.id,
            method: "TOTP",
            status: "ACTIVE",
            enrollmentSlot: null,
            credentialRevision: legacy.credentialRevision,
        },
        data: {
            enrollmentSlot: account.id,
            credentialRevision: account.credentialRevision,
        },
    });
    if (adopted.count !== 1)
        return null;
    return db.securityTwoFactorCredential.findUnique({ where: { id: legacy.id } });
}
async function providerContext(accountId) {
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: {
            id: true,
            twoFactorProviderId: true,
            twoFactorEnrolledAt: true,
            privateDataTwoFactorEnrolledAt: true,
            credentialRevision: true,
        },
    });
    if (!account)
        fail("ACCOUNT_NOT_FOUND", 404);
    const boundProvider = String(account.twoFactorProviderId || "").trim().toLowerCase();
    const localCredential = boundProvider && boundProvider !== LOCAL_PROVIDER_ID
        ? null
        : await activeLocalCredential(account);
    if (boundProvider === LOCAL_PROVIDER_ID) {
        const enrolled = Boolean(account.twoFactorEnrolledAt || localCredential);
        if (localCredential
            && (!account.twoFactorEnrolledAt || !account.privateDataTwoFactorEnrolledAt)) {
            const enrolledAt = account.twoFactorEnrolledAt || localCredential.confirmedAt || new Date();
            const repaired = await db.account.updateMany({
                where: {
                    id: accountId,
                    credentialRevision: account.credentialRevision,
                    twoFactorProviderId: LOCAL_PROVIDER_ID,
                },
                data: {
                    ...(!account.twoFactorEnrolledAt ? { twoFactorEnrolledAt: enrolledAt } : {}),
                    ...(!account.privateDataTwoFactorEnrolledAt
                        ? { privateDataTwoFactorEnrolledAt: enrolledAt }
                        : {}),
                },
            });
            if (repaired.count !== 1)
                fail("TWO_FACTOR_ACCOUNT_CHANGED", 409);
        }
        return {
            id: LOCAL_PROVIDER_ID,
            label: "Authenticator-App (TOTP)",
            externallyManaged: false,
            enrolled,
            configured: Boolean(localCredential),
            available: Boolean(localCredential),
            proofFields: LOCAL_PROOF_FIELDS,
            maxAttempts: getLocalTwoFactorPolicy().maxAttempts,
            challengeExpiresSeconds: getLocalTwoFactorPolicy().challengeExpiresSeconds,
        };
    }
    if (boundProvider) {
        if (!account.twoFactorEnrolledAt || !account.privateDataTwoFactorEnrolledAt) {
            const enrolledAt = account.twoFactorEnrolledAt || new Date();
            const repaired = await db.account.updateMany({
                where: {
                    id: accountId,
                    credentialRevision: account.credentialRevision,
                    twoFactorProviderId: account.twoFactorProviderId,
                },
                data: {
                    ...(!account.twoFactorEnrolledAt ? { twoFactorEnrolledAt: enrolledAt } : {}),
                    ...(!account.privateDataTwoFactorEnrolledAt
                        ? { privateDataTwoFactorEnrolledAt: enrolledAt }
                        : {}),
                },
            });
            if (repaired.count !== 1)
                fail("TWO_FACTOR_ACCOUNT_CHANGED", 409);
        }
        return externalContext(boundProvider, true);
    }
    if (localCredential) {
        const enrolledAt = account.twoFactorEnrolledAt || localCredential.confirmedAt || new Date();
        const bound = await db.account.updateMany({
            where: {
                id: accountId,
                credentialRevision: account.credentialRevision,
                twoFactorProviderId: null,
            },
            data: {
                twoFactorProviderId: LOCAL_PROVIDER_ID,
                twoFactorEnrolledAt: enrolledAt,
                privateDataTwoFactorEnrolledAt: enrolledAt,
            },
        });
        if (bound.count !== 1)
            fail("TWO_FACTOR_ACCOUNT_CHANGED", 409);
        return {
            id: LOCAL_PROVIDER_ID,
            label: "Authenticator-App (TOTP)",
            externallyManaged: false,
            enrolled: true,
            configured: true,
            available: true,
            proofFields: LOCAL_PROOF_FIELDS,
            maxAttempts: getLocalTwoFactorPolicy().maxAttempts,
            challengeExpiresSeconds: getLocalTwoFactorPolicy().challengeExpiresSeconds,
        };
    }
    return {
        id: LOCAL_PROVIDER_ID,
        label: "Authenticator-App (TOTP)",
        externallyManaged: false,
        enrolled: false,
        configured: false,
        available: true,
        proofFields: LOCAL_PROOF_FIELDS,
        maxAttempts: getLocalTwoFactorPolicy().maxAttempts,
        challengeExpiresSeconds: getLocalTwoFactorPolicy().challengeExpiresSeconds,
    };
}
function publicCredential(credential) {
    return Object.freeze({
        id: credential.id,
        method: credential.method,
        label: credential.label,
        status: credential.status,
        confirmedAt: credential.confirmedAt,
        lastUsedAt: credential.lastUsedAt,
        createdAt: credential.createdAt,
    });
}
function publicEnrollmentRequest(enrollment) {
    if (!enrollment)
        return null;
    const status = enrollment.status === "PENDING"
        ? "PENDING"
        : enrollment.status === "CLAIMED"
            ? "IN_PROGRESS"
            : "EXPIRED";
    return Object.freeze({
        id: enrollment.id,
        status,
        requestedAt: enrollment.createdAt,
        expiresAt: enrollment.expiresAt,
        requiresCurrentPassword: true,
        requiresEnrollmentPassword: true,
    });
}
async function expireEnrollment(accountId) {
    const enrollment = await db.securityTwoFactorEnrollment.findUnique({ where: { accountId } });
    if (!enrollment
        || (enrollment.status !== "PENDING" && enrollment.status !== "CLAIMED")
        || enrollment.expiresAt > new Date())
        return false;
    return db.$transaction(async (tx) => {
        const expired = await tx.securityTwoFactorEnrollment.updateMany({
            where: {
                id: enrollment.id,
                accountId,
                status: enrollment.status,
                expiresAt: { lte: new Date() },
            },
            data: { status: "EXPIRED", enrollmentPasswordHash: null, revokedAt: new Date() },
        });
        if (expired.count !== 1)
            return false;
        await tx.securityTwoFactorCredential.updateMany({
            where: { accountId, status: "PENDING", enrollmentSlot: accountId },
            data: {
                status: "REVOKED",
                enrollmentSlot: null,
                secretEncrypted: null,
                secretFingerprint: null,
                disabledAt: new Date(),
            },
        });
        return true;
    });
}
async function writeAudit(input) {
    const data = {
        accountId: input.accountId,
        event: input.event,
        purpose: input.purpose,
        method: input.method,
        result: input.result,
        ipAddress: input.meta?.ip,
        userAgent: input.meta?.userAgent,
        metadataJson: input.metadataJson,
    };
    await db.securityTwoFactorAuditLog.create({ data }).catch(() => undefined);
    await db.securityLog?.create?.({
        data: {
            category: "TWO_FACTOR",
            event: input.event,
            severity: input.result === "SUCCESS" ? "INFO" : "WARN",
            accountId: input.accountId,
            ipAddress: input.meta?.ip,
            userAgent: input.meta?.userAgent,
            metadataJson: input.metadataJson,
        },
    }).catch(() => undefined);
}
async function getLockout(accountId, scope) {
    return db.securityTwoFactorLockout.findUnique({
        where: { accountId_scopeKey: { accountId, scopeKey: scope } },
    });
}
async function assertNotLocked(accountId, scope, maxAttempts) {
    const lockout = await getLockout(accountId, scope);
    if (lockout?.lockedUntil && lockout.lockedUntil > new Date()) {
        fail("TWO_FACTOR_TEMPORARILY_LOCKED", 423, {
            lockedUntil: lockout.lockedUntil,
            maxAttempts,
        });
    }
}
async function registerFailure(accountId, scope, maxAttempts) {
    const row = await db.securityTwoFactorLockout.upsert({
        where: { accountId_scopeKey: { accountId, scopeKey: scope } },
        create: { accountId, scopeKey: scope, failedAttempts: 1, lastFailureAt: new Date() },
        update: { failedAttempts: { increment: 1 }, lastFailureAt: new Date() },
    });
    if (row.lockedUntil && row.lockedUntil > new Date()) {
        return { locked: true, lockedUntil: row.lockedUntil, maxAttempts };
    }
    if (row.failedAttempts < maxAttempts) {
        return { locked: false, failedAttempts: row.failedAttempts, maxAttempts };
    }
    const until = addMinutes(lockMinutes(row.lockLevel || 0));
    const updated = await db.securityTwoFactorLockout.updateMany({
        where: { id: row.id, failedAttempts: { gte: maxAttempts } },
        data: {
            failedAttempts: 0,
            lockLevel: { increment: 1 },
            lockedUntil: until,
            lastFailureAt: new Date(),
        },
    });
    return updated.count === 1
        ? { locked: true, lockedUntil: until, maxAttempts }
        : { locked: false, failedAttempts: row.failedAttempts, maxAttempts };
}
async function clearFailures(accountId, scope) {
    await db.securityTwoFactorLockout.upsert({
        where: { accountId_scopeKey: { accountId, scopeKey: scope } },
        create: { accountId, scopeKey: scope, failedAttempts: 0, lockLevel: 0, lastSuccessAt: new Date() },
        update: { failedAttempts: 0, lockLevel: 0, lockedUntil: null, lastSuccessAt: new Date() },
    }).catch(() => undefined);
}
export async function hasActiveTwoFactor(accountId) {
    const context = await providerContext(accountId);
    // "enrolled" is deliberately used instead of "available": a removed or
    // unavailable adapter must lock the account, never bypass its second factor.
    return context.enrolled;
}
export async function getStatus(accountId) {
    await expireEnrollment(accountId);
    const context = await providerContext(accountId);
    const [account, credentials, recoveryCount, enrollment, lockouts] = await Promise.all([
        db.account.findUnique({
            where: { id: accountId },
            select: { credentialRevision: true, twoFactorEnrolledAt: true, privateDataTwoFactorEnrolledAt: true },
        }),
        db.securityTwoFactorCredential.findMany({
            where: { accountId, status: { in: ["ACTIVE", "PENDING"] } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 20,
        }),
        db.securityTwoFactorRecoveryCode.count({ where: { accountId, usedAt: null } }),
        db.securityTwoFactorEnrollment.findUnique({
            where: { accountId },
            select: { id: true, status: true, createdAt: true, expiresAt: true, attempts: true, maxAttempts: true },
        }),
        db.securityTwoFactorLockout.findMany({ where: { accountId }, orderBy: { updatedAt: "desc" } }),
    ]);
    return Object.freeze({
        enabled: context.enrolled,
        available: context.available,
        configured: context.configured,
        credentialRevision: account?.credentialRevision ?? -1,
        provider: Object.freeze({
            id: context.id,
            label: context.label,
            configured: context.configured,
            available: context.available,
            externallyManaged: context.externallyManaged,
            details: Object.freeze({}),
            proofFields: context.proofFields,
        }),
        methods: context.configured
            ? (context.externallyManaged ? [context.id.toUpperCase()] : ["TOTP"])
            : [],
        credentials: credentials.map(publicCredential),
        unusedRecoveryCodeCount: recoveryCount,
        maxAttempts: context.maxAttempts,
        challengeExpiresSeconds: context.challengeExpiresSeconds,
        privateDataProtectionEnrolled: Boolean(account?.privateDataTwoFactorEnrolledAt),
        privateDataProtectionEnrolledAt: account?.privateDataTwoFactorEnrolledAt || null,
        schemaVersion: "bonni.two-factor-enrollment/v1",
        enrollmentRequest: enrollment && (enrollment.status === "PENDING" || enrollment.status === "CLAIMED")
            ? publicEnrollmentRequest(enrollment)
            : null,
        activeLockouts: lockouts
            .filter((entry) => entry.lockedUntil && entry.lockedUntil > new Date())
            .map((entry) => Object.freeze({ scopeKey: entry.scopeKey, lockedUntil: entry.lockedUntil })),
    });
}
function proofFromInput(input) {
    return {
        code: typeof input.code === "string" ? input.code : undefined,
        recoveryCode: typeof input.recoveryCode === "string" ? input.recoveryCode : undefined,
        token: typeof input.token === "string" ? input.token : undefined,
        password: typeof input.password === "string" ? input.password : undefined,
    };
}
function presentProofKeys(proof) {
    return ["code", "recoveryCode", "token", "password"]
        .filter((key) => proof[key] !== undefined);
}
function assertProviderProofShape(context, proof) {
    const present = presentProofKeys(proof);
    if (present.includes("recoveryCode")) {
        if (context.id !== LOCAL_PROVIDER_ID || present.length !== 1)
            fail("TWO_FACTOR_PROOF_SHAPE_INVALID", 400);
        return;
    }
    if (context.id === LOCAL_PROVIDER_ID) {
        if (present.length !== 1 || present[0] !== "code")
            fail("TWO_FACTOR_PROOF_SHAPE_INVALID", 400);
        return;
    }
    const required = [...new Set(context.proofFields.map((field) => field.name))].sort();
    if (!required.length || present.slice().sort().join("|") !== required.join("|")) {
        fail("TWO_FACTOR_PROOF_SHAPE_INVALID", 400);
    }
}
async function assertFreshAdminProof(adminAccountId, input, meta) {
    const admin = await db.account.findUnique({
        where: { id: adminAccountId },
        select: {
            id: true,
            type: true,
            isActive: true,
            passwordHash: true,
            credentialRevision: true,
            twoFactorProviderId: true,
        },
    });
    assertInteractiveLocalAccount(admin);
    if (admin.type !== "ADMIN")
        fail("TWO_FACTOR_ADMIN_ACCOUNT_REQUIRED", 403);
    const proof = proofFromInput(input);
    const context = await providerContext(adminAccountId);
    if (!context.enrolled) {
        await assertNotLocked(adminAccountId, scopeKey("ADMIN_ELEVATION"), context.maxAttempts);
        if (presentProofKeys(proof).length !== 1 || proof.password === undefined) {
            fail("TWO_FACTOR_ADMIN_PASSWORD_REQUIRED", 401);
        }
        if (!await verifyExactLocalPassword(proof.password, admin.passwordHash)) {
            const failed = await registerFailure(adminAccountId, scopeKey("ADMIN_ELEVATION"), context.maxAttempts);
            fail(failed.locked ? "TWO_FACTOR_TEMPORARILY_LOCKED" : "TWO_FACTOR_ADMIN_PROOF_INVALID", failed.locked ? 423 : 401, failed);
        }
        await clearFailures(adminAccountId, scopeKey("ADMIN_ELEVATION"));
        return Object.freeze({
            credentialRevision: admin.credentialRevision,
            providerId: admin.twoFactorProviderId || null,
        });
    }
    assertProviderProofShape(context, proof);
    const challenge = await createChallenge(adminAccountId, { purpose: "ADMIN_ELEVATION" }, meta);
    await verifyChallenge(adminAccountId, challenge.id, proof, meta);
    return consumeVerifiedChallenge({
        accountId: adminAccountId,
        challengeId: challenge.id,
        purpose: "ADMIN_ELEVATION",
    });
}
async function assertAdminProofStillCurrent(client, adminAccountId, proof) {
    const current = await client.account.findUnique({
        where: { id: adminAccountId },
        select: { type: true, isActive: true, credentialRevision: true, twoFactorProviderId: true },
    });
    if (!current
        || current.type !== "ADMIN"
        || current.isActive !== true
        || current.credentialRevision !== proof.credentialRevision
        || (current.twoFactorProviderId || null) !== (proof.providerId || null))
        fail("TWO_FACTOR_ADMIN_PROOF_STALE", 409);
}
export async function adminCreateEnrollment(adminAccountId, input, meta, rotate = false, expectedRequestId) {
    const adminProof = await assertFreshAdminProof(adminAccountId, input, meta);
    const account = await db.account.findUnique({
        where: { id: input.accountId },
        select: {
            id: true,
            type: true,
            isActive: true,
            passwordHash: true,
            credentialRevision: true,
            twoFactorProviderId: true,
        },
    });
    assertInteractiveLocalAccount(account);
    if (account.twoFactorProviderId && account.twoFactorProviderId !== LOCAL_PROVIDER_ID) {
        fail("TWO_FACTOR_PROVIDER_MISMATCH", 409);
    }
    if (await activeLocalCredential(account))
        fail("TWO_FACTOR_TOTP_ALREADY_ACTIVE", 409);
    const existing = await db.securityTwoFactorEnrollment.findUnique({ where: { accountId: account.id } });
    if (rotate && (!existing || existing.id !== expectedRequestId)) {
        fail("TWO_FACTOR_ENROLLMENT_CHANGED", 409);
    }
    if (existing && !rotate) {
        await assertAdminProofStillCurrent(db, adminAccountId, adminProof);
        return Object.freeze({
            ok: true,
            schemaVersion: "bonni.two-factor-enrollment/v1",
            accountId: account.id,
            twoFactorActive: false,
            request: publicEnrollmentRequest(existing),
            enrollmentPassword: null,
            enrollmentPasswordShownOnce: false,
            requiresRotation: true,
        });
    }
    const policy = getLocalTwoFactorPolicy();
    const expiresAt = addMinutes(input.expiresInMinutes ?? policy.enrollmentExpiresMinutes);
    const password = generateEnrollmentPassword();
    const passwordHash = enrollmentPasswordHash(account.id, password);
    let enrollment;
    try {
        enrollment = await db.$transaction(async (tx) => {
            await assertAdminProofStillCurrent(tx, adminAccountId, adminProof);
            const currentTarget = await tx.account.findUnique({
                where: { id: account.id },
                select: {
                    type: true,
                    isActive: true,
                    passwordHash: true,
                    credentialRevision: true,
                    twoFactorProviderId: true,
                },
            });
            if (!currentTarget
                || currentTarget.isActive !== true
                || (currentTarget.type !== "MEMBER" && currentTarget.type !== "ADMIN")
                || !currentTarget.passwordHash
                || currentTarget.credentialRevision !== account.credentialRevision
                || (currentTarget.twoFactorProviderId || null) !== (account.twoFactorProviderId || null))
                fail("TWO_FACTOR_ACCOUNT_CHANGED", 409);
            await tx.securityTwoFactorCredential.updateMany({
                where: { accountId: account.id, method: "TOTP", status: "PENDING" },
                data: {
                    status: "REVOKED",
                    enrollmentSlot: null,
                    secretEncrypted: null,
                    secretFingerprint: null,
                    disabledAt: new Date(),
                },
            });
            if (existing) {
                const revoked = await tx.securityTwoFactorEnrollment.updateMany({
                    where: { id: existing.id, accountId: account.id },
                    data: { status: "REVOKED", enrollmentPasswordHash: null, revokedAt: new Date() },
                });
                if (revoked.count !== 1)
                    fail("TWO_FACTOR_ENROLLMENT_CHANGED", 409);
                await tx.securityTwoFactorEnrollment.delete({ where: { id: existing.id } });
            }
            return tx.securityTwoFactorEnrollment.create({
                data: {
                    accountId: account.id,
                    requestedByAccountId: adminAccountId,
                    providerId: LOCAL_PROVIDER_ID,
                    enrollmentPasswordHash: passwordHash,
                    status: "PENDING",
                    attempts: 0,
                    maxAttempts: policy.maxAttempts,
                    credentialRevision: account.credentialRevision,
                    expiresAt,
                },
            });
        });
    }
    catch (error) {
        if (!rotate && error?.code === "P2002") {
            const raced = await db.securityTwoFactorEnrollment.findUnique({ where: { accountId: account.id } });
            if (raced) {
                await assertAdminProofStillCurrent(db, adminAccountId, adminProof);
                return Object.freeze({
                    ok: true,
                    schemaVersion: "bonni.two-factor-enrollment/v1",
                    accountId: account.id,
                    twoFactorActive: false,
                    request: publicEnrollmentRequest(raced),
                    enrollmentPassword: null,
                    enrollmentPasswordShownOnce: false,
                    requiresRotation: true,
                });
            }
        }
        throw error;
    }
    await writeAudit({
        accountId: account.id,
        event: "TWO_FACTOR_ENROLLMENT_ADMIN_CREATED",
        result: "SUCCESS",
        meta,
        metadataJson: { enrollmentId: enrollment.id, requestedByAccountId: adminAccountId, expiresAt },
    });
    return Object.freeze({
        ok: true,
        schemaVersion: "bonni.two-factor-enrollment/v1",
        accountId: account.id,
        twoFactorActive: false,
        request: publicEnrollmentRequest(enrollment),
        enrollmentPassword: password,
        enrollmentPasswordShownOnce: true,
        requiresRotation: false,
        replacedRequestId: existing?.id || null,
    });
}
export async function adminRotateEnrollment(adminAccountId, requestId, input, meta) {
    const existing = await db.securityTwoFactorEnrollment.findUnique({ where: { id: requestId } });
    if (!existing)
        fail("TWO_FACTOR_ENROLLMENT_NOT_FOUND", 404);
    return adminCreateEnrollment(adminAccountId, { ...input, accountId: existing.accountId }, meta, true, requestId);
}
export async function getAdminEnrollmentStatus(accountId) {
    await expireEnrollment(accountId);
    const [account, enrollment] = await Promise.all([
        db.account.findUnique({
            where: { id: accountId },
            select: { id: true, type: true, isActive: true, passwordHash: true, credentialRevision: true },
        }),
        db.securityTwoFactorEnrollment.findUnique({ where: { accountId } }),
    ]);
    assertInteractiveLocalAccount(account);
    const context = await providerContext(accountId);
    return Object.freeze({
        ok: true,
        schemaVersion: "bonni.two-factor-enrollment/v1",
        accountId,
        twoFactorActive: context.enrolled,
        request: enrollment && !context.enrolled && enrollment.status !== "CONFIRMED"
            ? publicEnrollmentRequest(enrollment)
            : null,
        localEnrollmentEligible: !context.enrolled && context.id === LOCAL_PROVIDER_ID,
    });
}
async function registerEnrollmentFailure(enrollment) {
    const updated = await db.securityTwoFactorEnrollment.updateMany({
        where: {
            id: enrollment.id,
            status: "PENDING",
            enrollmentPasswordHash: { not: null },
        },
        data: { attempts: { increment: 1 } },
    });
    if (updated.count !== 1)
        return;
    const current = await db.securityTwoFactorEnrollment.findUnique({ where: { id: enrollment.id } });
    if (current?.status === "PENDING" && current.attempts >= current.maxAttempts) {
        await db.securityTwoFactorEnrollment.updateMany({
            where: { id: enrollment.id, status: "PENDING", attempts: { gte: current.maxAttempts } },
            data: { status: "FAILED", enrollmentPasswordHash: null, revokedAt: new Date() },
        });
    }
}
export async function setupTotp(accountId, input, meta) {
    const [account, enrollment] = await Promise.all([
        db.account.findUnique({
            where: { id: accountId },
            select: {
                id: true,
                loginName: true,
                email: true,
                type: true,
                isActive: true,
                passwordHash: true,
                credentialRevision: true,
                twoFactorProviderId: true,
                privateDataTwoFactorEnrolledAt: true,
            },
        }),
        db.securityTwoFactorEnrollment.findFirst({ where: { id: input.enrollmentRequestId, accountId } }),
    ]);
    assertInteractiveLocalAccount(account);
    if (account.twoFactorProviderId && account.twoFactorProviderId !== LOCAL_PROVIDER_ID) {
        fail("TWO_FACTOR_PROVIDER_MISMATCH", 409);
    }
    const validEnrollment = enrollment
        && enrollment.status === "PENDING"
        && enrollment.enrollmentPasswordHash
        && enrollment.expiresAt > new Date()
        && enrollment.attempts < enrollment.maxAttempts
        && enrollment.credentialRevision === account.credentialRevision;
    if (!validEnrollment) {
        if (enrollment?.status === "PENDING" && enrollment.expiresAt <= new Date()) {
            await db.securityTwoFactorEnrollment.updateMany({
                where: { id: enrollment.id, status: "PENDING" },
                data: { status: "EXPIRED", enrollmentPasswordHash: null, revokedAt: new Date() },
            });
        }
        fail("TWO_FACTOR_ENROLLMENT_NOT_USABLE", 409);
    }
    const [ownPasswordOk, enrollmentPasswordOk] = await Promise.all([
        verifyExactLocalPassword(input.currentPassword, account.passwordHash),
        Promise.resolve(verifyEnrollmentPasswordHash(accountId, input.enrollmentPassword, enrollment.enrollmentPasswordHash)),
    ]);
    if (!ownPasswordOk || !enrollmentPasswordOk) {
        await registerEnrollmentFailure(enrollment);
        await writeAudit({
            accountId,
            event: "TWO_FACTOR_ENROLLMENT_PROOF_FAILED",
            result: "FAILURE",
            meta,
            metadataJson: { enrollmentId: enrollment.id },
        });
        fail("TWO_FACTOR_ENROLLMENT_PROOF_INVALID", 401);
    }
    const issuer = "Bonni Core";
    const label = account.email || account.loginName || account.id;
    const secret = generateTotpSecret();
    const qrCodeDataUrl = await buildTotpQrCodeDataUrl(buildTotpOtpauthUri({ issuer, label, secret }));
    const credential = await db.$transaction(async (tx) => {
        const claimed = await tx.securityTwoFactorEnrollment.updateMany({
            where: {
                id: enrollment.id,
                accountId,
                status: "PENDING",
                attempts: enrollment.attempts,
                credentialRevision: account.credentialRevision,
                enrollmentPasswordHash: enrollment.enrollmentPasswordHash,
                expiresAt: { gt: new Date() },
            },
            data: {
                status: "CLAIMED",
                enrollmentPasswordHash: null,
                claimedAt: new Date(),
            },
        });
        if (claimed.count !== 1)
            fail("TWO_FACTOR_ENROLLMENT_ALREADY_USED", 409);
        await tx.securityTwoFactorCredential.updateMany({
            where: { accountId, method: "TOTP", status: "PENDING" },
            data: {
                status: "REVOKED",
                enrollmentSlot: null,
                secretEncrypted: null,
                secretFingerprint: null,
                disabledAt: new Date(),
            },
        });
        return tx.securityTwoFactorCredential.create({
            data: {
                accountId,
                method: "TOTP",
                label,
                secretEncrypted: encryptSecret(secret),
                secretFingerprint: fingerprintSecret(secret),
                status: "PENDING",
                enrollmentSlot: accountId,
                credentialRevision: account.credentialRevision,
                metadataJson: { issuer, enrollmentId: enrollment.id },
            },
        });
    });
    await writeAudit({
        accountId,
        event: "TWO_FACTOR_TOTP_QR_ISSUED_TO_ACCOUNT",
        method: "TOTP",
        result: "SUCCESS",
        meta,
        metadataJson: { credentialId: credential.id, enrollmentId: enrollment.id },
    });
    return Object.freeze({
        credentialId: credential.id,
        method: "TOTP",
        qrCodeDataUrl,
        issuer,
        label,
        confirmationExpiresAt: enrollment.expiresAt,
        note: "QR-Code jetzt mit der Authenticator-App scannen. Er kann aus Sicherheitsgründen nicht erneut angezeigt werden.",
    });
}
async function createRecoveryCodes(tx, accountId, credentialRevision, count = 10) {
    await tx.securityTwoFactorRecoveryCode.deleteMany({ where: { accountId } });
    const codes = Array.from({ length: count }, () => generateRecoveryCode());
    await tx.securityTwoFactorRecoveryCode.createMany({
        data: codes.map((code) => ({
            accountId,
            codeHash: recoveryCodeHash(accountId, code),
            lastFour: normalizeRecoveryCode(code).slice(-4),
            credentialRevision,
        })),
    });
    return codes;
}
async function revokeAccountSessions(tx, accountId) {
    const now = new Date();
    await tx.session.updateMany({ where: { accountId, endedAt: null }, data: { endedAt: now } });
    await tx.refreshToken.updateMany({ where: { accountId, revokedAt: null }, data: { revokedAt: now } });
}
export async function confirmTotp(accountId, input, meta) {
    const [account, credential, enrollment] = await Promise.all([
        db.account.findUnique({
            where: { id: accountId },
            select: {
                id: true,
                type: true,
                isActive: true,
                passwordHash: true,
                credentialRevision: true,
                twoFactorProviderId: true,
                privateDataTwoFactorEnrolledAt: true,
            },
        }),
        db.securityTwoFactorCredential.findFirst({
            where: { id: input.credentialId, accountId, method: "TOTP", enrollmentSlot: accountId },
        }),
        db.securityTwoFactorEnrollment.findFirst({ where: { id: input.enrollmentRequestId, accountId } }),
    ]);
    assertInteractiveLocalAccount(account);
    const credentialEnrollmentId = credential?.metadataJson && typeof credential.metadataJson === "object"
        ? String(credential.metadataJson.enrollmentId || "")
        : "";
    if (credential?.status === "ACTIVE"
        && enrollment?.status === "CONFIRMED"
        && credentialEnrollmentId === input.enrollmentRequestId
        && credential.credentialRevision === account.credentialRevision) {
        return Object.freeze({ alreadyConfirmed: true, recoveryCodes: [] });
    }
    if (!credential?.secretEncrypted
        || credential.credentialRevision !== account.credentialRevision
        || !enrollment
        || enrollment.id !== input.enrollmentRequestId
        || enrollment.status !== "CLAIMED"
        || enrollment.credentialRevision !== account.credentialRevision
        || (account.twoFactorProviderId && account.twoFactorProviderId !== LOCAL_PROVIDER_ID))
        fail("TWO_FACTOR_PENDING_CREDENTIAL_NOT_FOUND", 404);
    if (enrollment.expiresAt <= new Date()) {
        await db.$transaction(async (tx) => {
            await tx.securityTwoFactorCredential.updateMany({
                where: { id: credential.id, accountId, status: "PENDING", credentialRevision: account.credentialRevision },
                data: {
                    status: "REVOKED",
                    enrollmentSlot: null,
                    secretEncrypted: null,
                    secretFingerprint: null,
                    disabledAt: new Date(),
                },
            });
            await tx.securityTwoFactorEnrollment.updateMany({
                where: { id: enrollment.id, status: "CLAIMED" },
                data: { status: "EXPIRED", enrollmentPasswordHash: null, revokedAt: new Date() },
            });
        });
        fail("TWO_FACTOR_ENROLLMENT_EXPIRED", 401);
    }
    const policy = getLocalTwoFactorPolicy();
    const setupScope = scopeKey("TOTP_SETUP");
    await assertNotLocked(accountId, setupScope, policy.maxAttempts);
    const counter = matchTotpCounter(decryptSecret(credential.secretEncrypted), input.code);
    if (counter === null) {
        const lockout = await registerFailure(accountId, setupScope, policy.maxAttempts);
        fail(lockout.locked ? "TWO_FACTOR_TEMPORARILY_LOCKED" : "TWO_FACTOR_INVALID_CODE", lockout.locked ? 423 : 401, lockout);
    }
    const nextRevision = account.credentialRevision + 1;
    let result;
    try {
        result = await db.$transaction(async (tx) => {
            const txNow = new Date();
            const enrollmentUpdated = await tx.securityTwoFactorEnrollment.updateMany({
                where: {
                    id: enrollment.id,
                    accountId,
                    status: "CLAIMED",
                    credentialRevision: account.credentialRevision,
                    expiresAt: { gt: txNow },
                },
                data: {
                    status: "CONFIRMED",
                    confirmedAt: txNow,
                    enrollmentPasswordHash: null,
                },
            });
            if (enrollmentUpdated.count !== 1)
                fail("TWO_FACTOR_ENROLLMENT_CHANGED", 409);
            const activated = await tx.securityTwoFactorCredential.updateMany({
                where: {
                    id: credential.id,
                    accountId,
                    status: "PENDING",
                    enrollmentSlot: accountId,
                    credentialRevision: account.credentialRevision,
                    lastAcceptedTotpCounter: null,
                },
                data: {
                    status: "ACTIVE",
                    confirmedAt: txNow,
                    lastUsedAt: txNow,
                    lastAcceptedTotpCounter: counter,
                    credentialRevision: nextRevision,
                },
            });
            if (activated.count !== 1)
                fail("TWO_FACTOR_CONFIRM_ALREADY_USED", 409);
            const accountUpdated = await tx.account.updateMany({
                where: { id: accountId, credentialRevision: account.credentialRevision, isActive: true, type: { in: ["MEMBER", "ADMIN"] } },
                data: {
                    credentialRevision: { increment: 1 },
                    twoFactorProviderId: LOCAL_PROVIDER_ID,
                    twoFactorEnrolledAt: txNow,
                    privateDataTwoFactorEnrolledAt: account.privateDataTwoFactorEnrolledAt || txNow,
                },
            });
            if (accountUpdated.count !== 1)
                fail("TWO_FACTOR_ACCOUNT_CHANGED", 409);
            await cancelPendingRecoveryAfterCredentialChange(tx, { accountId, now: txNow });
            const recoveryCodes = await createRecoveryCodes(tx, accountId, nextRevision);
            await revokeAccountSessions(tx, accountId);
            return { recoveryCodes };
        });
    }
    catch (error) {
        if (error?.code === "TWO_FACTOR_CONFIRM_ALREADY_USED"
            || error?.code === "TWO_FACTOR_ACCOUNT_CHANGED"
            || error?.code === "TWO_FACTOR_ENROLLMENT_CHANGED") {
            const [currentAccount, currentCredential, currentEnrollment] = await Promise.all([
                db.account.findUnique({ where: { id: accountId }, select: { credentialRevision: true } }),
                db.securityTwoFactorCredential.findUnique({ where: { id: credential.id } }),
                db.securityTwoFactorEnrollment.findUnique({ where: { id: enrollment.id } }),
            ]);
            const currentEnrollmentId = currentCredential?.metadataJson && typeof currentCredential.metadataJson === "object"
                ? String(currentCredential.metadataJson.enrollmentId || "")
                : "";
            if (currentAccount
                && currentCredential?.status === "ACTIVE"
                && currentEnrollment?.status === "CONFIRMED"
                && currentEnrollmentId === input.enrollmentRequestId
                && currentCredential.credentialRevision === currentAccount.credentialRevision)
                return Object.freeze({ alreadyConfirmed: true, recoveryCodes: [] });
        }
        throw error;
    }
    await clearFailures(accountId, setupScope);
    await writeAudit({
        accountId,
        event: "TWO_FACTOR_TOTP_ENABLED",
        method: "TOTP",
        result: "SUCCESS",
        meta,
        metadataJson: { credentialId: credential.id, credentialRevision: nextRevision },
    });
    return Object.freeze({
        alreadyConfirmed: false,
        credential: publicCredential({ ...credential, status: "ACTIVE", confirmedAt: new Date() }),
        credentialRevision: nextRevision,
        recoveryCodes: result.recoveryCodes,
        recoveryCodesNote: "Diese Wiederherstellungscodes werden nur einmal angezeigt und müssen sicher offline abgelegt werden.",
        sessionsRevoked: true,
    });
}
function canonicalChallengeScope(input) {
    if (input.purpose === "ACCOUNT_RECOVERY_APPROVAL"
        || input.purpose === "ACCOUNT_RECOVERY_SUPPORT_CODE"
        || input.purpose === "ACCOUNT_RECOVERY_POLICY") {
        const moduleKey = String(input.moduleKey || "").trim().toLowerCase();
        if (moduleKey !== "core.account-recovery")
            fail("TWO_FACTOR_MODULE_KEY_INVALID", 500);
        const accessScope = String(input.accessScope || "").trim().toUpperCase();
        if (!/^ACCOUNT_RECOVERY:[A-Z0-9._:-]{8,360}$/u.test(accessScope)) {
            fail("TWO_FACTOR_ACCESS_SCOPE_INVALID", 500);
        }
        return `${moduleKey}:${accessScope}`;
    }
    if (input.purpose !== "MODULE_PRIVATE_DATA_ACCESS")
        return `CORE.${input.purpose}`;
    const moduleKey = String(input.moduleKey || "").trim().toLowerCase();
    if (!/^(app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]$/u.test(moduleKey)) {
        fail("TWO_FACTOR_MODULE_KEY_INVALID", 500);
    }
    const accessScope = String(input.accessScope || "PRIVATE_DATA").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9._:-]{2,119}$/u.test(accessScope))
        fail("TWO_FACTOR_ACCESS_SCOPE_INVALID", 500);
    return `${moduleKey}:${accessScope}`;
}
function canonicalChallengeSubject(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "string"
        || value.length === 0
        || [...value].length > 180
        || /[\r\n\0]/u.test(value)
        || Buffer.from(value, "utf8").toString("utf8") !== value)
        fail("TWO_FACTOR_SUBJECT_ID_INVALID", 400);
    return value;
}
export async function createChallenge(accountId, input, meta) {
    const [context, account] = await Promise.all([
        providerContext(accountId),
        db.account.findUnique({
            where: { id: accountId },
            select: { id: true, type: true, isActive: true, passwordHash: true, credentialRevision: true, twoFactorProviderId: true },
        }),
    ]);
    assertInteractiveLocalAccount(account);
    if (!context.enrolled || !context.available || !context.configured) {
        fail(context.enrolled ? "TWO_FACTOR_PROVIDER_UNAVAILABLE" : "TWO_FACTOR_NOT_CONFIGURED", context.enrolled ? 503 : 409);
    }
    if (String(account.twoFactorProviderId || context.id).toLowerCase() !== context.id) {
        fail("TWO_FACTOR_PROVIDER_CHANGED", 409);
    }
    const lockScope = scopeKey(input.purpose);
    await assertNotLocked(accountId, lockScope, context.maxAttempts);
    const credential = context.id === LOCAL_PROVIDER_ID ? await activeLocalCredential(account) : null;
    if (context.id === LOCAL_PROVIDER_ID && (!credential
        || credential.credentialRevision !== account.credentialRevision
        || credential.enrollmentSlot !== accountId))
        fail("TWO_FACTOR_CREDENTIAL_REVISION_MISMATCH", 409);
    const accessScope = canonicalChallengeScope(input);
    const subjectId = canonicalChallengeSubject(input.subjectId);
    const challenge = await db.securityTwoFactorChallenge.create({
        data: {
            accountId,
            purpose: input.purpose,
            method: "TOTP",
            credentialId: credential?.id,
            status: "PENDING",
            maxAttempts: context.maxAttempts,
            providerId: context.id,
            credentialRevision: account.credentialRevision,
            accessScope,
            moduleKey: input.moduleKey ? String(input.moduleKey).trim().toLowerCase() : null,
            subjectId,
            expiresAt: addSeconds(context.challengeExpiresSeconds),
            ipAddress: meta?.ip,
            userAgent: meta?.userAgent,
        },
    });
    return Object.freeze({
        id: challenge.id,
        purpose: challenge.purpose,
        method: context.externallyManaged ? "EXTERNAL" : "TOTP",
        provider: context.id,
        providerLabel: context.label,
        proofFields: context.proofFields,
        status: challenge.status,
        expiresAt: challenge.expiresAt,
        maxAttempts: challenge.maxAttempts,
        accessScope,
    });
}
function localProofMode(proof) {
    const code = typeof proof.code === "string" && /^\d{6}(?:\d{2})?$/u.test(proof.code) ? proof.code : null;
    const recoveryCode = typeof proof.recoveryCode === "string" && /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/u.test(proof.recoveryCode)
        ? proof.recoveryCode
        : null;
    if (Number(Boolean(code)) + Number(Boolean(recoveryCode)) !== 1 || proof.token || proof.password) {
        return { mode: "INVALID" };
    }
    return code ? { mode: "TOTP", code } : { mode: "RECOVERY_CODE", recoveryCode: recoveryCode };
}
async function externalVerification(accountId, providerId, purpose, proof) {
    const provider = getRegisteredExternalTwoFactorProviderById(providerId);
    if (!provider)
        fail("TWO_FACTOR_PROVIDER_UNAVAILABLE", 503);
    const state = await provider.getState().catch(() => null);
    if (!state?.enabled || !state.configured)
        fail("TWO_FACTOR_PROVIDER_UNAVAILABLE", 503);
    const account = await db.account.findUnique({ where: { id: accountId }, select: { loginName: true } });
    if (!account?.loginName)
        fail("TWO_FACTOR_ACCOUNT_NOT_ELIGIBLE", 409);
    try {
        const result = await provider.verify({ accountId, loginName: account.loginName, purpose, proof });
        return result.ok === true;
    }
    catch (error) {
        const status = Number(error?.statusCode || error?.status);
        if (status === 503)
            fail("TWO_FACTOR_PROVIDER_UNAVAILABLE", 503);
        if (status >= 400 && status < 500)
            return false;
        fail("TWO_FACTOR_PROVIDER_UNAVAILABLE", 503);
    }
}
async function markChallengeFailure(challenge, maxAttempts, meta) {
    const failureNow = new Date();
    const updated = await db.securityTwoFactorChallenge.updateMany({
        where: {
            id: challenge.id,
            status: "PENDING",
            credentialRevision: challenge.credentialRevision,
            attempts: { lt: maxAttempts },
            expiresAt: { gt: failureNow },
        },
        data: {
            attempts: { increment: 1 },
        },
    });
    if (updated.count !== 1) {
        if (challenge.expiresAt <= failureNow) {
            await db.securityTwoFactorChallenge.updateMany({
                where: {
                    id: challenge.id,
                    status: "PENDING",
                    credentialRevision: challenge.credentialRevision,
                    expiresAt: { lte: failureNow },
                },
                data: { status: "EXPIRED" },
            });
            fail("TWO_FACTOR_CHALLENGE_EXPIRED", 401);
        }
        fail("TWO_FACTOR_CHALLENGE_CHANGED", 409);
    }
    const current = await db.securityTwoFactorChallenge.findUnique({ where: { id: challenge.id } });
    const nextAttempts = current?.attempts ?? maxAttempts;
    if (nextAttempts >= maxAttempts) {
        await db.securityTwoFactorChallenge.updateMany({
            where: { id: challenge.id, status: "PENDING", attempts: { gte: maxAttempts } },
            data: { status: "FAILED" },
        });
    }
    const lockout = await registerFailure(challenge.accountId, scopeKey(challenge.purpose), maxAttempts);
    await writeAudit({
        accountId: challenge.accountId,
        event: lockout.locked ? "TWO_FACTOR_CHALLENGE_LOCKED" : "TWO_FACTOR_CHALLENGE_VERIFY_FAILED",
        purpose: challenge.purpose,
        result: lockout.locked ? "BLOCKED" : "FAILURE",
        meta,
        metadataJson: { challengeId: challenge.id, attempts: nextAttempts },
    });
    fail(lockout.locked ? "TWO_FACTOR_TEMPORARILY_LOCKED" : "TWO_FACTOR_INVALID_CODE", lockout.locked ? 423 : 401, lockout);
}
export async function verifyChallenge(accountId, challengeId, proof, meta) {
    const [challenge, account] = await Promise.all([
        db.securityTwoFactorChallenge.findUnique({ where: { id: challengeId } }),
        db.account.findUnique({
            where: { id: accountId },
            select: { id: true, type: true, isActive: true, passwordHash: true, credentialRevision: true, twoFactorProviderId: true },
        }),
    ]);
    assertInteractiveLocalAccount(account);
    if (!challenge || challenge.accountId !== accountId)
        fail("TWO_FACTOR_CHALLENGE_NOT_FOUND", 404);
    const maxAttempts = boundedInteger(challenge.maxAttempts, 8, 1, 20);
    await assertNotLocked(accountId, scopeKey(challenge.purpose), maxAttempts);
    if (challenge.status !== "PENDING")
        fail("TWO_FACTOR_CHALLENGE_NOT_PENDING", 409);
    if (challenge.credentialRevision !== account.credentialRevision)
        fail("TWO_FACTOR_CREDENTIAL_REVISION_MISMATCH", 409);
    if (challenge.expiresAt <= new Date()) {
        await db.securityTwoFactorChallenge.updateMany({
            where: { id: challenge.id, status: "PENDING", credentialRevision: challenge.credentialRevision },
            data: { status: "EXPIRED" },
        });
        fail("TWO_FACTOR_CHALLENGE_EXPIRED", 401);
    }
    if (challenge.attempts >= maxAttempts)
        fail("TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS", 423);
    if (String(account.twoFactorProviderId || "").toLowerCase() !== challenge.providerId) {
        fail("TWO_FACTOR_PROVIDER_CHANGED", 409);
    }
    let method = "TOTP";
    if (challenge.providerId === LOCAL_PROVIDER_ID) {
        assertProviderProofShape({
            id: LOCAL_PROVIDER_ID,
            label: "Authenticator-App (TOTP)",
            externallyManaged: false,
            enrolled: true,
            configured: true,
            available: true,
            proofFields: LOCAL_PROOF_FIELDS,
            maxAttempts,
            challengeExpiresSeconds: 60,
        }, proof);
        const mode = localProofMode(proof);
        if (mode.mode === "INVALID")
            return markChallengeFailure(challenge, maxAttempts, meta);
        if (mode.mode === "RECOVERY_CODE") {
            method = "RECOVERY_CODE";
            const hash = recoveryCodeHash(accountId, mode.recoveryCode);
            const verified = await db.$transaction(async (tx) => {
                const txNow = new Date();
                if (challenge.expiresAt <= txNow)
                    fail("TWO_FACTOR_CHALLENGE_EXPIRED", 401);
                const consumed = await tx.securityTwoFactorRecoveryCode.updateMany({
                    where: { accountId, codeHash: hash, usedAt: null, credentialRevision: account.credentialRevision },
                    data: { usedAt: txNow },
                });
                if (consumed.count !== 1)
                    return false;
                const challengeUpdated = await tx.securityTwoFactorChallenge.updateMany({
                    where: {
                        id: challenge.id,
                        status: "PENDING",
                        attempts: challenge.attempts,
                        credentialRevision: account.credentialRevision,
                        expiresAt: { gt: txNow },
                    },
                    data: { status: "VERIFIED", verifiedAt: txNow, method: "RECOVERY_CODE" },
                });
                if (challengeUpdated.count !== 1)
                    fail("TWO_FACTOR_CHALLENGE_CHANGED", 409);
                return true;
            });
            if (!verified)
                return markChallengeFailure(challenge, maxAttempts, meta);
        }
        else {
            const credential = await db.securityTwoFactorCredential.findFirst({
                where: {
                    id: challenge.credentialId,
                    accountId,
                    status: "ACTIVE",
                    enrollmentSlot: accountId,
                    credentialRevision: account.credentialRevision,
                },
            });
            if (!credential?.secretEncrypted)
                fail("TWO_FACTOR_NOT_CONFIGURED", 409);
            const counter = matchTotpCounter(decryptSecret(credential.secretEncrypted), mode.code);
            if (counter === null)
                return markChallengeFailure(challenge, maxAttempts, meta);
            const verified = await db.$transaction(async (tx) => {
                const txNow = new Date();
                if (challenge.expiresAt <= txNow)
                    fail("TWO_FACTOR_CHALLENGE_EXPIRED", 401);
                const credentialUpdated = await tx.securityTwoFactorCredential.updateMany({
                    where: {
                        id: credential.id,
                        accountId,
                        status: "ACTIVE",
                        credentialRevision: account.credentialRevision,
                        OR: [
                            { lastAcceptedTotpCounter: null },
                            { lastAcceptedTotpCounter: { lt: counter } },
                        ],
                    },
                    data: { lastAcceptedTotpCounter: counter, lastUsedAt: txNow },
                });
                if (credentialUpdated.count !== 1)
                    fail("TWO_FACTOR_CODE_REPLAYED", 409);
                const challengeUpdated = await tx.securityTwoFactorChallenge.updateMany({
                    where: {
                        id: challenge.id,
                        status: "PENDING",
                        attempts: challenge.attempts,
                        credentialRevision: account.credentialRevision,
                        expiresAt: { gt: txNow },
                    },
                    data: { status: "VERIFIED", verifiedAt: txNow, method: "TOTP" },
                });
                if (challengeUpdated.count !== 1)
                    fail("TWO_FACTOR_CHALLENGE_CHANGED", 409);
                return true;
            });
            if (!verified)
                return markChallengeFailure(challenge, maxAttempts, meta);
        }
    }
    else {
        const context = await externalContext(challenge.providerId, true);
        if (!context.available || !context.configured)
            fail("TWO_FACTOR_PROVIDER_UNAVAILABLE", 503);
        assertProviderProofShape(context, proof);
        const ok = await externalVerification(accountId, challenge.providerId, challenge.purpose, proof);
        if (!ok)
            return markChallengeFailure(challenge, maxAttempts, meta);
        const verifiedAt = new Date();
        if (challenge.expiresAt <= verifiedAt) {
            await db.securityTwoFactorChallenge.updateMany({
                where: {
                    id: challenge.id,
                    status: "PENDING",
                    credentialRevision: account.credentialRevision,
                    expiresAt: { lte: verifiedAt },
                },
                data: { status: "EXPIRED" },
            });
            fail("TWO_FACTOR_CHALLENGE_EXPIRED", 401);
        }
        const updated = await db.securityTwoFactorChallenge.updateMany({
            where: {
                id: challenge.id,
                status: "PENDING",
                attempts: challenge.attempts,
                credentialRevision: account.credentialRevision,
                expiresAt: { gt: verifiedAt },
            },
            data: { status: "VERIFIED", verifiedAt },
        });
        if (updated.count !== 1)
            fail("TWO_FACTOR_CHALLENGE_CHANGED", 409);
    }
    await clearFailures(accountId, scopeKey(challenge.purpose));
    await writeAudit({
        accountId,
        event: "TWO_FACTOR_CHALLENGE_VERIFIED",
        purpose: challenge.purpose,
        method,
        result: "SUCCESS",
        meta,
        metadataJson: { challengeId: challenge.id, providerId: challenge.providerId },
    });
    return Object.freeze({
        id: challenge.id,
        accountId,
        purpose: challenge.purpose,
        method,
        status: "VERIFIED",
        verifiedAt: new Date(),
        expiresAt: challenge.expiresAt,
        provider: challenge.providerId,
        credentialRevision: challenge.credentialRevision,
        accessScope: challenge.accessScope,
        moduleKey: challenge.moduleKey,
        subjectId: challenge.subjectId,
    });
}
export async function verifyLoginChallenge(challengeId, proof, meta) {
    const challenge = await db.securityTwoFactorChallenge.findUnique({ where: { id: challengeId } });
    if (!challenge || challenge.purpose !== "LOGIN")
        fail("TWO_FACTOR_LOGIN_CHALLENGE_NOT_FOUND", 404);
    return verifyChallenge(challenge.accountId, challengeId, proof, meta);
}
export async function consumeVerifiedChallenge(input) {
    const expectedScope = canonicalChallengeScope({
        purpose: input.purpose,
        moduleKey: input.moduleKey,
        accessScope: input.accessScope,
        subjectId: input.subjectId,
    });
    const expectedSubjectId = canonicalChallengeSubject(input.subjectId);
    const maxAgeMs = boundedInteger(input.maxAgeMinutes, 10, 1, 10) * 60 * 1000;
    return db.$transaction(async (tx) => {
        const [challenge, account] = await Promise.all([
            tx.securityTwoFactorChallenge.findUnique({ where: { id: input.challengeId } }),
            tx.account.findUnique({
                where: { id: input.accountId },
                select: {
                    id: true,
                    type: true,
                    isActive: true,
                    passwordHash: true,
                    credentialRevision: true,
                    twoFactorProviderId: true,
                },
            }),
        ]);
        if (!challenge || !account || challenge.accountId !== input.accountId || challenge.purpose !== input.purpose) {
            fail("TWO_FACTOR_AUTHORIZATION_NOT_FOUND", 404);
        }
        assertInteractiveLocalAccount(account);
        if (challenge.credentialRevision !== account.credentialRevision
            || challenge.providerId !== account.twoFactorProviderId
            || challenge.accessScope !== expectedScope
            || (input.moduleKey !== undefined && challenge.moduleKey !== String(input.moduleKey).trim().toLowerCase())
            || (challenge.subjectId || null) !== expectedSubjectId)
            fail("TWO_FACTOR_AUTHORIZATION_SCOPE_MISMATCH", 403);
        if (challenge.status !== "VERIFIED" || !challenge.verifiedAt || challenge.consumedAt) {
            fail("TWO_FACTOR_AUTHORIZATION_NOT_USABLE", 409);
        }
        if (challenge.verifiedAt.getTime() + maxAgeMs < Date.now() || challenge.expiresAt < new Date()) {
            fail("TWO_FACTOR_AUTHORIZATION_EXPIRED", 401);
        }
        const consumedAt = new Date();
        const consumed = await tx.securityTwoFactorChallenge.updateMany({
            where: {
                id: challenge.id,
                accountId: input.accountId,
                purpose: input.purpose,
                status: "VERIFIED",
                consumedAt: null,
                credentialRevision: account.credentialRevision,
                providerId: account.twoFactorProviderId,
                accessScope: expectedScope,
            },
            data: { status: "CONSUMED", consumedAt },
        });
        if (consumed.count !== 1)
            fail("TWO_FACTOR_AUTHORIZATION_NOT_USABLE", 409);
        const currentAccount = await tx.account.findUnique({
            where: { id: input.accountId },
            select: {
                id: true,
                type: true,
                isActive: true,
                passwordHash: true,
                credentialRevision: true,
                twoFactorProviderId: true,
            },
        });
        assertInteractiveLocalAccount(currentAccount);
        if (!currentAccount
            || currentAccount.credentialRevision !== account.credentialRevision
            || currentAccount.twoFactorProviderId !== account.twoFactorProviderId)
            fail("TWO_FACTOR_CREDENTIAL_REVISION_MISMATCH", 409);
        return Object.freeze({
            ...challenge,
            status: "CONSUMED",
            consumedAt,
            credentialRevision: account.credentialRevision,
            providerId: challenge.providerId,
            accessScope: expectedScope,
        });
    }, { isolationLevel: "Serializable" });
}
async function assertSensitiveProof(accountId, input, meta) {
    const challenge = await createChallenge(accountId, { purpose: "SECURITY_SETTINGS" }, meta);
    await verifyChallenge(accountId, challenge.id, proofFromInput(input), meta);
    return consumeVerifiedChallenge({ accountId, challengeId: challenge.id, purpose: "SECURITY_SETTINGS" });
}
export async function disableTwoFactor(accountId, input, meta) {
    const proof = await assertSensitiveProof(accountId, input, meta);
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: { credentialRevision: true, twoFactorProviderId: true },
    });
    if (!account)
        fail("ACCOUNT_NOT_FOUND", 404);
    if (account.credentialRevision !== proof.credentialRevision
        || account.twoFactorProviderId !== proof.providerId)
        fail("TWO_FACTOR_CREDENTIAL_REVISION_MISMATCH", 409);
    const nextRevision = account.credentialRevision + 1;
    const disabled = await db.$transaction(async (tx) => {
        const result = await tx.securityTwoFactorCredential.updateMany({
            where: { accountId, method: "TOTP", status: { in: ["ACTIVE", "PENDING"] } },
            data: {
                status: "REVOKED",
                disabledAt: new Date(),
                enrollmentSlot: null,
                secretEncrypted: null,
                secretFingerprint: null,
            },
        });
        if (account.twoFactorProviderId === LOCAL_PROVIDER_ID && result.count < 1) {
            fail("TWO_FACTOR_NOT_CONFIGURED", 409);
        }
        const accountUpdated = await tx.account.updateMany({
            where: {
                id: accountId,
                credentialRevision: account.credentialRevision,
                twoFactorProviderId: proof.providerId,
            },
            data: {
                credentialRevision: { increment: 1 },
                twoFactorProviderId: null,
                twoFactorEnrolledAt: null,
            },
        });
        if (accountUpdated.count !== 1)
            fail("TWO_FACTOR_ACCOUNT_CHANGED", 409);
        await cancelPendingRecoveryAfterCredentialChange(tx, { accountId });
        await tx.securityTwoFactorRecoveryCode.deleteMany({ where: { accountId } });
        await tx.securityTwoFactorEnrollment.updateMany({
            where: { accountId },
            data: { status: "REVOKED", enrollmentPasswordHash: null, revokedAt: new Date() },
        });
        await revokeAccountSessions(tx, accountId);
        return result.count;
    });
    await writeAudit({
        accountId,
        event: "TWO_FACTOR_DISABLED_FAIL_CLOSED",
        method: "TOTP",
        result: "SUCCESS",
        meta,
        metadataJson: { disabled, credentialRevision: nextRevision, reEnrollmentRequired: true },
    });
    return Object.freeze({ disabled, credentialRevision: nextRevision, reEnrollmentRequired: true, sessionsRevoked: true });
}
export async function regenerateRecoveryCodes(accountId, input, meta) {
    const proof = await assertSensitiveProof(accountId, input, meta);
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: { credentialRevision: true, twoFactorProviderId: true },
    });
    if (!account)
        fail("ACCOUNT_NOT_FOUND", 404);
    if (account.credentialRevision !== proof.credentialRevision
        || account.twoFactorProviderId !== proof.providerId
        || account.twoFactorProviderId !== LOCAL_PROVIDER_ID)
        fail("TWO_FACTOR_CREDENTIAL_REVISION_MISMATCH", 409);
    const nextRevision = account.credentialRevision + 1;
    const recoveryCodes = await db.$transaction(async (tx) => {
        const credential = await tx.securityTwoFactorCredential.updateMany({
            where: { accountId, status: "ACTIVE", credentialRevision: account.credentialRevision },
            data: { credentialRevision: nextRevision },
        });
        if (credential.count !== 1)
            fail("TWO_FACTOR_NOT_CONFIGURED", 409);
        const accountUpdated = await tx.account.updateMany({
            where: {
                id: accountId,
                credentialRevision: account.credentialRevision,
                twoFactorProviderId: proof.providerId,
            },
            data: { credentialRevision: { increment: 1 } },
        });
        if (accountUpdated.count !== 1)
            fail("TWO_FACTOR_ACCOUNT_CHANGED", 409);
        await cancelPendingRecoveryAfterCredentialChange(tx, { accountId });
        const codes = await createRecoveryCodes(tx, accountId, nextRevision);
        await revokeAccountSessions(tx, accountId);
        return codes;
    });
    await writeAudit({
        accountId,
        event: "TWO_FACTOR_RECOVERY_CODES_REGENERATED",
        method: "RECOVERY_CODE",
        result: "SUCCESS",
        meta,
        metadataJson: { credentialRevision: nextRevision },
    });
    return Object.freeze({
        recoveryCodes,
        credentialRevision: nextRevision,
        recoveryCodesNote: "Diese Wiederherstellungscodes werden nur einmal angezeigt und müssen sicher offline abgelegt werden.",
        sessionsRevoked: true,
    });
}
