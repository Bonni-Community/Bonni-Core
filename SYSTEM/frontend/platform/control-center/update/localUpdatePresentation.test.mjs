import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTED_UPDATE_STATUS_TIMEOUT_MS,
  ACCEPTED_UPDATE_TRANSITION_MAX_AGE_MS,
  deploymentLifecycleInstallationBlock,
  formatBonniCoreVersion,
  formatDeploymentLifecycleRemaining,
  hasAcceptedUpdateStatusTimedOut,
  localUpdateError,
  localUpdateReleaseNotes,
  hasObservedAcceptedUpdate,
  isUpdateBusy,
  isUpdateFailed,
  normalizeUpdateActionError,
  normalizeAcceptedUpdateTransition,
  normalizeDeploymentLifecycle,
  normalizeUpdateSteps,
  deploymentLifecycleStages,
  updateExecutionObservation,
  updateProgressPercent,
} from "./localUpdatePresentation.js";

test("deployment lifecycle normalizes a generations-bound 14 day hold", () => {
  const now = Date.parse("2026-08-22T10:00:00.000Z");
  const lifecycle = normalizeDeploymentLifecycle({
    protocol: "bonni-deployment-lifecycle/1",
    schemaVersion: 1,
    state: "holding",
    targetVersion: "0.1.20",
    previousVersion: "0.1.19+a",
    holdId: "hold-019-020-01",
    generation: 7,
    holdDays: 14,
    activatedAt: "2026-08-22T10:00:00.000Z",
    holdUntil: "2026-09-05T10:00:00.000Z",
    canFinalize: true,
    blocksUpdates: true,
    mode: "single-active-fail-closed-hold",
    updatedAt: "2026-08-22T10:00:00.000Z",
  }, now);

  assert.equal(lifecycle.phase, "observation");
  assert.equal(lifecycle.followUpdatesBlocked, true);
  assert.equal(lifecycle.generation, 7);
  assert.equal(lifecycle.holdId, "hold-019-020-01");
  assert.equal(lifecycle.holdDays, 14);
  assert.equal(lifecycle.holdContractValid, true);
  assert.equal(lifecycle.holdContractIssue, "");
  assert.equal(lifecycle.canFinalize, true);
  assert.equal(lifecycle.currentVersion, "0.1.20");
  assert.equal(formatDeploymentLifecycleRemaining(lifecycle.remainingMs), "Noch 14 Tage");
});

test("deployment lifecycle accepts holdDays only when it is exactly 14", () => {
  const lifecycle = normalizeDeploymentLifecycle({
    state: "candidate-testing",
    holdDays: 13,
  });

  assert.equal(lifecycle.holdDays, null);
  assert.equal(lifecycle.holdContractValid, true);
});

test("a non-14-day active hold is rejected and remains fail-closed", () => {
  const lifecycle = normalizeDeploymentLifecycle({
    state: "holding",
    holdId: "hold-invalid-contract-01",
    generation: 11,
    holdDays: 13,
    activatedAt: "2026-08-22T10:00:00.000Z",
    holdUntil: "2026-09-05T10:00:00.000Z",
    blocksUpdates: false,
    canFinalize: true,
  });

  assert.equal(lifecycle.holdDays, null);
  assert.equal(lifecycle.holdContractValid, false);
  assert.match(lifecycle.holdContractIssue, /exakt 14 Tage/u);
  assert.equal(lifecycle.followUpdatesBlocked, true);
  assert.equal(lifecycle.canFinalize, false);
});

test("an invalid active hold duration fails closed without hiding the update block", () => {
  const lifecycle = normalizeDeploymentLifecycle({
    state: "holding",
    targetVersion: "0.1.20",
    previousVersion: "0.1.19+a",
    holdId: "hold-invalid-days-01",
    generation: 12,
    holdDays: 14,
    activatedAt: "2026-08-22T10:00:00.000Z",
    holdUntil: "2026-09-04T10:00:00.000Z",
    blocksUpdates: false,
    canFinalize: true,
  });

  assert.equal(lifecycle.phase, "observation");
  assert.equal(lifecycle.holdDays, 14);
  assert.equal(lifecycle.holdContractValid, false);
  assert.match(lifecycle.holdContractIssue, /exakt 14 Tagen/u);
  assert.equal(lifecycle.followUpdatesBlocked, true);
  assert.equal(lifecycle.canFinalize, false);
  assert.equal(lifecycle.blockReason, lifecycle.holdContractIssue);
  assert.equal(lifecycle.holdUntil, "2026-09-04T10:00:00.000Z");
});

