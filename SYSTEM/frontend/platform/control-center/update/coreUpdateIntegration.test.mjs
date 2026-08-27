import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dedicated update page sends a confirmed target version to the protected install endpoint", async () => {
  const [api, page, popover] = await Promise.all([
    readFile(new URL("../../../system/api/coreUpdateApi.js", import.meta.url), "utf8"),
    readFile(new URL("./CoreUpdatePage.jsx", import.meta.url), "utf8"),
    readFile(new URL("./CoreUpdatePopover.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(api, /\/install/);
  assert.match(api, /body:\s*\{ targetVersion \}/);
  assert.match(page, /installCoreUpdate\(token, status\?\.targetVersion\)/);
  assert.match(page, /installationBlocked/);
  assert.match(page, /deploymentLifecycleInstallationBlock\(\{/);
  assert.match(page, /"Installieren"/);
  assert.match(page, /Überspringen/);
  assert.doesNotMatch(popover, /installCoreUpdate/);
});

test("update page separates progress, activation and the 14 day user verification", async () => {
  const [page, lifecycle, api] = await Promise.all([
    readFile(new URL("./CoreUpdatePage.jsx", import.meta.url), "utf8"),
    readFile(new URL("./DeploymentLifecyclePanel.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../../system/api/coreUpdateApi.js", import.meta.url), "utf8"),
  ]);

  assert.match(page, /\{busy \? <section className="cc-update-page-card cc-update-page-progress-card is-running">/);
  assert.match(page, /Neue Version ist jetzt aktiv/);
  assert.match(page, /Status öffnen/);
  assert.match(page, /Verstanden/);
  assert.match(page, /Updatepaket geprüft/);
  assert.match(page, /Sicherung erstellt/);
  assert.match(lifecycle, /Funktionsüberprüfung durch Anwender/);
  assert.match(lifecycle, /Downgrade/);
  assert.match(lifecycle, /Übernehmen/);
  assert.match(api, /DEPLOYMENT_LIFECYCLE_PATH\}\/rollback/);
});

test("automatic update guards live in the update polling effect", async () => {
  const topbar = await readFile(
    new URL("../layout/ControlCenterTopBar.jsx", import.meta.url),
    "utf8",
  );
  const loadUpdateStatusIndex = topbar.indexOf("async function loadUpdateStatus");
  const updateEffectIndex = topbar.lastIndexOf("useEffect(() => {", loadUpdateStatusIndex);
  const updateEffectPrefix = topbar.slice(updateEffectIndex, loadUpdateStatusIndex);

  assert.ok(loadUpdateStatusIndex > -1, "Update polling function is missing");
  assert.ok(updateEffectIndex > -1, "Update polling effect is missing");
  assert.match(updateEffectPrefix, /let automaticCheckHandled = false;/);
  assert.match(updateEffectPrefix, /let automaticDownloadHandled = false;/);
});

test("accepted install enters restart transition without hiding real POST failures", async () => {
  const page = await readFile(new URL("./CoreUpdatePage.jsx", import.meta.url), "utf8");
  const installHandlerStart = page.indexOf("async function handleInstall");
  const installHandlerEnd = page.indexOf("function dismissCurrentError", installHandlerStart);
  const installHandler = page.slice(installHandlerStart, installHandlerEnd);
  const localPost = installHandler.indexOf("await installLocalSourceUpdate");
  const releasePost = installHandler.indexOf("await installCoreUpdate");
  const accepted = installHandler.indexOf("setAcceptedInstallTransition(acceptedTransition)");
  const catchBlock = installHandler.indexOf("catch (error)");

  assert.ok(localPost > -1 && releasePost > -1, "install POST calls are missing");
  assert.ok(accepted > localPost && accepted > releasePost, "optimistic state must start only after a successful POST response");
  assert.ok(catchBlock > accepted, "POST failures must stay in the persistent error path");
  assert.match(installHandler, /persistActionError\(normalizeUpdateActionError/);
  assert.match(page, /hasObservedAcceptedUpdate\(payload, acceptedStart\)/);
  assert.match(page, /optimisticRunning \? "Aktualisierung gestartet"/);
  assert.match(page, /Der Installationsauftrag wurde angenommen\. Der Installationsserver übernimmt/);
  assert.match(page, /window\.setInterval\(\(\) => loadStatus\(\{ poll: true \}\), POLL_INTERVAL_MS\)/);
  assert.match(page, /ACCEPTED_UPDATE_TRANSITION_STORAGE_KEY/);
  assert.match(page, /setAcceptedInstallTransition\(\{ \.\.\.current, expired: true \}\)/);
  assert.match(page, /connectionWarning \|\| startTransitionWarning/);
  assert.match(page, /setAcceptedInstallTransition\(null\);[\s\S]*?setStartTransitionWarning\(""\);[\s\S]*?setConnectionWarning\(""\);/);
});

test("local updates poll the installation server first and keep its status authoritative", async () => {
  const page = await readFile(new URL("./CoreUpdatePage.jsx", import.meta.url), "utf8");
  const loadStart = page.indexOf("async function loadStatus");
  const loadEnd = page.indexOf("useEffect(() => {", loadStart);
  const loadStatus = page.slice(loadStart, loadEnd);
  const monitorPoll = loadStatus.indexOf("await fetchInstallationUpdateStatus(monitor)");
  const stayOnInstallation = loadStatus.indexOf("if (!shouldReturnToCore) return", monitorPoll);
  const authenticatedCorePoll = loadStatus.indexOf("await fetchCoreUpdateStatus(token)", stayOnInstallation);

  assert.ok(monitorPoll > -1, "installation monitor polling is missing");
  assert.ok(stayOnInstallation > monitorPoll, "monitor must remain authoritative until it requests Core");
  assert.ok(authenticatedCorePoll > stayOnInstallation, "Core may be polled only after the monitor requests the switch");
  assert.match(loadStatus, /installationMonitorRequestsCoreSwitch\(monitorPayload\)/);
  assert.match(loadStatus, /antwortender alter Core-Stand[\s\S]*?throw error;/u);
  assert.match(page, /window\.setInterval\(\(\) => loadStatus\(\{ poll: true \}\), POLL_INTERVAL_MS\)/);
});

test("automatic return to Core keeps the user token bound and clears monitor access only after success", async () => {
  const [page, apiClient, authStorage] = await Promise.all([
    readFile(new URL("./CoreUpdatePage.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../../system/api/apiClient.js", import.meta.url), "utf8"),
    readFile(new URL("../../../system/auth/clientAuthStorage.js", import.meta.url), "utf8"),
  ]);
  const switchStart = page.indexOf("const shouldReturnToCore");
  const switchEnd = page.indexOf("} catch (error)", switchStart);
  const switchFlow = page.slice(switchStart, switchEnd);
  const corePoll = switchFlow.indexOf("fetchCoreUpdateStatus(token)");
  const coreCommit = switchFlow.indexOf('commitStatus(corePayload, "core")');
  const clearMonitor = switchFlow.indexOf("setInstallationMonitorAccess(null)");

  assert.ok(corePoll > -1, "Core readiness check must use the active user token");
  assert.ok(coreCommit > corePoll, "Core status must be confirmed before it becomes visible");
  assert.ok(clearMonitor > coreCommit, "monitor access must survive until authenticated Core confirmation");
  assert.match(page, /const installation = await installLocalSourceUpdate\(token,/);
  assert.match(page, /normalizeInstallationMonitorAccess\(installation\?\.monitor\)/);
  assert.match(apiClient, /clearClientAuthStorage\(\{[\s\S]*?window\.localStorage[\s\S]*?window\.sessionStorage/);
  assert.match(authStorage, /INSTALLATION_MONITOR_ACCESS_STORAGE_KEY[\s\S]*?"bonni\.local-update\.monitor-access"/);
  assert.match(authStorage, /CLIENT_AUTH_STORAGE_KEYS[\s\S]*?INSTALLATION_MONITOR_ACCESS_STORAGE_KEY/);
});
