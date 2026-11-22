import type { createPublicKey, KeyObject } from "node:crypto";
export function parseEd25519SpkiPublicKey(value: Parameters<typeof createPublicKey>[0]): KeyObject;
export function loadTrustedReleaseKeys(env: NodeJS.ProcessEnv, projectRoot: string): Promise<Record<string, string>>;
