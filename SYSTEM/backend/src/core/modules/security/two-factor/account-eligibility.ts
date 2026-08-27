type InteractiveTwoFactorAccount = {
  id?: string;
  type?: string;
  isActive?: boolean;
  passwordHash?: string | null;
};

export function assertInteractiveTwoFactorAccount<T extends InteractiveTwoFactorAccount>(
  account: T | null | undefined,
): asserts account is T & {
  type: "MEMBER" | "ADMIN";
  isActive: true;
  passwordHash: string;
} {
  if (!account || account.isActive !== true) {
    throw Object.assign(new Error("TWO_FACTOR_ACCOUNT_NOT_ELIGIBLE"), {
      code: "TWO_FACTOR_ACCOUNT_NOT_ELIGIBLE",
      statusCode: 409,
    });
  }
  if (account.type !== "MEMBER" && account.type !== "ADMIN") {
    throw Object.assign(new Error("TWO_FACTOR_TECHNICAL_ACCOUNT_FORBIDDEN"), {
      code: "TWO_FACTOR_TECHNICAL_ACCOUNT_FORBIDDEN",
      statusCode: 403,
    });
  }
  if (!account.passwordHash) {
    throw Object.assign(new Error("TWO_FACTOR_LOCAL_PASSWORD_REQUIRED"), {
      code: "TWO_FACTOR_LOCAL_PASSWORD_REQUIRED",
      statusCode: 409,
    });
  }
}
