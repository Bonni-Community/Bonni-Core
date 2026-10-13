import { useEffect, useRef, useState } from "react";

import {
  downloadCoreDiagnosticsLog,
  fetchCoreDiagnosticsLogs,
  fetchCoreTerminalShellStatus,
} from "../../../system/api/systemDiagnosticsApi.js";
import "./CoreDiagnosticsPage.css";

const ERROR_TAB = "error";
const LOG_TAB = "log";
const TERMINAL_TAB = "terminal";
const VALID_TABS = new Set([LOG_TAB, ERROR_TAB, TERMINAL_TAB]);

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

function websocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/terminals/shell/pty?cols=120&rows=34`;
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
      <div className="cc-core-error-block__line cc-core-error-block__separator">——————————————-</div>
    </article>
  );
}

function TerminalPanel({ token, status }) {
  const socketRef = useRef(null);
  const outputRef = useRef(null);
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [connection, setConnection] = useState("disconnected");
  const [terminalError, setTerminalError] = useState("");

  useEffect(() => {
    if (!outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  useEffect(() => {
    if (!status?.enabled || !token || typeof WebSocket === "undefined") {
      setConnection("disabled");
      return undefined;
    }

    setOutput("");
    setTerminalError("");
    setConnection("connecting");
    const socket = new WebSocket(websocketUrl(), [`bearer.${token}`]);
    socketRef.current = socket;

    socket.onopen = () => {
      setConnection("connected");
      socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 34 }));
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        setOutput((current) => `${current}${String(event.data)}`);
        return;
      }

      if (message.type === "data") {
        setOutput((current) => `${current}${message.data || ""}`);
      } else if (message.type === "error") {
        setTerminalError(message.message || "Terminalfehler.");
        setOutput((current) => `${current}\r\n[terminal] ${message.message || "Terminalfehler."}\r\n`);
      } else if (message.type === "exit") {
        setConnection("exited");
      }
    };
    socket.onerror = () => {
      setConnection("error");
      setTerminalError("Terminal-Verbindung konnte nicht hergestellt werden.");
    };
    socket.onclose = () => {
      setConnection("disconnected");
      socketRef.current = null;
    };

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [status?.enabled, token]);

  function sendInput(value) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: "input", data: value }));
    return true;
  }

  function submitInput(event) {
    event.preventDefault();
    if (!input) return;
    if (sendInput(`${input}\r\n`)) setInput("");
  }

  function sendControlCharacter(character) {
    sendInput(character);
  }

  return (
    <section className="cc-core-terminal">
      <div className="cc-core-terminal__notice">
        <strong>Core-Terminal</strong>
        <span>Nur für Systemadministratoren. Die Shell läuft im aktuellen Bonni-Core-Prozessraum.</span>
        <span className={`cc-core-terminal__state is-${connection}`}>
          {connection === "connected" ? "Verbunden" : connection === "connecting" ? "Verbinde …" : connection === "disabled" ? "Deaktiviert" : "Getrennt"}
        </span>
      </div>
      {terminalError ? <div className="cc-core-diagnostics-alert is-error">{terminalError}</div> : null}
      <pre ref={outputRef} className="cc-core-terminal__output" aria-label="Core-Terminal-Ausgabe">{output || "Terminal wird geöffnet …"}</pre>
      <form className="cc-core-terminal__input-row" onSubmit={submitInput}>
        <span aria-hidden="true">$</span>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setInput("");
          }}
          placeholder={connection === "connected" ? "Befehl eingeben …" : "Warte auf Terminal …"}
          disabled={connection !== "connected"}
          autoComplete="off"
          spellCheck="false"
          aria-label="Terminal-Befehl"
        />
        <button type="submit" disabled={connection !== "connected" || !input}>Senden</button>
      </form>
      <div className="cc-core-terminal__actions">
        <button type="button" onClick={() => sendControlCharacter("\u0003")} disabled={connection !== "connected"}>Strg+C</button>
        <button type="button" onClick={() => sendInput("\u0004")} disabled={connection !== "connected"}>EOF</button>
      </div>
      <small className="cc-core-terminal__details">
        {status?.shell || "Shell"} · {status?.cwd || "Arbeitsverzeichnis wird geladen"} · {status?.mode || "Modus wird geladen"}
      </small>
    </section>
  );
}

export default function CoreDiagnosticsPage({ token }) {
  const [tab, setTab] = useState(initialTab);
  const [snapshot, setSnapshot] = useState(null);
  const [terminalStatus, setTerminalStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState("");

  async function loadSnapshot({ quiet = false } = {}) {
    if (!token) return;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      const payload = await fetchCoreDiagnosticsLogs(token, 500);
      setSnapshot(payload);
      setError("");
    } catch (loadError) {
      setError(loadError?.message || "Core-Diagnose konnte nicht geladen werden.");
    } finally {
      if (quiet) setRefreshing(false);
      else setLoading(false);
    }
  }

  useEffect(() => {
    loadSnapshot();
    const interval = window.setInterval(() => loadSnapshot({ quiet: true }), 5_000);
    return () => window.clearInterval(interval);
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    fetchCoreTerminalShellStatus(token)
      .then((payload) => {
        if (!cancelled) setTerminalStatus(payload);
      })
      .catch((loadError) => {
        if (!cancelled) setTerminalStatus({ enabled: false, error: loadError?.message || "Terminalstatus nicht verfügbar." });
      });
    return () => { cancelled = true; };
  }, [token]);

  function selectTab(nextTab) {
    if (!VALID_TABS.has(nextTab)) return;
    setTab(nextTab);
    const suffix = nextTab === LOG_TAB ? "" : `?tab=${nextTab}`;
    window.history.replaceState(null, "", `/control-center/diagnostics${suffix}`);
  }

  async function exportStream(stream) {
    setExporting(stream);
    try {
      const content = await downloadCoreDiagnosticsLog(token, stream);
      const blob = new Blob([content || ""], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = stream === ERROR_TAB ? "bonni-core-error.txt" : "bonni-core.log";
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

  return (
    <section className="cc-menu-layout-page cc-core-diagnostics-page">
      <header className="cc-user-page__header cc-menu-page-header cc-core-diagnostics-header">
        <div>
          <p className="cc-core-diagnostics-eyebrow">Bonni Core</p>
          <h1>Core-Diagnose</h1>
          <p>Eigene Logs, getrennte Error-Liste und Terminal – unabhängig von Bonni Windows.</p>
        </div>
        <button type="button" onClick={() => loadSnapshot()} disabled={loading}>
          {loading ? "Lade …" : "Jetzt aktualisieren"}
        </button>
      </header>

      {error ? <div className="cc-core-diagnostics-alert is-error" role="alert">{error}</div> : null}

      <section className="cc-core-diagnostics-meta" aria-label="Core-Log-Informationen">
        <div><span>Ablage</span><strong>{snapshot?.root || "RUN_SYSTEM/LOGS/CORE"}</strong></div>
        <div><span>Log-Datei</span><strong>{snapshot?.files?.log || "bonni-core.log"}</strong></div>
        <div><span>Error-Datei</span><strong>{snapshot?.files?.errors || "bonni-core-error.txt"}</strong></div>
        <div><span>Größe</span><strong>{formatBytes(snapshot?.sizes?.logBytes)} / {formatBytes(snapshot?.sizes?.errorBytes)}</strong></div>
      </section>

      <div className="cc-core-diagnostics-tabs" role="tablist" aria-label="Core-Diagnose">
        <button type="button" role="tab" aria-selected={tab === LOG_TAB} className={tab === LOG_TAB ? "is-active" : ""} onClick={() => selectTab(LOG_TAB)}>
          Log <span>{snapshot?.counts?.logLines || 0}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === ERROR_TAB} className={tab === ERROR_TAB ? "is-active" : ""} onClick={() => selectTab(ERROR_TAB)}>
          Error <span>{snapshot?.counts?.errors || 0}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === TERMINAL_TAB} className={tab === TERMINAL_TAB ? "is-active" : ""} onClick={() => selectTab(TERMINAL_TAB)}>
          Terminal
        </button>
        <span className="cc-core-diagnostics-tabs__spacer" />
        <button type="button" className="cc-core-diagnostics-export" onClick={() => exportStream(LOG_TAB)} disabled={Boolean(exporting)}>
          {exporting === LOG_TAB ? "Exportiere …" : "Log exportieren"}
        </button>
        <button type="button" className="cc-core-diagnostics-export" onClick={() => exportStream(ERROR_TAB)} disabled={Boolean(exporting)}>
          {exporting === ERROR_TAB ? "Exportiere …" : "Error exportieren"}
        </button>
        {refreshing ? <small>Aktualisiere …</small> : null}
      </div>

      {tab === LOG_TAB ? (
        <section className="cc-core-diagnostics-panel" role="tabpanel">
          <div className="cc-core-diagnostics-panel__heading"><div><span>Vollständiges Core-Protokoll</span><h2>bonni-core.log</h2></div><small>Nur Error/CRITICAL wird rot markiert.</small></div>
          <pre className="cc-core-log-viewer" aria-label="Bonni Core Log">
            {logLines.length ? logLines.map((line, index) => (
              <span key={`${index}-${line}`} className={isErrorLogLine(line) ? "is-error" : ""}>{line}{"\n"}</span>
            )) : "Noch keine Logzeilen vorhanden."}
          </pre>
        </section>
      ) : null}

      {tab === ERROR_TAB ? (
        <section className="cc-core-diagnostics-panel" role="tabpanel">
          <div className="cc-core-diagnostics-panel__heading"><div><span>Separate Datei</span><h2>bonni-core-error.txt</h2></div><small>Die fünf Logzeilen davor bleiben neutral.</small></div>
          <div className="cc-core-error-list">
            {errorBlocks.length ? errorBlocks.map((block, index) => <ErrorBlock key={`${block.timestamp}-${index}`} block={block} />) : (
              <div className="cc-core-diagnostics-empty">Keine Error-Blöcke vorhanden.</div>
            )}
          </div>
        </section>
      ) : null}

      {tab === TERMINAL_TAB ? (
        terminalStatus?.error ? <div className="cc-core-diagnostics-alert is-error">{terminalStatus.error}</div> : <TerminalPanel token={token} status={terminalStatus} />
      ) : null}
    </section>
  );
}
