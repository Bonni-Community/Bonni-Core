export function parseBuildAuthorization(value: unknown): any;
export function verifyBuildAuthorization(value: unknown, options: {trustedKeys?: any; version: string; product?: string; channel?: string; keyId: string; now?: Date; issuedAt?: string; expiresAt?: string; sourceSha256?: string}): import('node:crypto').KeyObject;
