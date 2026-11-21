import DiagnosticJournal from "./DiagnosticJournal.jsx";
import DiagnosticApplicationPicker from "./DiagnosticApplicationPicker.jsx";
import UserLoginDiagnostics from "./UserLoginDiagnostics.jsx";
import LiveLogTerminal from "./LiveLogTerminal.jsx";
import { openBonniTerminalWindow } from "../terminal/terminalWindow.js";
import {
  catalog,
  diagnosticApplicationOptions,
  groupedDiagnostics,
} from "../../../system/diagnostics/journalModel.js";
import { useEffect, useRef, useState } from "react";

import {
  downloadCoreDiagnosticsLog,
  fetchCoreDiagnosticsLogs,
  fetchCoreLoginDiagnostics,
} from "../../../system/api/systemDiagnosticsApi.js";
import "./CoreDiagnosticsPage.css";

const ERROR_TAB = "error";
const LOG_TAB = "log";
const TERMINAL_TAB = "terminal";
const LIVE_TAB = "live";
const VALID_TABS = new Set([LOG_TAB, ERROR_TAB, TERMINAL_TAB, LIVE_TAB]);
const SYSTEM = "system";
const APPLICATIONS = "applications";
const USERS = "users";
const AREAS = {
  [SYSTEM]: catalog.categories.system,
  [APPLICATIONS]: catalog.categories.applications,
  [USERS]: "Benutzer",
};

