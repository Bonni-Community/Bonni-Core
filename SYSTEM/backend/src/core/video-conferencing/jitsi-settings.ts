import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";

import { prisma } from "../database/prisma.js";
import { requireRuntimeSecret } from "../../platform/security/crypto/runtime-secret.js";
import {
  decryptAes256GcmToUtf8,
  encryptAes256Gcm,
} from "../../platform/security/crypto/symmetric.js";

const KEYS = {
  enabled: "integration.jitsi.enabled",
  serverUrl: "integration.jitsi.serverUrl",
  appId: "integration.jitsi.appId",
  secret: "integration.jitsi.secretEncrypted",
  version: "integration.jitsi.version",
  updatedAt: "integration.jitsi.updatedAt",
} as const;
const ALL_KEYS = Object.values(KEYS);
const SECRET_PREFIX = "jitsi1";
const SECRET_AAD = "bonni-core:jitsi-server-secret:v1";
const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/;

export type JitsiPublicSettings = {
  enabled: boolean;
  serverUrl: string;
  appId: string;
  secretConfigured: boolean;
  version: number;
  updatedAt: string | null;
};

export type JitsiSettingsUpdate = {
  enabled?: boolean;
  serverUrl?: string;
  appId?: string;
  secret?: string;
};

function settingKey() {
  const secret = requireRuntimeSecret({
    names: ["MODULE_PRIVATE_DATA_SECRET"],
    errorCode: "JITSI_SETTINGS_ENCRYPTION_SECRET_NOT_CONFIGURED",
    minLength: 43,
  });
  return createHmac("sha256", secret)
    .update("bonni-core:jitsi-settings:v1")
    .digest();
}

function encryptSecret(value: string) {
  return `${SECRET_PREFIX}.${encryptAes256Gcm(value, settingKey(), SECRET_AAD)}`;
}

function decryptSecret(value: unknown) {
  const encoded = String(value || "");
  if (!encoded.startsWith(`${SECRET_PREFIX}.`)) {
    throw Object.assign(new Error("JITSI_SECRET_CIPHERTEXT_INVALID"), { statusCode: 500 });
  }
  return decryptAes256GcmToUtf8(encoded.slice(SECRET_PREFIX.length + 1), settingKey(), SECRET_AAD);
}

function normalizeServerUrl(value: unknown) {
  const source = String(value || "").trim().replace(/\/+$/, "");
  if (!source) return "";
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw Object.assign(new Error("JITSI_SERVER_URL_INVALID"), { statusCode: 400 });
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw Object.assign(new Error("JITSI_SERVER_HTTPS_REQUIRED"), { statusCode: 400 });
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw Object.assign(new Error("JITSI_SERVER_ORIGIN_REQUIRED"), { statusCode: 400 });
  }
  return parsed.origin;
}

function normalizeAppId(value: unknown) {
  const appId = String(value || "").trim();
  if (appId && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/.test(appId)) {
    throw Object.assign(new Error("JITSI_APP_ID_INVALID"), { statusCode: 400 });
  }
  return appId;
}

function bool(value: unknown) {
  return value === true || ["true", "1", "yes", "on"].includes(String(value || "").toLowerCase());
}

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function rows() {
  return prisma.systemSetting.findMany({ where: { key: { in: ALL_KEYS } } });
}

function mapped(input: Array<{ key: string; value: unknown }>) {
  return new Map(input.map((entry) => [entry.key, entry.value]));
}

export async function getJitsiPublicSettings(): Promise<JitsiPublicSettings> {
  const values = mapped(await rows());
  return publicSettingsFrom(values);
}

function publicSettingsFrom(values: Map<string, unknown>): JitsiPublicSettings {
  return {
    enabled: bool(values.get(KEYS.enabled)),
    serverUrl: String(values.get(KEYS.serverUrl) || ""),
    appId: String(values.get(KEYS.appId) || ""),
    secretConfigured: Boolean(values.get(KEYS.secret)),
    version: number(values.get(KEYS.version)),
    updatedAt: values.get(KEYS.updatedAt) ? String(values.get(KEYS.updatedAt)) : null,
  };
}

async function fullSettings() {
  const values = mapped(await rows());
  const publicSettings = publicSettingsFrom(values);
  return {
    ...publicSettings,
    secret: values.get(KEYS.secret) ? decryptSecret(values.get(KEYS.secret)) : "",
  };
}

