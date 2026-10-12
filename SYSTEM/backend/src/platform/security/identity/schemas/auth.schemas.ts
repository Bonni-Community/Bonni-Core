import { z } from "zod";
import { validateExactLocalPassword } from "../../../../core/modules/identity/local-password-policy.js";

const exactPassword = z.custom<string>(
  (value) => validateExactLocalPassword(value).ok,
  { message: "Passwort ist ungültig" },
);
const totpCode = z.string().regex(/^\d{6}(?:\d{2})?$/u);
const recoveryCode = z.string().regex(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/u);
function hasSafeUtf8RoundTrip(value: string) {
  return (
    !/[\u0000-\u001F\u007F-\u009F]/u.test(value)
    && Buffer.from(value, "utf8").toString("utf8") === value
  );
}

const externalToken = z.custom<string>((value) => (
  typeof value === "string"
  && value.length > 0
  && [...value].length <= 128
  && hasSafeUtf8RoundTrip(value)
), { message: "Provider-Token ist ungültig" });

function hasPotentialProviderProof(value: Record<string, unknown>) {
  const present = ["code", "recoveryCode", "token", "password"]
    .filter((key) => typeof value[key] === "string" && value[key] !== "");
  return present.length > 0 && (!present.includes("recoveryCode") || present.length === 1);
}

export const loginSchema = z.object({
  body: z.object({
    login: z.string().min(1),
    password: exactPassword,
    terminalId: z.string().optional()
  })
});

export const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1)
  })
});

export const logoutSchema = z.object({
  body: z.object({
    refreshToken: z.string().optional()
  })
});

export const loginTwoFactorSchema = z.object({
  body: z.object({
    challengeId: z.string().trim().min(1),
    code: totpCode.optional(),
    recoveryCode: recoveryCode.optional(),
    token: externalToken.optional(),
    password: exactPassword.optional(),
    terminalId: z.string().optional()
  }).strict().refine(hasPotentialProviderProof, {
    message: "Ein zulässiger 2FA-Nachweis ist erforderlich"
  })
});

function trimmedProfileText(max: number, minimum = 0) {
  return z.string().refine((value) => {
    const normalized = value.trim();
    return (
      hasSafeUtf8RoundTrip(value)
      && [...normalized].length >= minimum
      && [...normalized].length <= max
    );
  }, { message: "Profiltext ist ungültig" }).transform((value) => value.trim());
}

const optionalProfileText = (max: number) => trimmedProfileText(max).optional();

export const updateOwnProfileSchema = z.object({
  body: z.object({
    firstName: optionalProfileText(100),
    secondFirstName: optionalProfileText(100),
    lastName: optionalProfileText(100),
    nickname: optionalProfileText(100),
    displayName: trimmedProfileText(160, 1).optional(),
    birthDate: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)]).optional(),
    email: z.union([
      z.literal(""),
      trimmedProfileText(200, 1).pipe(z.string().email().max(200)),
    ]).optional(),
  }).strict().refine((body) => Object.keys(body).length > 0, {
    message: "Mindestens ein Profilfeld ist erforderlich",
  }),
});

export const changeOwnPasswordSchema = z.object({
  body: z.object({
    currentPassword: exactPassword,
    newPassword: exactPassword,
    newPasswordConfirmation: exactPassword,
  }).strict().refine((body) => body.newPassword === body.newPasswordConfirmation, {
    message: "Die neuen Passwörter stimmen nicht überein",
    path: ["newPasswordConfirmation"],
  }),
});

export const ownChangeHistorySchema = z.object({
  query: z.object({
    scope: z.enum(["security"]).optional(),
  }).strict(),
});

export type LoginInput = z.infer<typeof loginSchema>["body"];
export type RefreshInput = z.infer<typeof refreshSchema>["body"];
export type LogoutInput = z.infer<typeof logoutSchema>["body"];
export type LoginTwoFactorInput = z.infer<typeof loginTwoFactorSchema>["body"];
export type UpdateOwnProfileInput = z.infer<typeof updateOwnProfileSchema>["body"];
export type ChangeOwnPasswordInput = z.infer<typeof changeOwnPasswordSchema>["body"];
export type OwnChangeHistoryQuery = z.infer<typeof ownChangeHistorySchema>["query"];
