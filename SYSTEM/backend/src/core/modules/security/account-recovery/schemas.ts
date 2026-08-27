import { z } from "zod";

import { validateExactLocalPassword } from "../../identity/local-password-policy.js";

const exactText = (maxCodePoints: number, pattern?: RegExp) => z.custom<string>((value) => (
  typeof value === "string"
  && value.length > 0
  && [...value].length <= maxCodePoints
  && !/[\r\n\0]/u.test(value)
  && Buffer.from(value, "utf8").toString("utf8") === value
  && (!pattern || pattern.test(value))
));

const id = exactText(180, /^[A-Za-z0-9:_-]+$/u);
const loginName = exactText(80, /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u);
const supportCode = z.string().regex(/^[A-Z2-9]{5}(?:-[A-Z2-9]{5}){3}$/u);
const reference = z.string().regex(/^PR-[A-Z2-9]{5}-[A-Z2-9]{5}$/u);
const exactPassword = z.custom<string>((value) => {
  const validation = validateExactLocalPassword(value);
  return validation.ok && validation.characters >= 12;
}, {
  message: "Passwort ist ungültig",
});
const code = z.string().regex(/^\d{6}(?:\d{2})?$/u);
const recoveryCode = z.string().regex(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/u);
const token = exactText(128);

export const recoveryProofSchema = z.object({
  code: code.optional(),
  recoveryCode: recoveryCode.optional(),
  token: token.optional(),
  password: exactPassword.optional(),
}).strict().refine((proof) => {
  const present = [proof.code, proof.recoveryCode, proof.token, proof.password]
    .filter((value) => value !== undefined);
  return present.length > 0 && (!proof.recoveryCode || present.length === 1);
}, { message: "Frischer 2FA-Nachweis ist erforderlich" });

export const publicRecoveryRequestSchema = z.object({
  body: z.object({ loginName }).strict(),
});

export const publicRecoveryResumeSchema = z.object({
  body: z.object({ supportCode }).strict(),
});

export const publicRecoveryCompleteSchema = z.object({
  body: z.object({
    newPassword: exactPassword,
    newPasswordConfirmation: exactPassword,
  }).strict().refine((body) => body.newPassword === body.newPasswordConfirmation, {
    message: "Passwörter müssen exakt übereinstimmen",
    path: ["newPasswordConfirmation"],
  }),
});

export const initiateRecoverySchema = z.object({
  body: z.object({ targetAccountId: id }).strict(),
});

export const recoveryOverviewSchema = z.object({
  query: z.object({ reference: reference.optional() }).strict(),
});

export const recoveryRequestIdSchema = z.object({
  params: z.object({ id }),
});

export const recoveryDecisionChallengeSchema = z.object({
  params: z.object({ id }),
  body: z.object({ decision: z.enum(["APPROVE", "REJECT"]) }).strict(),
});

export const recoveryDecisionSchema = z.object({
  params: z.object({ id }),
  body: z.object({
    decision: z.enum(["APPROVE", "REJECT"]),
    challengeId: id,
    proof: recoveryProofSchema,
  }).strict(),
});

export const supportCodeChallengeSchema = recoveryRequestIdSchema.extend({
  body: z.object({}).strict(),
});

export const issueSupportCodeSchema = recoveryRequestIdSchema.extend({
  body: z.object({ challengeId: id, proof: recoveryProofSchema }).strict(),
});

const policyProposalShape = {
  reviewerAccountIds: z.array(id).min(3).max(6)
    .refine((values) => new Set(values).size === values.length, "Notfallberechtigte müssen eindeutig sein"),
  threshold: z.number().int().min(3).max(6),
} as const;

export const policyChallengeSchema = z.object({
  body: z.object(policyProposalShape).strict().refine(
    (body) => body.threshold <= body.reviewerAccountIds.length,
    { message: "Schwelle darf die Zahl konfigurierter Notfallberechtigter nicht überschreiten", path: ["threshold"] },
  ),
});

export const updateRecoveryPolicySchema = z.object({
  body: z.object({
    ...policyProposalShape,
    challengeId: id,
    proof: recoveryProofSchema,
  }).strict().refine((body) => body.threshold <= body.reviewerAccountIds.length, {
    message: "Schwelle darf die Zahl konfigurierter Notfallberechtigter nicht überschreiten",
    path: ["threshold"],
  }),
});

export type RecoveryProof = z.infer<typeof recoveryProofSchema>;
export type RecoveryDecision = "APPROVE" | "REJECT";
