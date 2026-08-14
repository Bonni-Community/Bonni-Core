import { z } from "zod";

export const loginSchema = z.object({
  body: z.object({
    login: z.string().min(1),
    password: z.string().min(1),
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
    code: z.string().trim().min(4).max(128).regex(/^[^\r\n]+$/).optional(),
    recoveryCode: z.string().trim().min(8).max(80).optional(),
    terminalId: z.string().optional()
  }).refine((value) => Boolean(value.code || value.recoveryCode), {
    message: "code oder recoveryCode ist erforderlich"
  })
});

export type LoginInput = z.infer<typeof loginSchema>["body"];
export type RefreshInput = z.infer<typeof refreshSchema>["body"];
export type LogoutInput = z.infer<typeof logoutSchema>["body"];
export type LoginTwoFactorInput = z.infer<typeof loginTwoFactorSchema>["body"];
