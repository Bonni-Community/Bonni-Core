import { apiRequest } from "./apiClient.js";

export function fetchBranding({ signal } = {}) {
  return apiRequest("/api/branding", {
    auth: false,
    signal,
    cache: "no-cache",
  });
}

export function saveBrandingMetadata(token, payload, { signal } = {}) {
  return apiRequest("/api/system/settings/branding", {
    token,
    method: "PUT",
    body: payload,
    signal,
    allowFailover: false,
  });
}

export function uploadBrandingLogo(token, file, expectedRevision, { signal } = {}) {
  return apiRequest(
    `/api/system/settings/branding/logo?expectedRevision=${encodeURIComponent(expectedRevision)}`,
    {
      token,
      method: "PUT",
      body: file,
      headers: { "Content-Type": "image/png" },
      signal,
      allowFailover: false,
    },
  );
}

export function resetBrandingLogo(token, expectedRevision, { signal } = {}) {
  return apiRequest(
    `/api/system/settings/branding/logo?expectedRevision=${encodeURIComponent(expectedRevision)}`,
    {
      token,
      method: "DELETE",
      signal,
      allowFailover: false,
    },
  );
}
