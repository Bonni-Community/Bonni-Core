import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = Promise.all([
  readFile(new URL("../../../system/api/coreUpdateApi.js", import.meta.url), "utf8"),
  readFile(new URL("../layout/ControlCenterTopBar.jsx", import.meta.url), "utf8"),
  readFile(new URL("./CoreUpdatePopover.jsx", import.meta.url), "utf8"),
  readFile(new URL("./CoreUpdatePage.jsx", import.meta.url), "utf8"),
  readFile(new URL("../ControlCenter.jsx", import.meta.url), "utf8"),
  readFile(new URL("../ControlCenter.css", import.meta.url), "utf8"),
  readFile(new URL("./CoreUpdatePage.css", import.meta.url), "utf8"),
]);

const lifecycleFiles = Promise.all([
  readFile(new URL("./DeploymentLifecyclePanel.jsx", import.meta.url), "utf8"),
  readFile(new URL("./localUpdatePresentation.js", import.meta.url), "utf8"),
  readFile(new URL("../../../system/api/coreUpdateApi.js", import.meta.url), "utf8"),
]);

test("local source API is additive and binds install to update id and manifest hash", async () => {
  const [api] = await files;

  assert.match(api, /checkLocalSourceUpdate/);
  assert.match(api, /local-source\/check/);
  assert.match(api, /installLocalSourceUpdate/);
  assert.match(api, /local-source\/install/);
  assert.match(api, /body:\s*\{ updateId, manifestSha256 \}/);

  // The signed production path remains separate and keeps its target-version
  // contract.
  assert.match(api, /installCoreUpdate\(token, targetVersion\)/);
  assert.match(api, /body:\s*\{ targetVersion \}/);
});

