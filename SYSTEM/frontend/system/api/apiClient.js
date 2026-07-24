import { buildApiUrls } from "./apiConfig.js";
import {
  markRuntimeEndpointFailure,
  markRuntimeEndpointFailover,
  markRuntimeEndpointSuccess,
  orderRuntimeApiUrls,
} from "./runtimeEndpointRouter.js";

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.data = options.data;
    this.code = options.data?.code || options.code;
    this.statusText = options.statusText;
    this.response = options.response;
    this.request = options.request;
  }
}

const AUTH_STORAGE_KEYS = [
  "token",
  "user",
  "shell",
  "activeArea",
  "lastActivityAt",
];

const INVALID_SESSION_CODES = new Set([
  "INVALID_TOKEN",
  "SESSION_EXPIRED",
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
  "MISSING_TOKEN",
  "ACCOUNT_INACTIVE_OR_MISSING",
  "ACCOUNT_DISABLED",
]);

let sessionResetScheduled = false;

function responseErrorCode(data) {
  const value =
    data?.code ||
    data?.error?.code ||
    (typeof data?.error === "string" ? data.error : "");

  return String(value || "").trim().toUpperCase();
}

function clearStoredSession() {
  if (typeof window === "undefined") return;

  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      for (const key of AUTH_STORAGE_KEYS) {
        storage.removeItem(key);
      }
    } catch {
      // Storage kann beispielsweise im privaten Browsermodus gesperrt sein.
    }
  }
}

function resetInvalidSession() {
  if (typeof window === "undefined" || sessionResetScheduled) return;

  sessionResetScheduled = true;
  clearStoredSession();

  // Der React-Session-State wird beim Neuladen aus dem nun bereinigten
  // Storage aufgebaut und zeigt dadurch wieder zuverlässig den Login.
  window.setTimeout(() => {
    if (typeof window.location?.reload === "function") {
      window.location.reload();
    }
  }, 0);
}

function isFormBody(body) {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

function buildHeaders({ token, body, headers, auth }) {
  const nextHeaders = {
    ...headers,
  };

  // GET/HEAD requests without body must stay "simple" whenever possible.
  // Otherwise the browser sends an OPTIONS preflight for every read request.
  if (body != null && !isFormBody(body) && !nextHeaders["Content-Type"]) {
    nextHeaders["Content-Type"] = "application/json";
  }

  if (auth !== false && token && !nextHeaders.Authorization) {
    nextHeaders.Authorization = `Bearer ${token}`;
  }

  return nextHeaders;
}

async function parseResponse(response) {
  const rawText = await response.text().catch(() => "");

  if (!rawText) {
    return { rawText, data: null };
  }

  try {
    return { rawText, data: JSON.parse(rawText) };
  } catch {
    return { rawText, data: rawText };
  }
}

function errorMessageFromResponse(data, rawText, status, { invalidSession = false } = {}) {
  if (invalidSession) {
    return "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.";
  }

  if (typeof data === "string" && data.trim()) return data;
  return (
    data?.message ||
    data?.error?.message ||
    (typeof data?.error === "string" ? data.error : null) ||
    data?.code ||
    rawText ||
    `HTTP ${status}`
  );
}

function createBackendUnavailableError({ path, urls, errors }) {
  return new ApiError("Backend nicht erreichbar", {
    status: 0,
    code: "BACKEND_UNAVAILABLE",
    data: {
      code: "BACKEND_UNAVAILABLE",
      message: "Backend nicht erreichbar",
      attemptedUrls: urls,
    },
    request: { path, urls },
    response: errors,
  });
}

function isFailoverStatus(status) {
  return [0, 502, 503, 504].includes(Number(status));
}

function isRuntimeFailureCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return false;

  return (
    normalized.includes("BACKEND_UNAVAILABLE") ||
    normalized.includes("DATABASE_UNAVAILABLE") ||
    normalized.includes("DATABASE_NOT_READY") ||
    normalized.includes("RUNTIME_UNAVAILABLE") ||
    normalized.includes("RUNTIME_NOT_READY") ||
    normalized.includes("PRISMA")
  );
}

function shouldTryNextBackend({ response, data, nextUrl }) {
  if (!nextUrl) return false;

  if (isFailoverStatus(response.status)) {
    return true;
  }

  return isRuntimeFailureCode(data?.code || data?.error?.code || data?.reason);
}

export async function apiRequest(path, {
  token,
  method = "GET",
  body,
  headers = {},
  auth = true,
} = {}) {
  const urls = orderRuntimeApiUrls(buildApiUrls(path));
  const networkErrors = [];

  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    const nextUrl = urls[index + 1];
    const request = { path, url, method, body };
    let response;

    try {
      response = await fetch(url, {
        method,
        headers: buildHeaders({ token, body, headers, auth }),
        body: body == null ? undefined : isFormBody(body) ? body : JSON.stringify(body),
      });
    } catch (error) {
      networkErrors.push({ url, error });
      markRuntimeEndpointFailure(url, error, { reason: "NETWORK_ERROR" });

      if (nextUrl) {
        markRuntimeEndpointFailover({
          fromUrl: url,
          toUrl: nextUrl,
          reason: "NETWORK_ERROR_FAILOVER",
          error,
        });
      }

      continue;
    }

    if (response.status === 204) {
      markRuntimeEndpointSuccess(url, null, response);
      return null;
    }

    const { rawText, data } = await parseResponse(response);

    if (!response.ok) {
      const errorCode = responseErrorCode(data);
      const invalidSession = Boolean(
        response.status === 401 &&
        auth !== false &&
        token &&
        INVALID_SESSION_CODES.has(errorCode)
      );

      if (invalidSession) {
        resetInvalidSession();
      }

      const error = new ApiError(errorMessageFromResponse(data, rawText, response.status, {
        invalidSession,
      }), {
        status: response.status,
        statusText: response.statusText,
        data,
        code: errorCode,
        response: data ?? rawText,
        request,
      });

      if (shouldTryNextBackend({ response, data, nextUrl })) {
        markRuntimeEndpointFailure(url, error, { reason: "UNHEALTHY_BACKEND" });
        markRuntimeEndpointFailover({
          fromUrl: url,
          toUrl: nextUrl,
          reason: data?.code || data?.reason || `HTTP_${response.status}`,
          error,
        });
        continue;
      }

      throw error;
    }

    markRuntimeEndpointSuccess(url, data, response);
    return data;
  }

  throw createBackendUnavailableError({ path, urls, errors: networkErrors });
}

export const apiFetch = apiRequest;