function initialTab() {
  try {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return VALID_TABS.has(requested) ? requested : LOG_TAB;
  } catch {
    return LOG_TAB;
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function isErrorLogLine(line) {
  return /\s(?:CRITICAL|ERROR)\s/u.test(String(line));
}

function ErrorBlock({ block }) {
  return (
    <article className={`cc-core-error-block${block.critical ? " is-critical" : ""}`}>
      <div className="cc-core-error-block__line cc-core-error-block__timestamp">= {block.timestamp}</div>
      <div className="cc-core-error-block__line cc-core-error-block__separator">——————————————-</div>
      <div className="cc-core-error-block__context" aria-label="Logzeilen vor dem Error">
        {(block.contextLines || []).map((line, index) => (
          <div key={`${index}-${line}`}>{line || " "}</div>
        ))}
      </div>
      <div className="cc-core-error-block__error" role="alert">
        {(block.errorLines || []).map((line, index) => (
          <div key={`${index}-${line}`}>{line}</div>
        ))}
      </div>
      <div className="cc-core-error-block__context" aria-label="Logzeilen nach dem Error">
        {(block.afterContextLines || []).map((line, index) => (
          <div key={`${index}-${line}`}>{line || " "}</div>
        ))}
      </div>
      <div className="cc-core-error-block__line cc-core-error-block__separator">——————————————-</div>
    </article>
  );
}

function TerminalShortcut() {
  const [blocked, setBlocked] = useState(false);
  return (
    <section className="cc-core-terminal-shortcut">
      <h2>Bonni-Terminal</h2>
      <p>Im eigenen Fenster kannst du Befehle eingeben und die Ausgabe direkt lesen.</p>
      <button type="button" className="cc-core-diagnostics-action" onClick={() => setBlocked(!openBonniTerminalWindow())}>
        Neues Terminalfenster öffnen
      </button>
      {blocked && <p role="alert">Der Browser hat das Terminalfenster blockiert. Erlaube Pop-ups für Bonni Core.</p>}
    </section>
  );
}

export default function CoreDiagnosticsPage({ token }) {
  const [tab, setTab] = useState(initialTab);
  const [category, setCategory] = useState(SYSTEM);
  const [selectedModuleId, setSelectedModuleId] = useState("");
  const [applications, setApplications] = useState([]);
  const [applicationRegistryAvailable, setApplicationRegistryAvailable] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  const snapshotSequence = useRef(0);
  const snapshotController = useRef(null);
  const [snapshotResult, setSnapshotResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState("");
  const isSystem = category === SYSTEM;
  const isApplications = category === APPLICATIONS;
  const isUsers = category === USERS;
  const isLive = isSystem && tab === LIVE_TAB;
  const moduleId = isApplications ? selectedModuleId || undefined : undefined;
  const snapshot = snapshotResult?.category === category && snapshotResult.moduleId === moduleId
    ? snapshotResult.payload : null;

  async function loadSnapshot({ quiet = false } = {}) {
    if (!token || (quiet && snapshotController.current)) return;
    const sequence = ++snapshotSequence.current;
    snapshotController.current?.abort();
    const controller = new AbortController();
    snapshotController.current = controller;
    if (!quiet) setLoading(true);
    try {
      const payload = isUsers
        ? await fetchCoreLoginDiagnostics(token, { signal: controller.signal })
        : await fetchCoreDiagnosticsLogs(token, 500, { category, moduleId, signal: controller.signal });
      if (sequence !== snapshotSequence.current) return;
      setSnapshotResult({ category, moduleId, payload });
      if (isApplications) {
        const options = diagnosticApplicationOptions(payload.applications, payload.journal?.applicationIds);
        if (moduleId && !options.some(item => item.id === moduleId)) {
          // Keep a selected historical application visible when its last entry expires.
          options.push(diagnosticApplicationOptions([], [moduleId])[0]);
        }
        setApplications(options);
        setApplicationRegistryAvailable(payload.applicationRegistryAvailable);
      }
      setError("");
    } catch (loadError) {
      if (sequence !== snapshotSequence.current || controller.signal.aborted) return;
      setError(loadError?.message || "Core-Diagnose konnte nicht geladen werden.");
    } finally {
      if (sequence === snapshotSequence.current) {
        snapshotController.current = null;
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    if (isLive) return undefined;
    setSnapshotResult(null);
    loadSnapshot();
    const interval = window.setInterval(() => loadSnapshot({ quiet: true }), 5_000);
    return () => {
      window.clearInterval(interval);
      ++snapshotSequence.current;
      snapshotController.current?.abort();
      snapshotController.current = null;
    };
  }, [token, category, moduleId, isLive]);

  function selectTab(nextTab) {
    if (!VALID_TABS.has(nextTab)) return;
    setTab(nextTab);
    const suffix = nextTab === LOG_TAB ? "" : `?tab=${nextTab}`;
    window.history.replaceState(null, "", `/control-center/diagnostics${suffix}`);
  }

  function selectCategory(nextCategory) {
    setCategory(nextCategory);
    if (nextCategory !== SYSTEM && (tab === TERMINAL_TAB || tab === LIVE_TAB)) selectTab(LOG_TAB);
  }

  async function exportStream(stream, group) {
    setExporting(stream);
    try {
      const content = await downloadCoreDiagnosticsLog(token, stream === ERROR_TAB ? "journal-error" : "journal", {
        category,
        operationId: group?.operationId,
        moduleId: group?.moduleId || moduleId,
      });
      const blob = new Blob([content || ""], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const exportScope = moduleId || category;
      anchor.download = group?.operationId ? `bonni-core-vorgang-${group.operationId}.log` : stream === ERROR_TAB ? `bonni-core-${exportScope}-error.txt` : `bonni-core-${exportScope}.log`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError?.message || "Diagnose-Datei konnte nicht exportiert werden.");
    } finally {
      setExporting("");
    }
  }

  const logLines = snapshot?.logLines || [];
  const errorBlocks = snapshot?.errorBlocks || [];
  const failedCount = groupedDiagnostics(snapshot?.journal?.entries, { onlyErrors: true }).length;
  return (
    <section className="cc-menu-layout-page cc-core-diagnostics-page">
      <header className="cc-core-diagnostics-header">
        <h1>Core-Diagnose</h1>
      </header>

      {error ? <div className="cc-core-diagnostics-alert is-error" role="alert">{error}</div> : null}

      <div className="cc-diagnostic-toolbar">
        <nav className="cc-diagnostic-categories" aria-label="Diagnosebereiche">
          {Object.entries(AREAS).map(([key, label]) => (
            <button key={key} type="button" aria-pressed={category === key} onClick={() => selectCategory(key)}>
              {label}
            </button>
          ))}
        </nav>
        {isSystem && (tab === LOG_TAB || tab === ERROR_TAB) && (
          <button className="cc-core-diagnostics-action" type="button" aria-expanded={showRaw} onClick={() => setShowRaw(value => !value)}>
            Technische Rohansicht
          </button>
        )}
        {isApplications && (
          <DiagnosticApplicationPicker applications={applications} selectedId={selectedModuleId} onSelect={setSelectedModuleId} />
        )}
      </div>
      {isApplications && applicationRegistryAvailable === false && (
        <small className="cc-diagnostic-inventory-note" role="status">Paketübersicht ist teilweise nicht verfügbar.</small>
      )}

      {isUsers ? (
        <UserLoginDiagnostics snapshot={snapshot} loading={loading || (!snapshot && !error)} />
      ) : (
        <section className="cc-core-diagnostics-surface" aria-label="Diagnoseprotokoll">
          <div className="cc-core-diagnostics-tabs">
            <div className="cc-core-diagnostics-streams" role="tablist" aria-label="Diagnoseansicht">
              <button id="cc-diagnostic-log" type="button" role="tab" aria-selected={tab === LOG_TAB} aria-controls="cc-diagnostic-content" onClick={() => selectTab(LOG_TAB)}>
                Protokoll <span>{snapshot?.journal?.total ?? snapshot?.counts?.logLines ?? 0}</span>
              </button>
              <button id="cc-diagnostic-error" type="button" role="tab" aria-selected={tab === ERROR_TAB} aria-controls="cc-diagnostic-content" onClick={() => selectTab(ERROR_TAB)}>
                Fehler <span>{failedCount}</span>
              </button>
              {isSystem && (
                <>
                  <button id="cc-diagnostic-live" type="button" role="tab" aria-selected={tab === LIVE_TAB} aria-controls="cc-diagnostic-content" onClick={() => selectTab(LIVE_TAB)}>
                    Live-Terminal
                  </button>
                  <button id="cc-diagnostic-terminal" type="button" role="tab" aria-selected={tab === TERMINAL_TAB} aria-controls="cc-diagnostic-content" onClick={() => selectTab(TERMINAL_TAB)}>
                    Terminal
                  </button>
                </>
              )}
            </div>
            <div className="cc-core-diagnostics-exports" role="group" aria-label="Export">
              <button type="button" className="cc-core-diagnostics-action" onClick={() => exportStream(LOG_TAB)} disabled={Boolean(exporting)}>
                {exporting === LOG_TAB ? "Exportiere …" : "Log exportieren"}
              </button>
              <button type="button" className="cc-core-diagnostics-action" onClick={() => exportStream(ERROR_TAB)} disabled={Boolean(exporting)}>
                {exporting === ERROR_TAB ? "Exportiere …" : "Fehler exportieren"}
              </button>
            </div>
          </div>

          <div id="cc-diagnostic-content" role="tabpanel" aria-labelledby={`cc-diagnostic-${tab}`}>
            {isLive ? (
              <LiveLogTerminal token={token} />
            ) : tab === TERMINAL_TAB ? (
              <TerminalShortcut />
            ) : (
              <DiagnosticJournal
                key={`${category}:${moduleId || ""}`}
                journal={snapshot?.journal}
                applications={isSystem ? undefined : applications}
                searchLabel={isSystem ? "Systemprotokoll durchsuchen" : "Anwendungsprotokoll durchsuchen"}
                onlyErrors={tab === ERROR_TAB}
                loading={loading || (!snapshot && !error)}
                onExport={group => exportStream(LOG_TAB, group)}
              />
            )}
          </div>
        </section>
      )}

      {tab === LOG_TAB && showRaw && isSystem ? (
        <section className="cc-core-diagnostics-panel" aria-label="Rohansicht">
          <div className="cc-core-diagnostics-panel__heading"><div><span>Core-Prozessprotokoll</span><h2>bonni-core.log</h2></div><small>Rohansicht mit technischem Kontext aus System und Anwendungen.</small></div>
          <pre className="cc-core-log-viewer" aria-label="Bonni Core Log">
            {logLines.length ? logLines.map((line, index) => (
              <span key={`${index}-${line}`} className={isErrorLogLine(line) ? "is-error" : ""}>{line}{"\n"}</span>
            )) : "Noch keine Logzeilen vorhanden."}
          </pre>
        </section>
      ) : null}

      {tab === ERROR_TAB && showRaw && isSystem ? (
        <section className="cc-core-diagnostics-panel" aria-label="Rohansicht für Fehler">
          <div className="cc-core-diagnostics-panel__heading"><div><span>Core-Prozessprotokoll</span><h2>bonni-core-error.txt</h2></div><small>Fehlerkontext aus System und Anwendungen.</small></div>
          <div className="cc-core-error-list">
            {errorBlocks.length ? errorBlocks.map((block, index) => <ErrorBlock key={`${block.timestamp}-${index}`} block={block} />) : (
              <div className="cc-core-diagnostics-empty">Keine Error-Blöcke vorhanden.</div>
            )}
          </div>
        </section>
      ) : null}

    </section>
  );
}
