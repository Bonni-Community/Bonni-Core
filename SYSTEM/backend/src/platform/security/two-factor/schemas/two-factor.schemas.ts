import { z } from "zod";

export const twoFactorPurposeSchema = z.enum([
  "LOGIN",
  "SECURITY_SETTINGS",
  "ADMIN_ELEVATION",
  "DSGVO_SUBJECT_DATA_VIEW",
  "DSGVO_SUBJECT_DATA_EXPORT",
  "DSGVO_SUBJECT_DATA_DELETE",
  "DSGVO_DELETION_RULE_UPDATE",
  "MODULE_PRIVATE_DATA_ACCESS",
]);

export const setupTotpSchema = z.object({
  body: z.object({
    label: z.string().trim().min(1).max(80).optional(),
    issuer: z.string().trim().min(1).max(80).optional(),
    includeManualSecret: z.boolean().optional(),
  }),
});

export const confirmTotpSchema = z.object({
  body: z.object({
    credentialId: z.string().trim().min(1),
    code: z.string().trim().regex(/^\d{6}(?:\d{2})?$/),
  }),
});

export const createChallengeSchema = z.object({
  body: z.object({
    purpose: twoFactorPurposeSchema.exclude(["LOGIN"]),
    method: z.enum(["TOTP", "RECOVERY_CODE"]).optional(),
    metadataJson: z.unknown().optional(),
  }),
});

export const verifyChallengeSchema = z.object({
  params: z.object({
    id: z.string().trim().min(1),
  }),
  body: z.object({
    code: z.string().trim().min(4).max(128).regex(/^[^\r\n]+$/).optional(),
    recoveryCode: z.string().trim().min(8).max(80).optional(),
    token: z.string().trim().min(1).max(128).regex(/^[^\r\n]+$/).optional(),
    password: z.string().min(1).max(256).regex(/^[^\r\n]+$/).optional(),
  }).refine((value) => Boolean(value.code || value.recoveryCode || value.token), {
    message: "code, recoveryCode oder token ist erforderlich",
  }),
});

export const disableTwoFactorSchema = z.object({
  body: z.object({
    credentialId: z.string().trim().min(1).optional(),
    code: z.string().trim().min(4).max(128).regex(/^[^\r\n]+$/).optional(),
    recoveryCode: z.string().trim().min(8).max(80).optional(),
    token: z.string().trim().min(1).max(128).regex(/^[^\r\n]+$/).optional(),
    password: z.string().min(1).optional(),
  }).refine((value) => Boolean(value.code || value.recoveryCode || value.token || value.password), {
    message: "code, recoveryCode, token oder password ist erforderlich",
  }),
});

export const regenerateRecoveryCodesSchema = z.object({
  body: z.object({
    code: z.string().trim().min(4).max(128).regex(/^[^\r\n]+$/).optional(),
    recoveryCode: z.string().trim().min(8).max(80).optional(),
    token: z.string().trim().min(1).max(128).regex(/^[^\r\n]+$/).optional(),
    password: z.string().min(1).optional(),
  }).refine((value) => Boolean(value.code || value.recoveryCode || value.token || value.password), {
    message: "code, recoveryCode, token oder password ist erforderlich",
  }),
});

export const verifyLoginTwoFactorSchema = z.object({
  body: z.object({
    challengeId: z.string().trim().min(1),
    code: z.string().trim().min(4).max(128).regex(/^[^\r\n]+$/).optional(),
    recoveryCode: z.string().trim().min(8).max(80).optional(),
    token: z.string().trim().min(1).max(128).regex(/^[^\r\n]+$/).optional(),
    password: z.string().min(1).max(256).regex(/^[^\r\n]+$/).optional(),
    terminalId: z.string().trim().min(1).optional(),
  }).refine((value) => Boolean(value.code || value.recoveryCode || value.token), {
    message: "code, recoveryCode oder token ist erforderlich",
  }),
});

export type SetupTotpInput = z.infer<typeof setupTotpSchema>["body"];
export type ConfirmTotpInput = z.infer<typeof confirmTotpSchema>["body"];
export type CreateChallengeInput = z.infer<typeof createChallengeSchema>["body"];
export type VerifyChallengeInput = z.infer<typeof verifyChallengeSchema>["body"];
export type DisableTwoFactorInput = z.infer<typeof disableTwoFactorSchema>["body"];
export type RegenerateRecoveryCodesInput = z.infer<typeof regenerateRecoveryCodesSchema>["body"];
export type VerifyLoginTwoFactorInput = z.infer<typeof verifyLoginTwoFactorSchema>["body"];