export async function updateJitsiSettings(input: JitsiSettingsUpdate, accountId: string) {
  const current = await fullSettings();
  const serverUrl = normalizeServerUrl(input.serverUrl ?? current.serverUrl);
  const appId = normalizeAppId(input.appId ?? current.appId);
  const requestedSecret = input.secret === undefined ? current.secret : String(input.secret || "").trim();
  const enabled = input.enabled === undefined ? current.enabled : Boolean(input.enabled);
  if (enabled && (!serverUrl || !appId || requestedSecret.length < 32)) {
    throw Object.assign(new Error("JITSI_CONFIGURATION_INCOMPLETE"), { statusCode: 400 });
  }
  if (requestedSecret && requestedSecret.length < 32) {
    throw Object.assign(new Error("JITSI_SECRET_TOO_SHORT"), { statusCode: 400 });
  }
  const version = current.version + 1;
  const updatedAt = new Date().toISOString();
  const values: Record<string, Prisma.InputJsonValue> = {
    [KEYS.enabled]: enabled,
    [KEYS.serverUrl]: serverUrl,
    [KEYS.appId]: appId,
    [KEYS.version]: version,
    [KEYS.updatedAt]: updatedAt,
  };
  if (requestedSecret) values[KEYS.secret] = encryptSecret(requestedSecret);

  await prisma.$transaction([
    ...Object.entries(values).map(([key, value]) => prisma.systemSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    })),
    prisma.auditLog.create({
      data: {
        category: "SECURITY",
        event: "JITSI_SERVER_CONFIGURATION_CHANGED",
        result: "SUCCESS",
        accountId,
        targetType: "JitsiServerConfiguration",
        targetId: serverUrl || "disabled",
        severity: "WARN",
        metadataJson: {
          enabled,
          serverHost: serverUrl ? new URL(serverUrl).host : null,
          appId,
          secretRotated: input.secret !== undefined,
          version,
        },
      },
    }),
  ]);
  return getJitsiPublicSettings();
}

export async function testJitsiConnection(serverUrlValue?: unknown) {
  const current = await getJitsiPublicSettings();
  const serverUrl = normalizeServerUrl(serverUrlValue ?? current.serverUrl);
  if (!serverUrl) throw Object.assign(new Error("JITSI_SERVER_URL_REQUIRED"), { statusCode: 400 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${serverUrl}/external_api.js`, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "application/javascript,text/javascript;q=0.9,*/*;q=0.1" },
    });
    const contentType = response.headers.get("content-type") || "";
    const ok = response.ok && !response.headers.get("location") && /javascript|text\/plain/i.test(contentType);
    return { ok, status: response.status, serverUrl, contentType };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      serverUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function createModuleVideoConferenceRuntime(moduleKey: string) {
  const normalizedModuleKey = String(moduleKey || "").trim().toLowerCase();
  if (!/^(app|addon|plugin|bridge)\.[a-z0-9][a-z0-9.-]{0,158}[a-z0-9]$/.test(normalizedModuleKey)) {
    throw Object.assign(new Error("VIDEO_CONFERENCE_MODULE_KEY_INVALID"), { statusCode: 500 });
  }
  return Object.freeze({
    contractVersion: "bonni.video-conferencing/v1",
    async status() {
      return getJitsiPublicSettings();
    },
    async issueJoin(input: {
      roomId: string;
      userId: string;
      displayName: string;
      moderator?: boolean;
      email?: string | null;
      expiresInSeconds?: number;
    }) {
      const settings = await fullSettings();
      if (!settings.enabled || !settings.serverUrl || !settings.appId || !settings.secret) {
        throw Object.assign(new Error("JITSI_SERVER_NOT_CONFIGURED"), { statusCode: 503 });
      }
      const roomId = String(input.roomId || "").trim();
      if (!ROOM_ID.test(roomId)) {
        throw Object.assign(new Error("VIDEO_CONFERENCE_ROOM_ID_INVALID"), { statusCode: 400 });
      }
      const displayName = String(input.displayName || "").trim().slice(0, 120);
      const userId = String(input.userId || "").trim().slice(0, 160);
      if (!displayName || !userId) {
        throw Object.assign(new Error("VIDEO_CONFERENCE_IDENTITY_REQUIRED"), { statusCode: 400 });
      }
      const host = new URL(settings.serverUrl).hostname;
      const roomName = `${normalizedModuleKey.replaceAll(".", "-")}-${roomId}`;
      const seconds = Math.max(60, Math.min(14_400, Number(input.expiresInSeconds) || 900));
      const expiresAt = Math.floor(Date.now() / 1000) + seconds;
      const token = jwt.sign({
        aud: settings.appId,
        iss: settings.appId,
        sub: host,
        room: roomName,
        exp: expiresAt,
        nbf: Math.floor(Date.now() / 1000) - 5,
        context: {
          user: {
            id: userId,
            name: displayName,
            email: input.email ? String(input.email).slice(0, 254) : undefined,
            moderator: Boolean(input.moderator),
          },
          features: { recording: false, livestreaming: false },
        },
      }, settings.secret, { algorithm: "HS256" });
      return {
        provider: "jitsi",
        serverUrl: settings.serverUrl,
        roomName,
        token,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        configurationVersion: settings.version,
      };
    },
  });
}
