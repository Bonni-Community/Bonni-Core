import { apiRequest } from "../../../../../system/api/apiClient.js";
import {
  normalizeAdminEnrollmentOneShot,
  normalizeAdminEnrollmentStatus,
  normalizeDisableResult,
  normalizeRecoveryCodeResult,
  normalizeTotpConfirmation,
  normalizeTotpSetup,
  normalizeTwoFactorStatus,
} from "./twoFactorDto.js";
import {
  buildAdminCreatePayload,
  buildAdminRotatePayload,
  buildExistingProof,
  buildTotpConfirmPayload,
  buildTotpSetupPayload,
} from "../model/twoFactorPayload.js";

const NO_STORE_HEADERS = Object.freeze({
  Accept: "application/json",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
});

function secureRequest(path, options = {}) {
  return apiRequest(path, {
    ...options,
    headers: { ...NO_STORE_HEADERS, ...(options.headers || {}) },
    allowFailover: false,
    cache: "no-store",
    sensitive: true,
  });
}

export async function fetchCurrentTwoFactorStatus(token, { signal } = {}) {
  return normalizeTwoFactorStatus(await secureRequest("/api/security/2fa/status", { token, signal }));
}

export async function startCurrentTotpEnrollment(token, payload, { signal } = {}) {
  return normalizeTotpSetup(await secureRequest("/api/security/2fa/totp/setup", {
    token,
    signal,
    method: "POST",
    body: buildTotpSetupPayload(payload),
  }));
}

export async function confirmCurrentTotpEnrollment(token, payload, { signal } = {}) {
  return normalizeTotpConfirmation(await secureRequest("/api/security/2fa/totp/confirm", {
    token,
    signal,
    method: "POST",
    body: buildTotpConfirmPayload(payload),
  }));
}

export async function regenerateCurrentRecoveryCodes(token, proof, { signal } = {}) {
  return normalizeRecoveryCodeResult(await secureRequest("/api/security/2fa/recovery-codes/regenerate", {
    token,
    signal,
    method: "POST",
    body: buildExistingProof(proof),
  }));
}

export async function disableCurrentTwoFactor(token, proof, { signal } = {}) {
  return normalizeDisableResult(await secureRequest("/api/security/2fa/disable", {
    token,
    signal,
    method: "POST",
    body: buildExistingProof(proof),
  }));
}

export async function fetchAdminEnrollmentStatus(token, accountId, { signal } = {}) {
  return normalizeAdminEnrollmentStatus(await secureRequest(
    `/api/security/2fa/admin/enrollment-requests/${encodeURIComponent(accountId)}`,
    { token, signal },
  ));
}

export async function createAdminEnrollmentRequest(token, payload, { signal } = {}) {
  return normalizeAdminEnrollmentOneShot(await secureRequest("/api/security/2fa/admin/enrollment-requests", {
    token,
    signal,
    method: "POST",
    body: buildAdminCreatePayload(payload),
  }));
}

export async function rotateAdminEnrollmentRequest(token, requestId, payload, { signal } = {}) {
  return normalizeAdminEnrollmentOneShot(await secureRequest(
    `/api/security/2fa/admin/enrollment-requests/${encodeURIComponent(requestId)}/rotate`,
    {
      token,
      signal,
      method: "POST",
      body: buildAdminRotatePayload(payload),
    },
  ));
}