test("an incomplete active 14 day hold contract also remains visibly blocked", () => {
  const lifecycle = normalizeDeploymentLifecycle({
    state: "finalizing",
    holdId: "hold-missing-start-01",
    generation: 13,
    holdDays: 14,
    holdUntil: "2026-09-05T10:00:00.000Z",
    blocksUpdates: false,
    canFinalize: true,
  });

  assert.equal(lifecycle.phase, "finalize");
  assert.equal(lifecycle.holdContractValid, false);
  assert.match(lifecycle.holdContractIssue, /Beginn und Ende/u);
  assert.equal(lifecycle.followUpdatesBlocked, true);
  assert.equal(lifecycle.canFinalize, false);
});

test("an active lifecycle hold blocks a local source package with the server reason", () => {
  const lifecycle = normalizeDeploymentLifecycle({
    state: "holding",
    targetVersion: "0.1.20",
    previousVersion: "0.1.19+a",
    holdId: "hold-local-block-01",
    generation: 11,
    holdDays: 14,
    activatedAt: "2026-08-22T10:00:00.000Z",
    holdUntil: "2026-09-05T10:00:00.000Z",
    blocksUpdates: true,
    canFinalize: true,
  });
  const blocked = deploymentLifecycleInstallationBlock({
    lifecycle,
    localRelevant: true,
    updateAvailable: true,
    installation: {
      allowed: false,
      reason: "Der vorherige Stand ist noch als Rückfallstand geschützt.",
    },
  });

  assert.equal(blocked.blocked, true);
  assert.equal(blocked.serverBlocked, true);
  assert.equal(blocked.lifecycleBlocked, true);
  assert.equal(blocked.localLifecycleBlocked, true);
  assert.match(blocked.reason, /Rückfallstand geschützt/u);
});

test("deployment stages describe isolated candidate and exactly one productive database writer", () => {
  const lifecycle = normalizeDeploymentLifecycle({
    status: "candidate-testing",
    activeSlot: "active",
    standbySlot: "candidate",
    currentVersion: "0.1.19+a",
    targetVersion: "0.1.20",
    generation: 8,
    canFinalize: false,
  });
  const stages = deploymentLifecycleStages(lifecycle);
  const source = JSON.stringify(stages);

  assert.equal(stages[0].status, "running");
  assert.match(source, /isolierten Testkopie/u);
  assert.match(source, /immer nur der aktive Stand/u);
  assert.doesNotMatch(source, /zwei produktive|beide.*Produktionsdatenbank/iu);
  assert.equal(stages.some((stage) => stage.key === "controlled-rollback"), false);
});

test("controlled rollback appears only when the server reports a rollback phase", () => {
  const lifecycle = normalizeDeploymentLifecycle({ status: "rolling-back", generation: 9 });
  const stages = deploymentLifecycleStages(lifecycle);
  assert.equal(stages.at(-1).key, "controlled-rollback");
  assert.equal(stages.at(-1).status, "running");
  assert.match(stages.at(-1).detail, /nur vor der endgültigen Finalisierung/u);
});

test("Bonni Core build identifiers retain the package label with plus sign", () => {
  assert.equal(formatBonniCoreVersion("0.1.19+a"), "0.1.19+a");
  assert.equal(formatBonniCoreVersion("0.1.20"), "0.1.20");
  assert.equal(formatBonniCoreVersion(""), "—");
});

