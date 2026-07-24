import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type HmacAlgorithm = "sha1" | "sha256" | "sha512";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Buffer(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

export function deriveSha256Key(value: string | Buffer): Buffer {
  return sha256Buffer(value);
}

export function sha256Json(value: unknown): string {
  return sha256(JSON.stringify(stableJson(value)));
}

export function hmacDigest(
  value: string | Buffer,
  secret: string | Buffer,
  algorithm: HmacAlgorithm = "sha256",
): Buffer {
  return createHmac(algorithm, secret).update(value).digest();
}

export function hmacHex(
  value: string | Buffer,
  secret: string | Buffer,
  algorithm: HmacAlgorithm = "sha256",
): string {
  return hmacDigest(value, secret, algorithm).toString("hex");
}

export function hmacSha256(value: string | Buffer, secret: string | Buffer): string {
  return hmacHex(value, secret, "sha256");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableJson(entry));
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = stableJson((value as Record<string, unknown>)[key]);
        return accumulator;
      }, {});
  }

  return value;
}
