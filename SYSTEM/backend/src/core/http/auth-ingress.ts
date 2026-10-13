import { createHash } from "node:crypto";
import express, { type Request, type RequestHandler } from "express";

const WINDOW_MS = 5 * 60_000;
const AUTH_PATH = /^\/api\/(?:identity\/)?auth(?:\/|$)|^\/api\/security\/2fa(?:\/|$)/i;
const ATTEMPT_PATH = /^\/api\/(?:identity\/)?auth\/(login(?:\/2fa)?|refresh)\/?$/i;

export class AuthAttemptBuckets {
  private readonly buckets = new Map<string, { attempts: number; until: number }>();
  private lastPrune = -Infinity;
  private overflowUntil = 0;
  constructor(private readonly now = () => performance.now(), private readonly maximum = 10_000) {}

  consume(key: string, limit: number): number {
    const now = this.now();
    if (now - this.lastPrune >= 30_000 || (now >= this.overflowUntil && this.buckets.size >= this.maximum)) {
      for (const [id, bucket] of this.buckets) if (bucket.until <= now) this.buckets.delete(id);
      this.lastPrune = now;
    }
    const previous = this.buckets.get(key);
    if (previous && previous.until > now) {
      if (previous.attempts >= limit) return Math.max(1, Math.ceil((previous.until - now) / 1000));
      previous.attempts++;
      return 0;
    }
    if (previous) this.buckets.delete(key);
    // Do not evict live counters: flooding new keys cannot reset existing limits.
    if (this.buckets.size >= this.maximum) {
      if (this.overflowUntil <= now) this.overflowUntil = Math.min(...Array.from(this.buckets.values(), bucket => bucket.until));
      return Math.max(1, Math.ceil((this.overflowUntil - now) / 1000));
    }
    this.buckets.set(key, { attempts: 1, until: now + WINDOW_MS });
    return 0;
  }
}

const sharedBuckets = new AuthAttemptBuckets();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function attemptKind(req: Request) { return req.method === "POST" ? ATTEMPT_PATH.exec(req.path)?.[1].toLowerCase() : undefined; }
function rejectAttempt(res: express.Response, retryAfter: number) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", String(retryAfter));
  res.status(429).json({ code: "AUTH_RATE_LIMITED", message: `Zu viele Anmeldeversuche. Bitte in ${retryAfter} Sekunden erneut versuchen.`, retryAfter });
}

export function createAuthIpGuard(buckets = sharedBuckets): RequestHandler {
  return (req, res, next) => {
    const kind = attemptKind(req);
    if (kind) {
      const retry = buckets.consume(digest(`ip:${kind === "refresh" ? "refresh" : "login"}:${req.ip || req.socket.remoteAddress || "unknown"}`), 120);
      if (retry) { rejectAttempt(res, retry); return; }
    }
    next();
  };
}

export function createAuthSubjectGuard(buckets = sharedBuckets): RequestHandler {
  return (req, res, next) => {
    const kind = attemptKind(req);
    const value = kind === "login" ? req.body?.login || req.body?.loginName || req.body?.username || req.body?.email
      : kind === "login/2fa" ? req.body?.challengeId : undefined;
    if (typeof value === "string" && value.trim()) {
      const retry = buckets.consume(digest(`subject:${kind}:${req.ip || req.socket.remoteAddress || "unknown"}:${value.trim().toLowerCase()}`), 10);
      if (retry) { rejectAttempt(res, retry); return; }
    }
    next();
  };
}

const authJson = express.json({ limit: "32kb", inflate: false });
export const boundedAuthJson: RequestHandler = (req, res, next) => {
  if (AUTH_PATH.test(req.path)) authJson(req, res, next);
  else next();
};