test("the local package version is the release heading", () => {
  const notes = localUpdateReleaseNotes({
    from: { coreVersion: "0.1.19", kontorAppVersion: "0.19.3" },
    to: { coreVersion: "0.1.19+a", kontorAppVersion: "0.19.3" },
    releaseNotes: {
      title: "Lokales Testupdate",
      summary: "Die Anzeige wird vereinheitlicht. KontorApp 0.19.3 bleibt unverändert.",
      changes: [
        { type: "improvement", title: "Bonni Core 0.1.19+a", detail: "Das Paket trägt seine Zielversion." },
        { type: "information", title: "KontorApp bleibt unverändert", detail: "KontorApp wird nicht aktualisiert." },
      ],
    },
  });

  assert.equal(notes.title, "0.1.19+a");
  assert.match(JSON.stringify(notes), /0\.1\.19\+a/u);
  assert.doesNotMatch(JSON.stringify(notes), /0\.1\.19\.a|KontorApp/u);
});

test("local release notes preserve title, summary and typed changes", () => {
  const notes = localUpdateReleaseNotes({
    releaseNotes: {
      title: "Update 04",
      summary: "2FA und Aktualisierung wurden verbessert.",
      changes: [
        { type: "Sicherheit", title: "2FA korrigiert", detail: "Freigaben werden richtig zugeordnet." },
      ],
    },
  });

  assert.equal(notes.supplied, true);
  assert.equal(notes.title, "Update 04");
  assert.equal(notes.changes[0].type, "Sicherheit");
  assert.equal(notes.changes[0].title, "2FA korrigiert");
});

test("older manifests receive a safe fallback from counts and components", () => {
  const notes = localUpdateReleaseNotes({
    counts: { files: 10, inventory: 1392, delete: 0 },
    components: [
      { key: "bonni-core-backend" },
      { key: "app.kontorapp", label: "KontorApp" },
    ],
  });

  assert.equal(notes.supplied, false);
  assert.match(notes.summary, /noch keine fachliche Versionsbeschreibung/);
  assert.match(notes.changes[0].title, /10 Dateien/);
  assert.match(notes.changes[0].detail, /1392 verwaltete Dateien/);
  assert.equal(notes.changes[1].title, "Bonni Core");
  assert.equal(notes.changes.length, 2);
  assert.doesNotMatch(JSON.stringify(notes), /KontorApp|Kontor-Bereich/);
});

test("pg_dump backup failure is translated without hiding its technical details", () => {
  const error = localUpdateError({
    errorCode: "LOCAL_SOURCE_BACKUP_FAILED",
    progress: { error: "spawn pg_dump ENOENT" },
  });

  assert.equal(error.title, "Sicherung konnte nicht erstellt werden");
  assert.match(error.explanation, /noch keine Programmdateien ersetzt/);
  assert.equal(error.technical, "spawn pg_dump ENOENT");
  assert.equal(error.code, "LOCAL_SOURCE_BACKUP_FAILED");
});

test("PostgreSQL backup causes keep separate and accurate explanations", () => {
  const missing = localUpdateError({}, {
    message: "Sicherung fehlgeschlagen",
    code: "LOCAL_SOURCE_BACKUP_FAILED",
    causeCode: "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED",
    technicalMessage: "PostgreSQL-Werkzeuge nicht gefunden",
  });
  const invalidPath = localUpdateError({}, {
    message: "Sicherung fehlgeschlagen",
    causeCode: "POSTGRESQL_TOOL_CONFIG_INVALID",
    technicalMessage: "PG_DUMP_PATH ist ungültig",
  });
  const notExecutable = localUpdateError({}, {
    message: "Sicherung fehlgeschlagen",
    causeCode: "POSTGRESQL_TOOL_NOT_EXECUTABLE",
    technicalMessage: "pg_dump besitzt keine Ausführungsberechtigung",
  });

  assert.equal(missing.title, "Sicherung konnte nicht erstellt werden");
  assert.equal(missing.code, "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED");
  assert.equal(invalidPath.title, "Pfad zu pg_dump ist ungültig");
  assert.match(invalidPath.explanation, /PG_DUMP_PATH/);
  assert.equal(notExecutable.title, "pg_dump kann nicht ausgeführt werden");
});