test("Control Center scans UPDATE, polls status and starts only the selected package", async () => {
  const [, topbar, , page] = await files;

  assert.match(topbar, /await checkLocalSourceUpdate\(token\)\.catch\(\(\) => null\)/);
  assert.match(topbar, /window\.setInterval\(\(\) => loadUpdateStatus\(\{ quiet: true \}\), 5_000\)/);
  assert.match(page, /installLocalSourceUpdate\(token,\s*\{[\s\S]*updateId: localUpdate\.updateId,[\s\S]*manifestSha256: localUpdate\.manifestSha256/);
  assert.doesNotMatch(topbar, /onInstallLocalSource=/);
  assert.match(topbar, /is-local-update/);

  // A package already present in UPDATE is never passed to the production OCI
  // preparation/download flow.
  assert.match(topbar, /payload\?\.updateKind !== "local-source"/);
});

test("popover stays compact and opens the dedicated update page", async () => {
  const [, topbar, popover, page, controlCenter, css, pageCss] = await files;

  assert.match(popover, /Änderungen, Sicherung und Installationsschritte/);
  assert.match(popover, /<span>\{localRelevant \? "Paket"/u);
  assert.match(popover, /`Bonni Core \$\{targetVersionLabel\}`/u);
  assert.doesNotMatch(popover, /Lokales Testupdate/u);
  assert.doesNotMatch(popover, /KontorApp|targetKontorVersion/);
  assert.match(popover, /onNavigate\("update"\)/);
  assert.match(popover, /"Aktualisieren"/);
  assert.doesNotMatch(popover, /installLocalSourceUpdate/);
  assert.match(controlCenter, /<CoreUpdatePage token=\{token\}/);
  assert.match(controlCenter, /\/control-center\/update/);
  assert.match(page, /Was ändert sich/);
  assert.match(page, /Bisheriger Verlauf/);
  assert.match(page, /Fehler kopieren/);
  assert.match(page, /dismissCurrentError/);
  assert.match(page, /localUpdateReleaseNotes\(localUpdate\)/);
  assert.match(page, /sessionStorage/);
  assert.match(page, /UPDATE_ACTION_ERROR_STORAGE_KEY/);
  assert.match(topbar, /storeUpdateError\(normalized\)/);
  assert.match(page, /checks\.find\(\(result\) => result\.status === "rejected"\)/);
  assert.match(page, /className="cc-update-page-confirm"[\s\S]*role="group"/u);
  assert.doesNotMatch(page, /aria-modal="true"/);
  assert.match(page, /aria-labelledby="cc-update-progress-title"/);
  assert.match(page, /copyFallbackText/);
  assert.match(page, /statusSequenceRef/);
  assert.doesNotMatch(page, /if \(!localRelevant \|\| !localUpdate \|\| !updateId/);
  assert.match(css, /\.cc-version-dot\.is-local-update/);
  assert.match(css, /\.cc-update-compact-card/);
  assert.match(pageCss, /\.cc-update-page-error/);
  assert.match(pageCss, /\.cc-update-page-success/);
  assert.match(page, /localMonitorUnavailable/);
  assert.match(page, /startTransitionWarning \|\| connectionWarning \|\|/);
});

test("offer, busy progress, one-time activation and 14-day status are separate views", async () => {
  const [, , popover, page] = await files;
  const heroIndex = page.indexOf("cc-update-page-hero");
  const progressIndex = page.indexOf("cc-update-page-progress-card");
  const activatedIndex = page.indexOf("cc-update-activated");
  const lifecycleIndex = page.indexOf("<DeploymentLifecyclePanel");

  assert.match(page, /`Bonni Core \$\{displayCurrentVersion\} → \$\{displayTargetVersion\}`/u);
  assert.match(page, /`Paket \$\{displayTargetVersion\}`/u);
  assert.doesNotMatch(`${page}\n${popover}`, /KontorApp|cc-update-page-version-grid|currentKontorVersion|targetKontorVersion/);
  assert.ok(heroIndex > -1, "update hero is missing");
  assert.ok(progressIndex > -1, "progress card is missing");
  assert.ok(progressIndex > heroIndex, "progress must appear immediately after the update header");
  assert.ok(activatedIndex > progressIndex, "activation view must follow the temporary progress view");
  assert.ok(lifecycleIndex > progressIndex, "deployment lifecycle must stay below the top progress card");

  // Offer: the user may skip or explicitly enter the confirmation flow.
  assert.match(page, /updateAvailable && !busy && !completed/u);
  assert.match(page, />Überspringen<\/button>/u);
  assert.match(page, /\{installing \? "Wird gestartet …" : "Installieren"\}/u);

  // Progress exists only while an installation is actually busy.
  assert.match(page, /\{busy \? <section className="cc-update-page-card cc-update-page-progress-card is-running">/u);
  assert.match(page, /<span>Aktueller Schritt<\/span>/u);
  assert.match(page, /aria-live="polite"/u);
  assert.match(page, /label: "Updatepaket geprüft"/u);
  assert.match(page, /label: "Sicherung erstellt"/u);
  assert.match(page, /label: "Neues System vorbereitet"/u);
  assert.match(page, /label: "Aktualisierung"/u);

  // Completion gets a single acknowledgement screen per signed hold.
  assert.match(page, /!busy && lifecycleActivatedVisible/u);
  assert.match(page, /Neue Version ist jetzt aktiv/u);
  assert.match(page, /Bonni Core \{displayTargetVersion\} wird jetzt verwendet/u);
  assert.match(page, />Status öffnen<\/button>/u);
  assert.match(page, />Verstanden<\/button>/u);
  assert.match(page, /bonni\.core-update\.activated:\$\{holdId\}/u);

  // Once acknowledged, the explicit 14-day lifecycle view replaces the offer.
  assert.match(page, /!busy && lifecycleObservationActive && !lifecycleActivatedVisible/u);
  assert.match(page, /initialView=\{showLifecycleStatus \? "status" : "verification"\}/u);
  assert.match(page, /!busy && !lifecycleObservationActive/u);
});

test("successful installer handoff reloads the published frontend once", async () => {
  const [, , , page] = await files;

  assert.match(page, /installationMonitorRequestsCoreSwitch\(monitorPayload\)/);
  assert.match(page, /frontendReloadScheduledRef/);
  assert.match(page, /window\.setTimeout\(\(\) => window\.location\.reload\(\), 0\)/);
});

test("14-day lifecycle tabs are operable and downgrade/finalize use the signed proof", async () => {
  const [, , , page] = await files;
  const [panel, presentation, api] = await lifecycleFiles;

  assert.match(page, /\(\) => !status\?\.deploymentLifecycle[\s\S]*\? null[\s\S]*normalizeDeploymentLifecycle\(status\.deploymentLifecycle/u);
  assert.match(page, /deploymentLifecycleInstallationBlock\(\{[\s\S]*lifecycle: deploymentLifecycle,[\s\S]*localRelevant,[\s\S]*updateAvailable,[\s\S]*installation: status\?\.installation/u);
  assert.match(page, /const installationBlocked = !optimisticRunning && \([\s\S]*lifecycleBlock\.blocked/u);
  assert.match(page, /async function handleInstall\(\) \{[\s\S]*installationBlocked\) return;/u);
  assert.match(page, /Gesperrt bis Rückfallabschluss/u);
  assert.match(page, /finalizeCoreDeploymentLifecycle\(token, \{/u);
  assert.match(page, /rollbackCoreDeploymentLifecycle\(token, \{/u);
  assert.match(page, /holdId: deploymentLifecycle\.holdId/u);
  assert.match(page, /generation: deploymentLifecycle\.generation/u);
  assert.match(page, /const refreshed = await loadStatus\(\)/u);
  assert.match(api, /DEPLOYMENT_LIFECYCLE_PATH\}\/finalize/u);
  assert.match(api, /DEPLOYMENT_LIFECYCLE_PATH\}\/rollback/u);

  assert.match(panel, /useState\(initialView === "status" \? "status" : "verification"\)/u);
  assert.match(panel, /role="tablist"/u);
  assert.match(panel, /role="tab"/u);
  assert.match(panel, /aria-selected=\{statusActive\}/u);
  assert.match(panel, /aria-selected=\{verificationActive\}/u);
  assert.match(panel, /onClick=\{\(\) => setActiveView\("status"\)\}/u);
  assert.match(panel, /onClick=\{\(\) => setActiveView\("verification"\)\}/u);
  assert.match(panel, /role="tabpanel"/u);
  assert.match(panel, /Funktionsüberprüfung durch Anwender/u);
  assert.match(panel, /\{remaining\} aktiv/u);
  assert.match(panel, /<span>Downgrade<\/span>[\s\S]*lifecycle\.previousVersion/u);
  assert.match(panel, /<span>Übernehmen<\/span>[\s\S]*lifecycle\.targetVersion/u);
  assert.match(panel, /dieselbe gemeinsame Datenbank/u);
  assert.match(panel, /Nutzdaten werden nicht zurückgesetzt/u);
  assert.match(panel, /!proofAvailable/u);

  assert.match(presentation, /DEPLOYMENT_LIFECYCLE_HOLD_DAYS = 14/u);
  assert.match(presentation, /holdUntilMs - activatedAtMs !== DEPLOYMENT_LIFECYCLE_HOLD_MS/u);
  assert.match(presentation, /canFinalize: value\.canFinalize === true && !holdContractIssue/u);
  assert.match(presentation, /canRollback: value\.canRollback === true && !holdContractIssue/u);
});
