export const LOG_MAX_AGE_MS: number;
export function assertPrivateLogPath(file: string): void;
export function cleanPrivateLogFile(file: string, options?: {now?: number; maxAgeMs?: number}): string;
export function cleanKnownDiagnosticTree(productRoot: string): {checkedFiles: number};