test("a missing predecessor names Update 09, its id and the required version", () => {
  const error = localUpdateError({
    errorCode: "LOCAL_SOURCE_REQUIRED_PREDECESSOR_MISSING",
    message: "Update 09 fehlt.",
    requiredPredecessor: {
      updateId: "u-019-0193-0822-09",
      manifestSha256: "c".repeat(64),
      coreVersion: "0.1.19",
      kontorAppVersion: "0.19.3",
    },
    to: { coreVersion: "0.1.19+a", kontorAppVersion: "0.19.3" },
  });

  assert.equal(error.title, "Update 09 fehlt");
  assert.match(error.explanation, /Bonni Core 0\.1\.19/u);
  assert.match(error.explanation, /Bonni Core 0\.1\.19\+a/u);
  assert.match(error.technical, /u-019-0193-0822-09/u);
});

test("progress uses normalized completed steps when no percentage is supplied", () => {
  const progress = {
    steps: [
      { key: "one", status: "completed" },
      { key: "two", status: "running" },
      { key: "three", status: "pending" },
      { key: "four", status: "pending" },
    ],
  };
  const steps = normalizeUpdateSteps(progress);
  assert.equal(updateProgressPercent(progress, steps), 25);
});

test("setup substeps advance the overall installation bar monotonically", () => {
  const steps = normalizeUpdateSteps({
    steps: [
      { key: "validate", status: "completed" },
      { key: "handoff", status: "completed" },
      { key: "stop", status: "completed" },
      { key: "install", status: "active" },
      { key: "restart", status: "pending" },
      { key: "health", status: "pending" },
      { key: "return", status: "pending" },
    ],
  });
  const first = updateProgressPercent({ setup: { stageIndex: 1, stageCount: 10 } }, steps);
  const middle = updateProgressPercent({ setup: { stageIndex: 5, stageCount: 10 } }, steps);
  const last = updateProgressPercent({ setup: { stageIndex: 10, stageCount: 10 } }, steps);

  assert.equal(first < middle, true);
  assert.equal(middle < last, true);
  assert.equal(Math.round(last), 57);
  assert.deepEqual(steps.map((step) => step.label), [
    "Neue Pakete werden geprüft",
    "Installationsdienst übernimmt",
    "Wechsel wird vorbereitet",
    "Aktualisierung wird durchgeführt",
    "Bonni Core wird neu gestartet",
    "Funktionstest – Bonni Core wird geprüft",
    "Aktualisierung wird abgeschlossen",
  ]);
});

test("rollback wording appears only when a rollback phase is actually reported", () => {
  const normal = normalizeUpdateSteps({
    steps: [{ key: "install", status: "running" }],
  }, { kind: "local-source" });
  const rollback = normalizeUpdateSteps({
    steps: [{ key: "rollback", status: "running" }],
  }, { kind: "local-source" });

  assert.doesNotMatch(JSON.stringify(normal), /wiederhergestellt/u);
  assert.equal(rollback[0].label, "Fehler erkannt – bisheriger Stand wird wiederhergestellt");
});

test("remote download percentage is weighted as one workflow step instead of overall progress", () => {
  const progress = {
    status: "installing",
    progressPercent: 100,
    steps: [
      { key: "preflight", status: "completed" },
      { key: "store", status: "completed" },
      { key: "download", status: "completed" },
      { key: "signature", status: "completed" },
      { key: "backup", status: "running" },
      { key: "candidate", status: "pending" },
      { key: "health", status: "pending" },
      { key: "switch", status: "pending" },
    ],
  };
  const percent = updateProgressPercent(progress);
  assert.ok(percent > 50 && percent < 100);
  assert.equal(updateProgressPercent({ ...progress, status: "completed" }), 100);
  const steps = normalizeUpdateSteps(progress, { kind: "release" });
  assert.equal(steps.find((step) => step.key === "candidate")?.label, "Isolierten Candidate mit Testkopie vorbereiten");
  assert.equal(steps.find((step) => step.key === "health")?.label, "Isolierten Candidate vollständig prüfen");
  assert.equal(steps.find((step) => step.key === "switch")?.label, "Kontrollierter Wechsel auf den geprüften Stand");
});

