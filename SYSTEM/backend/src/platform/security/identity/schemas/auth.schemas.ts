import { z } from "zod";
import { validateExactLocalPassword } from "../../../../core/modules/identity/local-password-policy.js";

const exactPassword = z.custom<string>(
  (value) => validateExactLocalPassword(value).ok,
  { message: "Passwort ist ungültig" },
);
const totpCode = z.string().regex(/^\d{6}(?:\d{2})?$/u);
const recoveryCode = z.string().regex(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/u);
const externalToken = z.custom<string>((value) => (
  typeof value === "string"
  && value.length > 0
  && [...value].length <= 128
  && !/[\r\n\0]/u.test(value)
  && Buffer.from(value, "utf8").toString("utf8") === value
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

export type LoginInput = z.infer<typeof loginSchema>["body"];
export type RefreshInput = z.infer<typeof refreshSchema>["body"];
export type LogoutInput = z.infer<typeof logoutSchema>["body"];
export type LoginTwoFactorInput = z.infer<typeof loginTwoFactorSchema>["body"];
