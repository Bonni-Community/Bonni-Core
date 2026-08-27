import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const serviceUrl = new URL("../dist/system/routes/control-api/update-center/local-source-inbox.service.js", import.meta.url);
const service = await import(serviceUrl.href);
const updateCenterServiceUrl = new URL("../dist/system/routes/control-api/update-center/update-center.service.js", import.meta.url);
const updateCenterService = await import(updateCenterServiceUrl.href);

function manifest(updateId = "dev-local-source-test-01") {
  return {
    schemaVersion: "bonni.local-source-update/v1",
    status: "UNPUBLISHED_TEST_UPDATE",
    updateId,
    channel: "development",
    from: { coreVersion: "0.1.19", kontorAppVersion: "0.19.3" },
    to: { coreVersion: "0.1.19", kontorAppVersion: "0.19.3" },
    components: [{ key: "core-backend", path: "SYSTEM/backend", mode: "managed" }],
    files: [{
      path: "SYSTEM/backend/package.json",
      sizeBytes: 2,
      sha256: "a".repeat(64),
      expectedPreviousSha256: "b".repeat(64),
    }],
    delete: [],
  };
}

async function fixture(t, value = manifest()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bonni-local-inbox-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  process.env.BONNI_PROJECT_ROOT = root;
  process.env.NODE_ENV = "test";
  delete process.env.BONNI_LOCAL_SOURCE_UPDATES;
  await fs.mkdir(path.join(root, "SYSTEM", "backend"), { recursive: true });
  await fs.mkdir(path.join(root, "SYSTEM", "app", "kontorapp"), { recursive: true });
  await fs.writeFile(path.join(root, "SYSTEM", "backend", "package.json"), '{"version":"0.1.19"}\n');
  await fs.writeFile(path.join(root, "SYSTEM", "app", "kontorapp", "package.json"), '{"version":"0.19.3"}\n');
  const packageRoot = path.join(root, "UPDATE", "inbox", value.updateId);
  await fs.mkdir(packageRoot, { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(path.join(packageRoot, "bonni-source-update.json"), body);
  return {
    root,
    updateId: value.updateId,
    manifestSha256: crypto.createHash("sha256").update(body).digest("hex"),
  };
}

async function writeSupervisorHeartbeat(root, {
  monitor = true,
  monitorOrigin = "http://127.0.0.1:4318",
  monitorAvailable = true,
  updatedAt = new Date().toISOString(),
} = {}) {
  const controlRoot = path.join(root, "SYSTEM", ".bonni-source-update", "control-center");
  await fs.mkdir(controlRoot, { recursive: true });
  await fs.writeFile(path.join(controlRoot, "heartbeat.json"), `${JSON.stringify({
    schemaVersion: "bonni.local-source-update-heartbeat/v1",
    version: "1.1.1",
    instanceId: "supervisor-instance-1234567890",
    available: true,
    state: "idle",
    updatedAt,
    ...(monitor ? {
      monitor: {
        schemaVersion: "bonni.local-source-update-monitor/v1",
        available: monitorAvailable,
        origin: monitorOrigin,
        bind: "127.0.0.1",
        port: 4318,
      },
    } : {}),
  })}\n`);
  return controlRoot;
}

test("same-version Sourcepaket im zentralen UPDATE/inbox wird erkannt", { concurrency: false }, async (t) => {
  const value = manifest();
  value.components.push({ key: "app.kontorapp", path: "SYSTEM/app/kontorapp", mode: "managed" });
  const current = await fixture(t, value);
  const status = await service.getLocalSourceUpdateStatus();
  assert.equal(status.state, "available");
  assert.equal(status.updateAvailable, true);
  assert.equal(status.updateId, current.updateId);
  assert.equal(status.manifestSha256, current.manifestSha256);
  assert.deepEqual(status.from, { coreVersion: "0.1.19", kontorAppVersion: "0.19.3" });
  assert.deepEqual(status.components, [{ key: "core-backend", path: "SYSTEM/backend" }]);
  assert.equal(status.counts.files, 1);
});

test("Versionshinweise werden geprüft und an die Update-Seite weitergegeben", { concurrency: false }, async (t) => {
  const releaseNotes = {
    title: "Update übersichtlich installieren",
    summary: "Änderungen und Fortschritt bleiben während der gesamten Aktualisierung sichtbar.",
    changes: [
      {
        type: "improvement",
        title: "Eigene Update-Seite",
        detail: "Die Installation zeigt Verlauf, Fortschrittsbalken und einen grünen Abschlussstatus.",
      },
      {
        type: "fix",
        title: "Fehler bleiben sichtbar",
        detail: "Eine Fehlermeldung verschwindet erst nach Schließen oder einem neuen Versuch.",
      },
    ],
  };
  await fixture(t, { ...manifest("dev-release-notes-01"), releaseNotes });

  const status = await service.getLocalSourceUpdateStatus();
  assert.equal(status.state, "available");
  assert.deepEqual(status.releaseNotes, releaseNotes);
});

test("ungültige oder unbegrenzte Versionshinweise sperren das Paket", { concurrency: false }, async (t) => {
  await fixture(t, {
    ...manifest("dev-release-notes-invalid-01"),
    releaseNotes: {
      title: "Update",
      summary: "Beschreibung",
      changes: [{
        type: "fix",
        title: "Fehler behoben",
        detail: "x".repeat(321),
      }],
    },
  });

  const status = await service.getLocalSourceUpdateStatus();
  assert.equal(status.state, "invalid");
  assert.equal(status.updateAvailable, false);
  assert.equal(status.errorCode, "LOCAL_SOURCE_RELEASE_NOTES_INVALID");
});

test("Versionshinweise bleiben nach erfolgreichem Entfernen des Inbox-Pakets sichtbar", { concurrency: false }, async (t) => {
  const releaseNotes = {
    title: "Aktualisierung abgeschlossen",
    summary: "Die Versionsbeschreibung bleibt auf der Erfolgsseite erhalten.",
    changes: [{
      type: "information",
      title: "Dauerhafter Verlauf",
      detail: "Der Abschlussbeleg enthält die geprüften Versionshinweise.",
    }],
  };
  const current = await fixture(t, {
    ...manifest("dev-release-notes-completed-01"),
    releaseNotes,
  });
  const controlRoot = await writeSupervisorHeartbeat(current.root);
  await fs.writeFile(path.join(controlRoot, "status.json"), `${JSON.stringify({
    schemaVersion: "bonni.local-source-update-status/v1",
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
    status: "completed",
    phase: "commit",
    message: "Aktualisierung erfolgreich abgeschlossen.",
    updatedAt: new Date().toISOString(),
    steps: [],
  })}\n`);
  const historyRoot = path.join(current.root, "SYSTEM", ".bonni-source-update", "history");
  await fs.mkdir(historyRoot, { recursive: true });
  await fs.writeFile(path.join(historyRoot, `${current.updateId}.json`), `${JSON.stringify({
    schemaVersion: "bonni.local-source-update/v1",
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
    completedAt: new Date().toISOString(),
    status: "COMPLETED",
    versions: { coreVersion: "0.1.19", kontorAppVersion: "0.19.3" },
    releaseNotes,
    updateMetadata: {
      from: { coreVersion: "0.1.19", kontorAppVersion: "0.19.3" },
      to: { coreVersion: "0.1.19", kontorAppVersion: "0.19.3" },
      components: [{ key: "core-backend", path: "SYSTEM/backend", mode: "managed" }],
      counts: { files: 1, inventory: 1, delete: 0 },
      repair: false,
    },
  })}\n`);
  await fs.rm(path.join(current.root, "UPDATE", "inbox", current.updateId), { recursive: true });

  const status = await service.getLocalSourceUpdateStatus();
  assert.equal(status.state, "completed");
  assert.deepEqual(status.releaseNotes, releaseNotes);
  assert.deepEqual(status.from, { coreVersion: "0.1.19", kontorAppVersion: "0.19.3" });
  assert.deepEqual(status.to, { coreVersion: "0.1.19", kontorAppVersion: "0.19.3" });
  assert.deepEqual(status.components, [{ key: "core-backend", path: "SYSTEM/backend" }]);
  assert.deepEqual(status.counts, { files: 1, inventory: 1, delete: 0 });
});

test("Delta-Inhaltsverzeichnis zählt nur Nutzdateien und bindet den exakten Vorgänger", { concurrency: false }, async (t) => {
  const predecessor = {
    updateId: "dev-required-predecessor-01",
    manifestSha256: "c".repeat(64),
  };
  const value = {
    ...manifest("dev-indexed-delta-01"),
    payloadLayout: "content-addressed-delta-v1",
    requires: predecessor,
    files: [
      {
        path: "SYSTEM/backend/package.json",
        sizeBytes: 2,
        sha256: "a".repeat(64),
        expectedPreviousSha256: "b".repeat(64),
      },
      {
        path: "SYSTEM/backend/unchanged.js",
        sizeBytes: 4,
        sha256: "d".repeat(64),
        expectedPreviousSha256: "d".repeat(64),
      },
    ],
  };
  const current = await fixture(t, value);

  const missing = await service.getLocalSourceUpdateStatus();
  assert.equal(missing.state, "invalid");
  assert.equal(missing.errorCode, "LOCAL_SOURCE_REQUIRED_PREDECESSOR_MISSING");
  assert.match(missing.message, /Update 01 fehlt/u);
  assert.match(missing.message, /Bonni Core 0\.1\.19/u);
  assert.match(missing.message, /dev-required-predecessor-01/u);
  assert.deepEqual(missing.requiredPredecessor, {
    ...predecessor,
    coreVersion: "0.1.19",
    kontorAppVersion: "0.19.3",
  });
  assert.equal(missing.progress, null);

  const stateRoot = path.join(current.root, "SYSTEM", ".bonni-source-update");
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(path.join(stateRoot, "active-manifest.json"), `${JSON.stringify({
    schemaVersion: "bonni.local-source-update/v1",
    ...predecessor,
  })}\n`);

  const compatible = await service.getLocalSourceUpdateStatus();
  assert.equal(compatible.state, "available");
  assert.equal(compatible.counts.files, 1);
  assert.equal(compatible.counts.inventory, 2);
  assert.equal(compatible.requiredPredecessor, null);
});

test("Fortschritt eines früheren Pakets erzeugt weder Erfolg noch Retry beim fehlenden Vorgänger", { concurrency: false }, async (t) => {
  const predecessor = {
    updateId: "u-019-0193-0822-09",
    manifestSha256: "c".repeat(64),
  };
  const value = {
    ...manifest("u-019-0193-0822-10"),
    requires: predecessor,
    to: { coreVersion: "0.1.19+a", kontorAppVersion: "0.19.3" },
  };
  const current = await fixture(t, value);
  const controlRoot = await writeSupervisorHeartbeat(current.root);
  await fs.writeFile(path.join(controlRoot, "status.json"), `${JSON.stringify({
    schemaVersion: "bonni.local-source-update-status/v1",
    updateId: predecessor.updateId,
    manifestSha256: predecessor.manifestSha256,
    status: "completed",
    phase: "complete",
    message: "Frühere Aktualisierung erfolgreich abgeschlossen.",
    updatedAt: new Date().toISOString(),
    steps: [{ key: "health", label: "Bonni Core prüfen", status: "completed" }],
  })}\n`);

  const status = await service.getLocalSourceUpdateStatus();
  assert.equal(status.state, "invalid");
  assert.equal(status.updateAvailable, false);
  assert.equal(status.errorCode, "LOCAL_SOURCE_REQUIRED_PREDECESSOR_MISSING");
  assert.deepEqual(status.requiredPredecessor, {
    ...predecessor,
    coreVersion: "0.1.19",
    kontorAppVersion: "0.19.3",
  });
  assert.match(status.message, /Update 09 fehlt/u);
  assert.equal(status.progress, null);
  assert.equal(status.runner.progress, null);
});

test("Reparaturpaket kennzeichnet den vollständigen flachen Dateisatz", { concurrency: false }, async (t) => {
  const value = {
    ...manifest("dev-indexed-repair-01"),
    payloadLayout: "content-addressed-repair-v1",
    requires: null,
    files: [
      {
        path: "SYSTEM/backend/package.json",
        sizeBytes: 2,
        sha256: "a".repeat(64),
        expectedPreviousSha256: "b".repeat(64),
      },
      {
        path: "SYSTEM/backend/unchanged.js",
        sizeBytes: 4,
        sha256: "d".repeat(64),
        expectedPreviousSha256: "d".repeat(64),
      },
    ],
  };
  await fixture(t, value);
  const status = await service.getLocalSourceUpdateStatus();
  assert.equal(status.state, "available");
  assert.equal(status.repair, true);
  assert.equal(status.counts.files, 2);
  assert.equal(status.counts.inventory, 2);
});

test("abgeschlossene identische ID wird nicht erneut angeboten", { concurrency: false }, async (t) => {
  const current = await fixture(t);
  const historyRoot = path.join(current.root, "SYSTEM", ".bonni-source-update", "history");
  await fs.mkdir(historyRoot, { recursive: true });
  await fs.writeFile(path.join(historyRoot, `${current.updateId}.json`), `${JSON.stringify({
    schemaVersion: "bonni.local-source-update/v1",
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
    status: "COMPLETED",
  })}\n`);
  const status = await service.getLocalSourceUpdateStatus();
  assert.equal(status.state, "already-installed");
  assert.equal(status.updateAvailable, false);
});

test("gleiche ID mit anderem Receipt-Hash wird als Kollision gesperrt", { concurrency: false }, async (t) => {
  const current = await fixture(t);
  const historyRoot = path.join(current.root, "SYSTEM", ".bonni-source-update", "history");
  await fs.mkdir(historyRoot, { recursive: true });
  await fs.writeFile(path.join(historyRoot, `${current.updateId}.json`), `${JSON.stringify({
    status: "COMPLETED",
    manifestSha256: "f".repeat(64),
  })}\n`);
  const status = await service.getLocalSourceUpdateStatus();
  assert.equal(status.state, "id-collision");
  assert.equal(status.errorCode, "LOCAL_SOURCE_UPDATE_ID_COLLISION");
});

test("Installationsauftrag v2 bindet Monitorzugang an ID, Manifesthash und frische Supervisor-Instanz", { concurrency: false }, async (t) => {
  const current = await fixture(t);
  const controlRoot = await writeSupervisorHeartbeat(current.root);
  assert.equal(service.LOCAL_SOURCE_UPDATE_REQUEST_SCHEMA, "bonni.local-source-update-request/v2");

  const queued = await service.queueLocalSourceUpdate({
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
  });
  assert.equal(queued.ok, true);
  assert.equal(queued.accepted, true);
  assert.equal(queued.monitor.schemaVersion, "bonni.local-source-update-monitor-access/v1");
  assert.equal(queued.monitor.origin, "http://127.0.0.1:4318");
  assert.equal(queued.monitor.requestId, queued.requestId);
  assert.equal(queued.monitor.updateId, current.updateId);
  assert.equal(queued.monitor.manifestSha256, current.manifestSha256);
  assert.match(queued.monitor.token, /^[a-f0-9]{64}$/u);
  assert.ok(Number.isFinite(Date.parse(queued.monitor.issuedAt)));

  const requestSource = await fs.readFile(path.join(controlRoot, "request.json"), "utf8");
  const request = JSON.parse(requestSource);
  assert.deepEqual(Object.keys(request).sort(), [
    "action",
    "expiresAt",
    "issuedAt",
    "manifestSha256",
    "monitorTokenSha256",
    "requestId",
    "schemaVersion",
    "supervisorInstanceId",
    "updateId",
  ]);
  assert.equal(request.schemaVersion, "bonni.local-source-update-request/v2");
  assert.equal(request.action, "install");
  assert.equal(request.requestId, queued.requestId);
  assert.equal(request.updateId, current.updateId);
  assert.equal(request.manifestSha256, current.manifestSha256);
  assert.equal(request.supervisorInstanceId, "supervisor-instance-1234567890");
  assert.equal(
    request.monitorTokenSha256,
    crypto.createHash("sha256").update(queued.monitor.token, "utf8").digest("hex"),
  );
  assert.match(request.monitorTokenSha256, /^[a-f0-9]{64}$/u);
  assert.equal(request.issuedAt, queued.monitor.issuedAt);
  assert.equal(Date.parse(request.expiresAt) - Date.parse(request.issuedAt), 5 * 60_000);
  assert.equal("token" in request, false);
  assert.equal("monitorToken" in request, false);
  assert.equal(requestSource.includes(queued.monitor.token), false);
  assert.equal(JSON.stringify(queued).split(queued.monitor.token).length - 1, 1);
  assert.equal("monitorTokenSha256" in queued.monitor, false);
  assert.equal("path" in request, false);
  assert.equal("command" in request, false);

  const monitorAccessSource = await fs.readFile(path.join(controlRoot, "monitor-access.json"), "utf8");
  const monitorAccess = JSON.parse(monitorAccessSource);
  assert.deepEqual(Object.keys(monitorAccess).sort(), [
    "expiresAt",
    "manifestSha256",
    "monitorTokenSha256",
    "requestId",
    "updateId",
  ]);
  assert.equal(monitorAccess.requestId, queued.requestId);
  assert.equal(monitorAccess.updateId, current.updateId);
  assert.equal(monitorAccess.manifestSha256, current.manifestSha256);
  assert.equal(monitorAccess.monitorTokenSha256, request.monitorTokenSha256);
  assert.equal(Date.parse(monitorAccess.expiresAt) - Date.parse(queued.monitor.issuedAt), 60 * 60_000);
  assert.equal("token" in monitorAccess, false);
  assert.equal("monitorToken" in monitorAccess, false);
  assert.equal(monitorAccessSource.includes(queued.monitor.token), false);
});

test("Queue verlangt einen frischen, strikt lokalen Installationsmonitor", { concurrency: false }, async (t) => {
  const current = await fixture(t);
  const controlRoot = await writeSupervisorHeartbeat(current.root, { monitor: false });
  let status = await service.getLocalSourceUpdateStatus();
  assert.equal(status.runner.available, true);
  assert.deepEqual(status.runner.monitor, { available: false, origin: null });

  const missing = await service.queueLocalSourceUpdate({
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "LOCAL_SOURCE_INSTALLATION_MONITOR_NOT_READY");
  await assert.rejects(fs.lstat(path.join(controlRoot, "request.json")), /ENOENT/u);

  await writeSupervisorHeartbeat(current.root, { monitorAvailable: false });
  status = await service.getLocalSourceUpdateStatus();
  assert.deepEqual(status.runner.monitor, { available: false, origin: null });

  for (const invalidOrigin of [
    "http://localhost:4318",
    "http://0.0.0.0:4318",
    "https://127.0.0.1:4318",
    "http://127.0.0.1:4318/status",
    "http://user:secret@127.0.0.1:4318",
  ]) {
    await writeSupervisorHeartbeat(current.root, { monitorOrigin: invalidOrigin });
    status = await service.getLocalSourceUpdateStatus();
    assert.equal(status.runner.monitor.available, false, invalidOrigin);
    assert.equal(status.runner.monitor.origin, null, invalidOrigin);
  }

  await writeSupervisorHeartbeat(current.root, {
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  status = await service.getLocalSourceUpdateStatus();
  assert.equal(status.runner.available, false);
  assert.equal(status.runner.monitor.available, false);
});

test("geändertes Ziel oder fehlender Supervisor wird fail-closed abgelehnt", { concurrency: false }, async (t) => {
  const current = await fixture(t);
  const changed = await service.queueLocalSourceUpdate({
    updateId: current.updateId,
    manifestSha256: "0".repeat(64),
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.error, "LOCAL_SOURCE_UPDATE_TARGET_CHANGED");

  const offline = await service.queueLocalSourceUpdate({
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
  });
  assert.equal(offline.ok, false);
  assert.equal(offline.error, "LOCAL_SOURCE_SUPERVISOR_NOT_READY");
});

test("API prüft den Installationsmonitor vor Sicherung und Queue", { concurrency: false }, async (t) => {
  const current = await fixture(t);
  await writeSupervisorHeartbeat(current.root, { monitor: false });
  const available = await service.getLocalSourceUpdateStatus();
  assert.equal(available.runner.available, true);
  assert.equal(available.runner.monitor.available, false);
  let sideEffectCalls = 0;

  const result = await updateCenterService.startLocalSourceUpdateInstallation({
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
  }, {
    async getStatus() { return available; },
    async createBackup() {
      sideEffectCalls += 1;
      throw new Error("Ohne Installationsmonitor darf keine Sicherung starten");
    },
    async validateBackup() {
      sideEffectCalls += 1;
      throw new Error("Ohne Installationsmonitor darf keine Sicherung geprüft werden");
    },
    async queue() {
      sideEffectCalls += 1;
      throw new Error("Ohne Installationsmonitor darf kein Auftrag entstehen");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "LOCAL_SOURCE_INSTALLATION_MONITOR_NOT_READY");
  assert.equal(sideEffectCalls, 0);
});

test("API reicht den einmaligen Monitorzugang nur in der Annahmeantwort weiter", { concurrency: false }, async (t) => {
  const current = await fixture(t);
  const controlRoot = await writeSupervisorHeartbeat(current.root);
  const available = await service.getLocalSourceUpdateStatus();
  const backupReason = `before-local-source-update:${current.updateId}:${current.manifestSha256}`;
  const backup = {
    schemaVersion: 1,
    id: "backup-monitor-access-01",
    status: "completed",
    reason: backupReason,
    coreVersion: "0.1.19",
    createdAt: new Date().toISOString(),
    components: [],
    files: [],
  };

  const result = await updateCenterService.startLocalSourceUpdateInstallation({
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
  }, {
    async getStatus() { return available; },
    async createBackup(options) {
      assert.equal(options.reason, backupReason);
      return { ok: true, backup };
    },
    async validateBackup(id) {
      return {
        ok: true,
        id,
        backup,
        checkedAt: new Date().toISOString(),
        checkedFiles: 0,
        errors: [],
      };
    },
    queue: service.queueLocalSourceUpdate,
  });

  assert.equal(result.ok, true);
  assert.equal(result.accepted, true);
  assert.equal(result.backupId, backup.id);
  assert.equal(result.monitor.origin, "http://127.0.0.1:4318");
  assert.equal(result.monitor.requestId, result.requestId);
  assert.equal(result.monitor.updateId, current.updateId);
  assert.equal(result.monitor.manifestSha256, current.manifestSha256);
  assert.match(result.monitor.token, /^[a-f0-9]{64}$/u);

  const requestSource = await fs.readFile(path.join(controlRoot, "request.json"), "utf8");
  const request = JSON.parse(requestSource);
  assert.equal(request.monitorTokenSha256, crypto.createHash("sha256")
    .update(result.monitor.token, "utf8")
    .digest("hex"));
  assert.equal(requestSource.includes(result.monitor.token), false);
});

test("falsches oder nicht verfügbares Ziel erzeugt weder Backup noch Queue", { concurrency: false }, async (t) => {
  const current = await fixture(t);
  await writeSupervisorHeartbeat(current.root);
  const available = await service.getLocalSourceUpdateStatus();
  let backupCalls = 0;
  let validationCalls = 0;
  let queueCalls = 0;
  const dependencies = {
    async getStatus() {
      return available;
    },
    async createBackup() {
      backupCalls += 1;
      throw new Error("Backup darf nicht gestartet werden");
    },
    async validateBackup() {
      validationCalls += 1;
      throw new Error("Validierung darf nicht gestartet werden");
    },
    async queue() {
      queueCalls += 1;
      throw new Error("Queue darf nicht geschrieben werden");
    },
  };

  const changed = await updateCenterService.startLocalSourceUpdateInstallation({
    updateId: current.updateId,
    manifestSha256: "0".repeat(64),
  }, dependencies);
  assert.equal(changed.ok, false);
  assert.equal(changed.error, "LOCAL_SOURCE_UPDATE_TARGET_CHANGED");

  dependencies.getStatus = async () => ({
    ...available,
    state: "multiple-packages",
    updateAvailable: false,
    errorCode: "LOCAL_SOURCE_MULTIPLE_PACKAGES",
  });
  const unavailable = await updateCenterService.startLocalSourceUpdateInstallation({
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
  }, dependencies);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, "LOCAL_SOURCE_MULTIPLE_PACKAGES");
  assert.equal(backupCalls, 0);
  assert.equal(validationCalls, 0);
  assert.equal(queueCalls, 0);
});

test("identischer in-progress-Auftrag ist ohne neues Backup idempotent, anderer Hash nicht", { concurrency: false }, async (t) => {
  const current = await fixture(t);
  await writeSupervisorHeartbeat(current.root);
  const available = await service.getLocalSourceUpdateStatus();
  const inProgress = { ...available, state: "in-progress", updateAvailable: false };
  let sideEffectCalls = 0;
  const dependencies = {
    async getStatus() {
      return inProgress;
    },
    async createBackup() {
      sideEffectCalls += 1;
      throw new Error("Backup darf nicht gestartet werden");
    },
    async validateBackup() {
      sideEffectCalls += 1;
      throw new Error("Validierung darf nicht gestartet werden");
    },
    async queue() {
      sideEffectCalls += 1;
      throw new Error("Queue darf nicht geschrieben werden");
    },
  };

  const repeated = await updateCenterService.startLocalSourceUpdateInstallation({
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
  }, dependencies);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.accepted, false);
  assert.equal(repeated.existing, true);

  const changed = await updateCenterService.startLocalSourceUpdateInstallation({
    updateId: current.updateId,
    manifestSha256: "f".repeat(64),
  }, dependencies);
  assert.equal(changed.ok, false);
  assert.equal(changed.error, "LOCAL_SOURCE_UPDATE_NOT_AVAILABLE");
  assert.equal(sideEffectCalls, 0);
});

test("fehlendes pg_dump bleibt als handlungsfähiger Sicherungsfehler bis zur Oberfläche erhalten", { concurrency: false }, async (t) => {
  const current = await fixture(t);
  await writeSupervisorHeartbeat(current.root);
  const available = await service.getLocalSourceUpdateStatus();
  let queueCalls = 0;
  const result = await updateCenterService.startLocalSourceUpdateInstallation({
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
  }, {
    async getStatus() {
      return available;
    },
    async createBackup() {
      return {
        ok: false,
        error: "BACKUP_FAILED",
        causeCode: "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED",
        message: "Das PostgreSQL-Sicherungswerkzeug wurde nicht gefunden. Hinterlege PG_DUMP_PATH.",
        technicalMessage: "spawn pg_dump ENOENT",
      };
    },
    async validateBackup() {
      throw new Error("Fehlgeschlagenes Backup darf nicht geprüft werden");
    },
    async queue() {
      queueCalls += 1;
      return { ok: true };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "LOCAL_SOURCE_BACKUP_FAILED");
  assert.equal(result.causeCode, "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED");
  assert.match(result.message, /PG_DUMP_PATH/);
  assert.equal(result.technicalMessage, "spawn pg_dump ENOENT");
  assert.equal(queueCalls, 0);
});

test("unerwartete Startfehler werden als 409-fähiges Ergebnis statt als HTTP 500 zurückgegeben", { concurrency: false }, async (t) => {
  const current = await fixture(t);
  await writeSupervisorHeartbeat(current.root);
  const available = await service.getLocalSourceUpdateStatus();
  const input = {
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
  };
  const backup = {
    schemaVersion: 1,
    id: "backup-exception-boundary-01",
    status: "completed",
    reason: `before-local-source-update:${current.updateId}:${current.manifestSha256}`,
    coreVersion: "0.1.19",
    createdAt: new Date().toISOString(),
    components: [],
    files: [],
  };

  const backupFailure = await updateCenterService.startLocalSourceUpdateInstallation(input, {
    async getStatus() { return available; },
    async createBackup() { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
    async validateBackup() { throw new Error("must not validate"); },
    async queue() { throw new Error("must not queue"); },
  });
  assert.equal(backupFailure.ok, false);
  assert.equal(backupFailure.error, "LOCAL_SOURCE_BACKUP_FAILED");
  assert.equal(backupFailure.causeCode, "ENOSPC");

  const validationFailure = await updateCenterService.startLocalSourceUpdateInstallation(input, {
    async getStatus() { return available; },
    async createBackup() { return { ok: true, backup }; },
    async validateBackup() { throw new SyntaxError("damaged backup manifest"); },
    async queue() { throw new Error("must not queue"); },
  });
  assert.equal(validationFailure.ok, false);
  assert.equal(validationFailure.error, "LOCAL_SOURCE_BACKUP_INVALID");

  const queueFailure = await updateCenterService.startLocalSourceUpdateInstallation(input, {
    async getStatus() { return available; },
    async createBackup() { return { ok: true, backup }; },
    async validateBackup(id) {
      return { ok: true, id, backup, checkedAt: new Date().toISOString(), checkedFiles: 0, errors: [] };
    },
    async queue() { throw Object.assign(new Error("access denied"), { code: "EACCES" }); },
  });
  assert.equal(queueFailure.ok, false);
  assert.equal(queueFailure.error, "LOCAL_SOURCE_UPDATE_QUEUE_FAILED");
  assert.equal(queueFailure.causeCode, "EACCES");
});

test("nur ein an dieselbe ID und denselben Manifesthash gebundener Backup-Beleg erreicht die Queue", { concurrency: false }, async (t) => {
  const current = await fixture(t);
  await writeSupervisorHeartbeat(current.root);
  const available = await service.getLocalSourceUpdateStatus();
  const backup = {
    schemaVersion: 1,
    id: "backup-wrong-target-proof-01",
    status: "completed",
    reason: "before-local-source-update:anderes-paket",
    coreVersion: "0.1.19",
    createdAt: new Date().toISOString(),
    components: [],
    files: [],
  };
  let queueCalls = 0;
  const result = await updateCenterService.startLocalSourceUpdateInstallation({
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
  }, {
    async getStatus() {
      return available;
    },
    async createBackup() {
      return { ok: true, backup };
    },
    async validateBackup(id) {
      return {
        ok: true,
        id,
        checkedAt: new Date().toISOString(),
        checkedFiles: 0,
        errors: [],
        backup,
      };
    },
    async queue() {
      queueCalls += 1;
      return { ok: true, accepted: true };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "LOCAL_SOURCE_BACKUP_INVALID");
  assert.equal(queueCalls, 0);
});

test("Paketwechsel zwischen Backupprüfung und Queue wird nicht eingereiht", { concurrency: false }, async (t) => {
  const current = await fixture(t);
  const controlRoot = await writeSupervisorHeartbeat(current.root);
  let backupReason = "";
  const backup = {
    schemaVersion: 1,
    id: "backup-race-proof-01",
    status: "completed",
    reason: "",
    coreVersion: "0.1.19",
    createdAt: new Date().toISOString(),
    components: [],
    files: [],
  };
  const dependencies = {
    getStatus: service.getLocalSourceUpdateStatus,
    queue: service.queueLocalSourceUpdate,
    async createBackup(options) {
      backupReason = options.reason;
      backup.reason = options.reason;
      return { ok: true, backup };
    },
    async validateBackup(id) {
      assert.equal(id, backup.id);
      const changedManifest = manifest(current.updateId);
      changedManifest.files[0].sha256 = "c".repeat(64);
      const changedBody = `${JSON.stringify(changedManifest, null, 2)}\n`;
      await fs.writeFile(path.join(
        current.root,
        "UPDATE",
        "inbox",
        current.updateId,
        "bonni-source-update.json",
      ), changedBody);
      return {
        ok: true,
        id,
        checkedAt: new Date().toISOString(),
        checkedFiles: 0,
        errors: [],
        backup,
      };
    },
  };

  const result = await updateCenterService.startLocalSourceUpdateInstallation({
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
  }, dependencies);
  assert.equal(result.ok, false);
  assert.equal(result.error, "LOCAL_SOURCE_UPDATE_TARGET_CHANGED");
  assert.equal(backupReason, `before-local-source-update:${current.updateId}:${current.manifestSha256}`);
  await assert.rejects(fs.lstat(path.join(controlRoot, "request.json")), /ENOENT/u);
});

test("in-progress-Status mit gewechseltem Manifesthash wird von der Queue nicht als identisch akzeptiert", { concurrency: false }, async (t) => {
  const current = await fixture(t);
  const controlRoot = await writeSupervisorHeartbeat(current.root);
  const pendingRoot = path.join(current.root, "SYSTEM", ".bonni-source-update");
  await fs.mkdir(pendingRoot, { recursive: true });
  await fs.writeFile(path.join(pendingRoot, "pending-update.json"), `${JSON.stringify({
    updateId: current.updateId,
    phase: "apply",
  })}\n`);
  const changedManifest = manifest(current.updateId);
  changedManifest.files[0].sha256 = "d".repeat(64);
  await fs.writeFile(path.join(
    current.root,
    "UPDATE",
    "inbox",
    current.updateId,
    "bonni-source-update.json",
  ), `${JSON.stringify(changedManifest, null, 2)}\n`);

  const result = await service.queueLocalSourceUpdate({
    updateId: current.updateId,
    manifestSha256: current.manifestSha256,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "LOCAL_SOURCE_UPDATE_NOT_AVAILABLE");
  await assert.rejects(fs.lstat(path.join(controlRoot, "request.json")), /ENOENT/u);
});

test("lokale Sourceupdates sind im Produktionsmodus vollständig deaktiviert", { concurrency: false }, async (t) => {
  await fixture(t);
  process.env.NODE_ENV = "production";
  const status = await service.getLocalSourceUpdateStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.state, "disabled");
  assert.equal(status.updateAvailable, false);
});