test("rollback remains busy until completion and then becomes a persistent failure state", () => {
  assert.equal(isUpdateBusy("rolling-back"), true);
  assert.equal(isUpdateFailed("rolling-back"), false);
  assert.equal(isUpdateFailed("rolled-back"), true);
});

test("shared update action errors retain code, cause and update context", () => {
  const normalized = normalizeUpdateActionError({
    message: "Sicherung fehlgeschlagen",
    code: "LOCAL_SOURCE_BACKUP_FAILED",
    data: { causeCode: "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED" },
  }, "Fallback", "update-05");
  assert.equal(normalized.updateId, "update-05");
  assert.equal(normalized.code, "LOCAL_SOURCE_BACKUP_FAILED");
  assert.equal(normalized.causeCode, "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED");
  assert.ok(Number.isFinite(Date.parse(normalized.createdAt)));
});

test("accepted update waits for a genuinely new execution status", () => {
  const available = {
    localSourceUpdate: {
      updateId: "update-06",
      state: "available",
      progress: { status: "idle", updatedAt: "2026-08-21T20:00:00.000Z" },
    },
  };
  const optimisticStart = {
    kind: "local-source",
    updateId: "update-06",
    baselineSignature: updateExecutionObservation(available).signature,
  };

  assert.equal(hasObservedAcceptedUpdate(available, optimisticStart), false);
  assert.equal(hasObservedAcceptedUpdate({
    localSourceUpdate: {
      updateId: "update-06",
      state: "in-progress",
      progress: { status: "restarting", updatedAt: "2026-08-21T20:00:02.000Z" },
    },
  }, optimisticStart), true);
  assert.equal(hasObservedAcceptedUpdate({
    localSourceUpdate: {
      updateId: "update-06",
      state: "completed",
      progress: { status: "completed", updatedAt: "2026-08-21T20:00:08.000Z" },
    },
  }, optimisticStart), true);
  assert.equal(hasObservedAcceptedUpdate({
    localSourceUpdate: {
      updateId: "update-06",
      state: "failed",
      errorCode: "LOCAL_SOURCE_APPLY_FAILED",
      progress: { status: "failed", updatedAt: "2026-08-21T20:00:05.000Z" },
    },
  }, optimisticStart), true);
});

test("retry does not mistake the previous failure or another package for new status", () => {
  const previousFailure = {
    localSourceUpdate: {
      updateId: "update-06",
      state: "failed",
      errorCode: "OLD_FAILURE",
      progress: {
        status: "failed",
        updatedAt: "2026-08-21T19:58:00.000Z",
        error: "Alter Fehler",
      },
    },
  };
  const optimisticStart = {
    kind: "local-source",
    updateId: "update-06",
    baselineSignature: updateExecutionObservation(previousFailure).signature,
  };

  assert.equal(hasObservedAcceptedUpdate(previousFailure, optimisticStart), false);
  assert.equal(hasObservedAcceptedUpdate({
    localSourceUpdate: {
      updateId: "update-07",
      state: "in-progress",
      progress: { status: "applying", updatedAt: "2026-08-21T20:01:00.000Z" },
    },
  }, optimisticStart), false);
  assert.equal(hasObservedAcceptedUpdate({
    localSourceUpdate: {
      state: "in-progress",
      progress: { status: "applying", updatedAt: "2026-08-21T20:01:00.000Z" },
    },
  }, optimisticStart), false);
  assert.equal(hasObservedAcceptedUpdate({
    localSourceUpdate: {
      ...previousFailure.localSourceUpdate,
      progress: {
        ...previousFailure.localSourceUpdate.progress,
        updatedAt: "2026-08-21T20:01:00.000Z",
        error: "Neuer Fehler",
      },
    },
  }, optimisticStart), true);
});

