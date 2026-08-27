import { apiRequest } from "./apiClient.js";

const BASE_PATH = "/api/system/update-center";
const DEPLOYMENT_LIFECYCLE_PATH = `${BASE_PATH}/deployment-lifecycle`;

export function fetchCoreUpdateStatus(token) {
  return apiRequest(BASE_PATH, { token });
}

export function checkCoreUpdate(token) {
  return apiRequest(`${BASE_PATH}/check`, { token, method: "POST" });
}

export function checkLocalSourceUpdate(token) {
  return apiRequest(`${BASE_PATH}/local-source/check`, { token, method: "POST" });
}

export function prepareCoreUpdate(token) {
  return apiRequest(`${BASE_PATH}/prepare`, { token, method: "POST" });
}

export function installCoreUpdate(token, targetVersion) {
  return apiRequest(`${BASE_PATH}/install`, {
    token,
    method: "POST",
    body: { targetVersion },
  });
}

export function installLocalSourceUpdate(token, { updateId, manifestSha256 }) {
  return apiRequest(`${BASE_PATH}/local-source/install`, {
    token,
    method: "POST",
    body: { updateId, manifestSha256 },
  });
}

// Der Lifecycle-Endpunkt und sein generationsgebundener Beleg sind bewusst in
// diesem Adapter gekapselt. Die Oberfläche sendet niemals eine frei gewählte
// Slot- oder Versionsumschaltung.
export function finalizeCoreDeploymentLifecycle(token, { holdId, generation }) {
  const normalizedHoldId = String(holdId || "").trim();
  const normalizedGeneration = Number(generation);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(normalizedHoldId)
    || !Number.isSafeInteger(normalizedGeneration)
    || normalizedGeneration <= 0
  ) {
    return Promise.reject(new Error("DEPLOYMENT_LIFECYCLE_FINALIZE_PROOF_INVALID"));
  }
  return apiRequest(`${DEPLOYMENT_LIFECYCLE_PATH}/finalize`, {
    token,
    method: "POST",
    body: {
      holdId: normalizedHoldId,
      generation: normalizedGeneration,
    },
  });
}

export function rollbackCoreDeploymentLifecycle(token, { holdId, generation }) {
  const normalizedHoldId = String(holdId || "").trim();
  const normalizedGeneration = Number(generation);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(normalizedHoldId)
    || !Number.isSafeInteger(normalizedGeneration)
    || normalizedGeneration <= 0
  ) {
    return Promise.reject(new Error("DEPLOYMENT_LIFECYCLE_ROLLBACK_PROOF_INVALID"));
  }
  return apiRequest(`${DEPLOYMENT_LIFECYCLE_PATH}/rollback`, {
    token,
    method: "POST",
    body: {
      holdId: normalizedHoldId,
      generation: normalizedGeneration,
    },
  });
}

export function saveCoreUpdateSettings(token, settings) {
  return apiRequest(`${BASE_PATH}/settings`, { token, method: "PUT", body: settings });
}
