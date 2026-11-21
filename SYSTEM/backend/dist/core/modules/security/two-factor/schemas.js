import { z } from "zod";
import { validateExactLocalPassword } from "../../identity/local-password-policy.js";
export const twoFactorPurposeSchema = z.enum([
    "LOGIN",
    "SECURITY_SETTINGS",
    "ADMIN_ELEVATION",
    "DSGVO_SUBJECT_DATA_VIEW",
    "DSGVO_SUBJECT_DATA_EXPORT",
    "DSGVO_SUBJECT_DATA_DELETE",
    "DSGVO_DELETION_RULE_UPDATE",
    "MODULE_PRIVATE_DATA_ACCESS",
    "ACCOUNT_RECOVERY_APPROVAL",
    "ACCOUNT_RECOVERY_SUPPORT_CODE",
    "ACCOUNT_RECOVERY_POLICY",
]);
const exactPassword = z.custom((value) => validateExactLocalPassword(value).ok, { message: "Passwort ist ungültig" });
const enrollmentPassword = z.string()
    .min(20)
    .max(80)
    .regex(/^[A-Za-z0-9_-]+$/u);
const totpCode = z.string().regex(/^\d{6}(?:\d{2})?$/u);
const recoveryCode = z.string().regex(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/u);
const externalToken = z.custom((value) => (typeof value === "string"
    && value.length > 0
    && [...value].length <= 128
    && !/[\r\n\0]/u.test(value)
    && Buffer.from(value, "utf8").toString("utf8") === value), { message: "Provider-Token ist ungültig" });
function hasPotentialProviderProof(value) {
    const present = ["code", "recoveryCode", "token", "password"]
        .filter((key) => typeof value[key] === "string" && value[key] !== "");
    return present.length > 0 && (!present.includes("recoveryCode") || present.length === 1);
}
export const adminCreateEnrollmentSchema = z.object({
    body: z.object({
        accountId: z.string().trim().min(1).max(160),
        expiresInMinutes: z.number().int().min(1).max(24 * 60).optional(),
        code: totpCode.optional(),
        recoveryCode: recoveryCode.optional(),
        token: externalToken.optional(),
        password: exactPassword.optional(),
    }).strict().refine(hasPotentialProviderProof, { message: "Aktueller Admin-Nachweis ist erforderlich" }),
});
export const adminRotateEnrollmentSchema = z.object({
    params: z.object({ requestId: z.string().trim().min(1).max(160) }),
    body: z.object({
        expiresInMinutes: z.number().int().min(1).max(24 * 60).optional(),
        code: totpCode.optional(),
        recoveryCode: recoveryCode.optional(),
        token: externalToken.optional(),
        password: exactPassword.optional(),
    }).strict().refine(hasPotentialProviderProof, { message: "Aktueller Admin-Nachweis ist erforderlich" }),
});
export const setupTotpSchema = z.object({
    body: z.object({
        enrollmentRequestId: z.string().trim().min(1).max(160),
        enrollmentPassword,
        currentPassword: exactPassword,
    }).strict(),
});
export const confirmTotpSchema = z.object({
    body: z.object({
        enrollmentRequestId: z.string().trim().min(1).max(160),
        credentialId: z.string().trim().min(1).max(160),
        code: totpCode,
    }).strict(),
});
export const createChallengeSchema = z.object({
    body: z.object({
        purpose: twoFactorPurposeSchema.exclude([
            "LOGIN",
            "MODULE_PRIVATE_DATA_ACCESS",
            "ACCOUNT_RECOVERY_APPROVAL",
            "ACCOUNT_RECOVERY_SUPPORT_CODE",
            "ACCOUNT_RECOVERY_POLICY",
        ]),
    }).strict(),
});
export const verifyChallengeSchema = z.object({
    params: z.object({ id: z.string().trim().min(1).max(160) }),
    body: z.object({
        code: totpCode.optional(),
        recoveryCode: recoveryCode.optional(),
        token: externalToken.optional(),
        password: exactPassword.optional(),
    }).strict().refine(hasPotentialProviderProof, {
        message: "Genau ein zulässiger 2FA-Nachweis ist erforderlich",
    }),
});
const sensitiveProofBody = z.object({
    code: totpCode.optional(),
    recoveryCode: recoveryCode.optional(),
    token: externalToken.optional(),
    password: exactPassword.optional(),
}).strict().refine(hasPotentialProviderProof, {
    message: "Genau ein zulässiger 2FA-Nachweis ist erforderlich",
});
export const disableTwoFactorSchema = z.object({ body: sensitiveProofBody });
export const regenerateRecoveryCodesSchema = z.object({ body: sensitiveProofBody });
export const verifyLoginTwoFactorSchema = z.object({
    body: z.object({
        challengeId: z.string().trim().min(1).max(160),
        code: totpCode.optional(),
        recoveryCode: recoveryCode.optional(),
        token: externalToken.optional(),
        password: exactPassword.optional(),
        terminalId: z.string().trim().min(1).max(160).optional(),
    }).strict().refine(hasPotentialProviderProof, {
        message: "Genau ein zulässiger 2FA-Nachweis ist erforderlich",
    }),
});