test("release start accepts the new workflow id only for the selected target version", () => {
  const available = {
    targetVersion: "0.1.20",
    manifest: { version: "0.1.20" },
    workflow: null,
  };
  const baseline = updateExecutionObservation(available, "release");
  const optimisticStart = {
    kind: "release",
    updateId: "0.1.20",
    targetVersion: baseline.targetVersion,
    baselineSignature: baseline.signature,
    startedAt: "2026-08-21T20:00:00.000Z",
  };

  assert.equal(hasObservedAcceptedUpdate({
    targetVersion: "0.1.20",
    workflow: {
      id: "update-1787342400000-abcd1234",
      targetVersion: "0.1.20",
      status: "running",
      updatedAt: "2026-08-21T20:00:02.000Z",
    },
  }, optimisticStart), true);
  assert.equal(hasObservedAcceptedUpdate({
    targetVersion: "0.1.21",
    workflow: {
      id: "update-other-release",
      targetVersion: "0.1.21",
      status: "running",
      updatedAt: "2026-08-21T20:00:02.000Z",
    },
  }, optimisticStart), false);

  const statusWithOlderWorkflow = {
    targetVersion: "0.1.20",
    workflow: {
      id: "update-previous-release",
      targetVersion: "0.1.19",
      status: "failed",
      updatedAt: "2026-08-21T19:55:00.000Z",
    },
  };
  const olderBaseline = updateExecutionObservation(statusWithOlderWorkflow, "release");
  const retryStart = {
    kind: "release",
    updateId: "update-previous-release",
    targetVersion: statusWithOlderWorkflow.targetVersion,
    baselineSignature: olderBaseline.signature,
    startedAt: "2026-08-21T20:00:00.000Z",
  };
  assert.equal(hasObservedAcceptedUpdate({
    targetVersion: "0.1.20",
    workflow: {
      ...statusWithOlderWorkflow.workflow,
      updatedAt: "2026-08-21T20:00:01.000Z",
    },
  }, retryStart), false);
  assert.equal(hasObservedAcceptedUpdate({
    targetVersion: "0.1.20",
    workflow: {
      id: "update-new-release",
      targetVersion: "0.1.20",
      status: "running",
      updatedAt: "2026-08-21T20:00:02.000Z",
    },
  }, retryStart), true);
});

test("accepted update status transition expires after one minute", () => {
  const startedAt = Date.parse("2026-08-21T20:00:00.000Z");
  const optimisticStart = { startedAt: new Date(startedAt).toISOString() };

  assert.equal(hasAcceptedUpdateStatusTimedOut(
    optimisticStart,
    startedAt + ACCEPTED_UPDATE_STATUS_TIMEOUT_MS - 1,
  ), false);
  assert.equal(hasAcceptedUpdateStatusTimedOut(
    optimisticStart,
    startedAt + ACCEPTED_UPDATE_STATUS_TIMEOUT_MS,
  ), true);
  assert.equal(hasAcceptedUpdateStatusTimedOut({ startedAt: "ungültig" }, startedAt), true);
  assert.equal(hasAcceptedUpdateStatusTimedOut({ ...optimisticStart, expired: true }, startedAt + 120_000), false);
});

test("accepted transition can survive a reload only for five minutes", () => {
  const startedAt = Date.parse("2026-08-21T20:00:00.000Z");
  const release = {
    kind: "release",
    updateId: "0.1.20",
    targetVersion: "0.1.20",
    baselineSignature: JSON.stringify(["", "0.1.20", "none", "idle"]),
    startedAt: new Date(startedAt).toISOString(),
  };
  assert.equal(
    normalizeAcceptedUpdateTransition(release, startedAt + ACCEPTED_UPDATE_STATUS_TIMEOUT_MS - 1)?.expired,
    false,
  );
  assert.equal(
    normalizeAcceptedUpdateTransition(release, startedAt + ACCEPTED_UPDATE_STATUS_TIMEOUT_MS)?.expired,
    true,
  );
  assert.equal(
    normalizeAcceptedUpdateTransition(release, startedAt + ACCEPTED_UPDATE_TRANSITION_MAX_AGE_MS + 1),
    null,
  );
  assert.equal(normalizeAcceptedUpdateTransition({ ...release, targetVersion: "" }, startedAt), null);
  assert.equal(normalizeAcceptedUpdateTransition({
    ...release,
    kind: "local-source",
    updateId: "",
    targetVersion: "",
  }, startedAt), null);
  assert.equal(normalizeAcceptedUpdateTransition({ ...release, baselineSignature: "ungültig" }, startedAt), null);
});
