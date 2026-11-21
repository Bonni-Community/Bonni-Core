import { useEffect, useRef, useState } from "react";
import { executeTerminalCommand, parseTerminalBatch } from "./terminalCommands.js";
import { clearPendingProductWrites } from "./terminalProducts.js";
import TerminalInteraction from "./TerminalInteraction.jsx";
import { readTerminalSession, savedTerminalToken } from "./terminalSession.js";
import "./BonniTerminalWindow.css";

function shellPrompt(directory) {
  return `bonni@core:/${directory}$`;
}

export default function BonniTerminalWindow() {
  const [session, setSession] = useState(readTerminalSession);
  const token = session?.token || "";
  const [input, setInput] = useState("");
  const [output, setOutput] = useState([]);
  const [running, setRunning] = useState(false);
  const [panel, setPanel] = useState(null);
  const [directory, setDirectory] = useState("");
  const inputRef = useRef(null);
  const consoleRef = useRef(null);
  const runRef = useRef(null);
  const history = useRef({ entries: [], cursor: 0, draft: "" });
  const sequence = useRef(0);
  const inputRows = Math.min(5, input.split("\n").length);

  function endSession() {
    runRef.current?.abort();
    clearPendingProductWrites();
    setSession(null);
    setPanel(null);
    setDirectory("");
    setInput("");
    setOutput([]);
    history.current = { entries: [], cursor: 0, draft: "" };
  }

  useEffect(() => {
    function handleStorage(event) {
      if ((event.key === "token" || event.key === null) && savedTerminalToken() !== token) endSession();
    }
    function stopOnClose() {
      runRef.current?.abort();
    }
    window.addEventListener("storage", handleStorage);
    window.addEventListener("pagehide", stopOnClose);
    return () => {
      stopOnClose();
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("pagehide", stopOnClose);
    };
  }, [token]);

  useEffect(() => {
    const viewport = consoleRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [output, inputRows]);

  function print(tone, message, commandDirectory) {
    const id = ++sequence.current;
    const rows = Array.isArray(message) ? message : null;
    const text = rows ? rows.map(row => row.text).join("\n") : String(message);
    setOutput(previous => [...previous.slice(-119), {
      id, tone, message: text.slice(0, 16_000), lineTones: rows?.map(row => row.tone), commandDirectory,
    }]);
  }

  function requestInteraction(prompt, signal, canceled) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      function finish(value) {
        signal.removeEventListener("abort", abort);
        setPanel(null);
        if (value !== undefined) resolve(value);
        else reject(new Error(canceled));
      }
      function abort() { finish(); }
      signal.addEventListener("abort", abort, { once: true });
      setPanel({ ...prompt, finish });
    });
  }

  function closePanel() {
    if (panel.finish) panel.finish();
    else setPanel(null);
  }

  async function run() {
    if (runRef.current || !token || panel) return;
    if (savedTerminalToken() !== token) {
      endSession();
      return;
    }
    let commands;
    try {
      commands = parseTerminalBatch(input);
    } catch (error) {
      print("error", error.message);
      return;
    }
    if (!commands.length) return;

    const lines = new Map(commands.map(command => [command.line, command.historyText || command.text]));
    const entries = [...history.current.entries, ...lines.values()].slice(-30);
    history.current = { entries, cursor: entries.length, draft: "" };
    setInput("");
    setRunning(true);
    const controller = new AbortController();
    runRef.current = controller;
    let currentDirectory = directory;

    try {
      for (const [index, command] of commands.entries()) {
        if (controller.signal.aborted) return;
        if (savedTerminalToken() !== token) {
          endSession();
          return;
        }
        if (command.kind === "clear") {
          setOutput([]);
          continue;
        }
        print("command", command.text, currentDirectory);
        try {
          const result = await executeTerminalCommand(command, {
            token, signal: controller.signal, actorAccountId: session.actorAccountId, directory: currentDirectory,
            requestPassword: (loginName, signal) => requestInteraction({ kind: "password", loginName }, signal, "Benutzeranlage abgebrochen."),
            confirmRemoval: (key, signal) => requestInteraction({ kind: "confirm-remove", key }, signal, "Deinstallation abgebrochen."),
            openTextEditor: (path, file, signal) => requestInteraction({ kind: "nano", path, file }, signal, "Editor geschlossen."),
          });
          if (controller.signal.aborted) return;
          if (result.directory !== undefined) {
            currentDirectory = result.directory;
            setDirectory(currentDirectory);
          }
          if (result.panel) setPanel(result.panel);
          print(result.tone ?? "text", result.rows ?? result.message ?? result);
        } catch (error) {
          if (controller.signal.aborted) return;
          const remaining = commands.length - index - 1;
          const stopped = remaining > 0 ? `\nBlock in Zeile ${command.line} angehalten. Weitere Befehle offen: ${remaining}.` : "";
          const message = error.status === 401
            ? "Die Core-Sitzung ist abgelaufen. Melde dich erneut im Control Center an."
            : error.message || "Der Befehl ist fehlgeschlagen.";
          print("error", `${message}${stopped}`);
          return;
        }
      }
    } finally {
      runRef.current = null;
      setRunning(false);
      if (!controller.signal.aborted) inputRef.current?.focus();
    }
  }

  function onInputKeyDown(event) {
    if (event.nativeEvent.isComposing || running) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void run();
      return;
    }
    if (!["ArrowUp", "ArrowDown"].includes(event.key) || input.includes("\n") || event.shiftKey) return;
    const commandHistory = history.current;
    if (!commandHistory.entries.length) return;
    event.preventDefault();
    const end = commandHistory.entries.length;
    if (commandHistory.cursor === end) commandHistory.draft = input;
    const direction = event.key === "ArrowUp" ? -1 : 1;
    commandHistory.cursor = Math.max(0, Math.min(end, commandHistory.cursor + direction));
    setInput(commandHistory.entries[commandHistory.cursor] ?? commandHistory.draft);
  }

  return (
    <main className="bonni-terminal bonni-terminal--shell">
      <header className="bonni-terminal__header">
        <span className="bonni-terminal__glyph" aria-hidden="true">&gt;_</span>
        <div className="bonni-terminal__title">
          <h1>Terminal</h1>
        </div>
        <span className="bonni-terminal__status" role="status" data-busy={running || undefined}>
          {running ? "Befehl läuft …" : token ? "" : "Anmeldung erforderlich"}
        </span>
      </header>
      <div className="bonni-terminal__console" ref={consoleRef}>
        <section role="log" aria-label="Befehlsausgabe" tabIndex={0}>
          {!output.length && (
            <div className="bonni-terminal__shell-hint">
              {token
                ? <><code>help</code> zeigt die verfügbaren Befehle.</>
                : <>Melde dich als Systemadministrator an und öffne das Terminal im Control Center.</>}
            </div>
          )}
          {output.map(({ id, tone, message, lineTones, commandDirectory }) => (
            <pre key={id} className="bonni-terminal__line" data-terminal-tone={tone}>
              {tone === "command" && <span className="bonni-terminal__prompt" aria-hidden="true">{shellPrompt(commandDirectory)} </span>}
              {lineTones ? message.split("\n").map((line, index) => (
                <span key={index} data-terminal-tone={lineTones[index]}>{index > 0 && "\n"}{line}</span>
              )) : message}
            </pre>
          ))}
        </section>
        <div className="bonni-terminal__entry" hidden={!token}>
          <span className="bonni-terminal__prompt" title={`/${directory}`} aria-label={`Aktueller Ordner /${directory}`}>{shellPrompt(directory)}</span>
          <div className="bonni-terminal__input">
            <textarea
              aria-label="Terminal-Befehle"
              aria-keyshortcuts="Enter Shift+Enter ArrowUp ArrowDown"
              autoFocus={Boolean(token)}
              ref={inputRef}
              value={input}
              onChange={event => setInput(event.target.value)}
              onKeyDown={onInputKeyDown}
              disabled={!token}
              readOnly={running}
              rows={inputRows}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              enterKeyHint="go"
              placeholder=" "
            />
          </div>
        </div>
      </div>
      {panel && token && <TerminalInteraction
        panel={panel}
        token={token}
        actorAccountId={session.actorAccountId}
        onClose={closePanel}
        onDone={message => { print("text", message); setPanel(null); }}
      />}
    </main>
  );
}
