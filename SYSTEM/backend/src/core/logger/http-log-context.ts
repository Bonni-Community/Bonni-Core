import { randomUUID } from "node:crypto";

export function safeRequestId(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) ? value : randomUUID();
}

export function safeLogPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  // Query values can contain recovery capabilities, tokens and personal data.
  return value.split(/[?#]/, 1)[0].replace(/[\x00-\x1f\x7f]/g, "").slice(0, 512) || "/";
}

export function safeLogHeader(value: unknown): string | null {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 256) : null;
}
