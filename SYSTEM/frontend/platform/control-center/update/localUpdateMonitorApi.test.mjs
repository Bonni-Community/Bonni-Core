import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchInstallationUpdateStatus,
  INSTALLATION_MONITOR_ACCESS_STORAGE_KEY,
  installationMonitorRequestsCoreSwitch,
  mergeInstallationMonitorStatus,
  normalizeInstallationMonitorAccess,
} from "./localUpdateMonitorApi.js";

const issuedAt = "2026-08-22T10:00:00.000Z";
const access = {
  schemaVersion: "bonni.local-source-update-monitor-access/v1",
  origin: "http://127.0.0.1:4198",
  requestId: "local-source-1234-abcdef",
  updateId: "u-019-0193-0822-10",
  manifestSha256: "a".repeat(64),
  token: "b".repeat(64),
  issuedAt,
};

test("Monitorzugang akzeptiert nur frische, exakt lokale Ziele", () => {
  assert.equal(
    INSTALLATION_MONITOR_ACCESS_STORAGE_KEY,
    "bonni.local-update.monitor-access",
  );
  assert.equal(
    normalizeInstallationMonitorAccess(access, Date.parse(issuedAt) + 1_000)?.origin,
    "http://127.0.0.1:4198",
  );
  assert.equal(normalizeInstallationMonitorAccess({ ...access, origin: "http://192.168.1.10:4198" }), null);
  assert.equal(normalizeInstallationMonitorAccess({ ...access, token: "kurz" }), null);
  assert.equal(
    normalizeInstallationMonitorAccess(access, Date.parse(issuedAt) + 61 * 60_000),
    null,
  );
});

test("Installationsstatus sendet nur das begrenzte Monitortoken und prüft die Auftragsbindung", async () => {
  let observed;
  const payload = await fetchInstallationUpdateStatus(access, {
    now: Date.parse(issuedAt) + 1_000,
    async fetchImpl(url, options) {
      observed = { url, options };
      return new Response(JSON.stringify({
        schemaVersion: "bonni.local-source-update-monitor/v1",
        ok: true,
        role: "installation-server",
        switchTarget: "installation",
        core: { state: "offline-for-update", available: false },
        progress: {
          requestId: access.requestId,
          updateId: access.updateId,
          manifestSha256: access.manifestSha256,
          status: "installing",
          phase: "install",
          message: "Datenzugriff wird aktualisiert",
          steps: [],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(payload.progress.phase, "install");
  const requestedUrl = new URL(observed.url);
  assert.equal(requestedUrl.origin, access.origin);
  assert.equal(requestedUrl.pathname, "/api/local-update/status");
  assert.deepEqual([...requestedUrl.searchParams], [["requestId", access.requestId]]);
  assert.equal(observed.options.headers["X-Bonni-Update-Monitor"], access.token);
  assert.deepEqual(Object.keys(observed.options.headers).sort(), ["Accept", "X-Bonni-Update-Monitor"]);
  assert.equal(observed.options.credentials, "omit");
  assert.equal(observed.options.cache, "no-store");
  assert.equal(observed.options.referrerPolicy, "no-referrer");
  assert.equal("Authorization" in observed.options.headers, false);

  for (const progress of [
    { requestId: "anderer-auftrag", updateId: access.updateId, manifestSha256: access.manifestSha256 },
    { requestId: access.requestId, updateId: "u-falsches-update", manifestSha256: access.manifestSha256 },
    { requestId: access.requestId, updateId: access.updateId, manifestSha256: "c".repeat(64) },
  ]) {
    await assert.rejects(
      fetchInstallationUpdateStatus(access, {
        now: Date.parse(issuedAt) + 1_000,
        async fetchImpl() {
          return new Response(JSON.stringify({
            schemaVersion: "bonni.local-source-update-monitor/v1",
            ok: true,
            role: "installation-server",
            progress,
          }), { status: 200 });
        },
      }),
      /INSTALLATION_MONITOR_STATUS_MISMATCH/u,
    );
  }
});

test("Installationsserver kann wiederholt gepollt werden, ohne das Core-Sitzungstoken zu erhalten", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      schemaVersion: "bonni.local-source-update-monitor/v1",
      ok: true,
      role: "installation-server",
      switchTarget: "installation",
      terminal: false,
      core: { state: "offline-for-update", available: false },
      progress: {
        requestId: access.requestId,
        updateId: access.updateId,
        manifestSha256: access.manifestSha256,
        status: "running",
        phase: "install",
      },
    }), { status: 200 });
  };

  await fetchInstallationUpdateStatus(access, { fetchImpl, now: Date.parse(issuedAt) + 1_000 });
  await fetchInstallationUpdateStatus(access, { fetchImpl, now: Date.parse(issuedAt) + 2_000 });

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.options.headers["X-Bonni-Update-Monitor"], access.token);
    assert.equal("Authorization" in request.options.headers, false);
    assert.equal(request.options.credentials, "omit");
  }
});

test("automatische Rückkehr zu Core erfolgt nur nach erfolgreichem Abschluss", () => {
  assert.equal(installationMonitorRequestsCoreSwitch({
    switchTarget: "core",
    terminal: true,
    core: { available: true },
    progress: { status: "completed" },
  }), true);
  assert.equal(installationMonitorRequestsCoreSwitch({
    switchTarget: "installation",
    terminal: true,
    core: { available: true },
    progress: { status: "failed" },
  }), false);
  assert.equal(installationMonitorRequestsCoreSwitch({
    terminal: true,
    core: { available: true },
    progress: { status: "completed" },
  }), true);
  assert.equal(installationMonitorRequestsCoreSwitch({
    terminal: true,
    core: { available: true },
    progress: { status: "failed" },
  }), false);
});

test("Monitorfortschritt wird in den bestehenden Core-Status eingebettet", () => {
  const current = {
    updateKind: "local-source",
    localSourceUpdate: {
      updateId: access.updateId,
      manifestSha256: access.manifestSha256,
      releaseNotes: { title: "Bleibt erhalten" },
    },
  };
  const merged = mergeInstallationMonitorStatus(current, {
    checkedAt: "2026-08-22T10:02:00.000Z",
    progress: {
      requestId: access.requestId,
      updateId: access.updateId,
      manifestSha256: access.manifestSha256,
      status: "running",
      phase: "health",
      message: "Bonni Core wird geprüft",
    },
  });
  assert.equal(merged.installationStatusSource, "installation");
  assert.equal(merged.localSourceUpdate.state, "in-progress");
  assert.equal(merged.localSourceUpdate.releaseNotes.title, "Bleibt erhalten");
  assert.equal(merged.localSourceUpdate.progress.phase, "health");
});
