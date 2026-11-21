import { useEffect, useRef, useState } from "react";
import SystemErasurePanel from "../../../core/modules/security/identity/components/SystemErasurePanel.jsx";
import { changeBackupTextFile } from "../../../system/api/systemBackupApi.js";
import { executeProductCommand, parseProductImport } from "./terminalProducts.js";

function ProductImport({ token, onDone }) {
  const [items, setItems] = useState([]);
  const [done, setDone] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(null);
  const fileSequence = useRef(0);
  useEffect(() => () => {
    ++fileSequence.current;
    active.current?.abort();
  }, []);

  async function readFile(file) {
    const sequence = ++fileSequence.current;
    setError("");
    setItems([]);
    setDone(0);
    if (!file) return;
    try {
      if (file.size > 16_384) throw new Error("Die Textdatei darf höchstens 16 KB groß sein.");
      const rows = parseProductImport(await file.text());
      if (sequence === fileSequence.current) setItems(rows);
    } catch (failure) {
      if (sequence === fileSequence.current) setError(failure.message);
    }
  }

  async function createProducts() {
    if (!items.length || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    let index = done;
    try {
      while (index < items.length) {
        controller.signal.throwIfAborted();
        const row = items[index];
        await executeProductCommand({ kind: "product-create", body: row.body }, { token, signal: controller.signal });
        if (controller.signal.aborted) return;
        setDone(++index);
      }
      onDone(`${items.length} Produkte aus der Textdatei angelegt.`);
    } catch (failure) {
      if (!controller.signal.aborted) setError(`Zeile ${items[index]?.line} · ${failure.message}`);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      active.current = null;
    }
  }

  return (
    <>
      <h2 id="bonni-terminal-dialog-title">Produkte aus Textdatei anlegen</h2>
      <p>Eine Zeile pro Produkt im Format <code>SKU | Name | Preis in Euro</code>.</p>
      <p><code>SPEZI-033 | Spezi 0,33 l | 1,50</code></p>
      <label className="bonni-terminal__file">Textdatei (UTF-8)
        <input type="file" accept=".txt,text/plain" disabled={busy} onChange={event => void readFile(event.target.files?.[0])} />
      </label>
      {items.length > 0 && (
        <ul className="bonni-terminal__import-preview">
          {items.map(({ line, body }, index) => (
            <li key={line}>
              {body.sku} · {body.name} · {body.price.toLocaleString("de-DE", { style: "currency", currency: "EUR" })}
              {index < done ? " · Angelegt" : ""}
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy || done >= items.length} onClick={() => void createProducts()}>
        {busy ? `Import läuft · ${done}/${items.length}` : `${items.length - done} Produkte anlegen`}
      </button>
    </>
  );
}

function TerminalDialog({ onClose, onKeyDown, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="bonni-terminal__dialog"
      aria-labelledby="bonni-terminal-dialog-title"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onKeyDown={onKeyDown}
    >
      {children}
    </dialog>
  );
}

function TerminalTextEditor({ panel, token }) {
  const { file, path, finish } = panel;
  const [text, setText] = useState(() => file.text.replaceAll("\r\n", "\n"));
  const [saved, setSaved] = useState(() => ({ text, revision: file.revision }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [discard, setDiscard] = useState(false);
  const active = useRef(null);
  const didSave = useRef(false);
  const dirty = text !== saved.text;
  const windowsNewlines = file.text.includes("\r\n") && !/(?<!\r)\n/u.test(file.text);

  useEffect(() => () => active.current?.abort(), []);

  async function save() {
    if (active.current) return;
    setDiscard(false);
    setError("");
    setMessage("");
    const value = windowsNewlines ? text.replaceAll("\n", "\r\n") : text;
    if (new TextEncoder().encode(value).length > file.maxBytes) {
      setError("Die Textdatei darf höchstens 16 KB groß sein.");
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      const result = await changeBackupTextFile(token, path, "PUT", {
        signal: controller.signal, text: value, revision: saved.revision,
      });
      if (controller.signal.aborted) return;
      if (result?.ok !== true || result.path !== path || !/^[a-f0-9]{64}$/u.test(result.revision)) {
        throw new Error("Der Core hat das Speichern nicht bestätigt.");
      }
      setSaved({ text, revision: result.revision });
      didSave.current = true;
      setMessage("Gespeichert.");
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message);
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function requestClose() {
    if (active.current) return;
    if (dirty) setDiscard(true);
    else finish(didSave.current);
  }

  function onKeyDown(event) {
    if (event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (!["o", "s", "x"].includes(key)) return;
    event.preventDefault();
    if (key === "x") requestClose();
    else void save();
  }

  return (
    <TerminalDialog onClose={requestClose} onKeyDown={onKeyDown}>
      <h2 id="bonni-terminal-dialog-title">Nano</h2>
      <p className="bonni-terminal__editor-path"><code>/{path}</code> · {saved.revision === null ? "Neue Datei" : "Textdatei"}</p>
      <textarea
        aria-label="Textinhalt"
        className="bonni-terminal__editor-text"
        autoFocus
        spellCheck={false}
        value={text}
        readOnly={busy}
        onChange={event => {
          setText(event.target.value);
          setDiscard(false);
          setMessage("");
        }}
      />
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {discard && <p role="status">Ungespeicherte Änderungen verwerfen?</p>}
      <div className="bonni-terminal__editor-actions">
        <button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Speichert …" : "Speichern"}</button>
        {discard ? (
          <>
            <button type="button" onClick={() => setDiscard(false)}>Weiter bearbeiten</button>
            <button type="button" onClick={() => finish(didSave.current)}>Änderungen verwerfen</button>
          </>
        ) : <button type="button" disabled={busy} onClick={requestClose}>Schließen</button>}
        <small>Strg+O Speichern · Strg+X Schließen</small>
      </div>
    </TerminalDialog>
  );
}

export default function TerminalInteraction({ panel, token, actorAccountId, onClose, onDone }) {
  if (panel.kind === "nano") return <TerminalTextEditor panel={panel} token={token} />;
  return (
    <TerminalDialog onClose={onClose}>
      {panel.kind === "password" ? (
        <form onSubmit={event => {
          event.preventDefault();
          const field = event.currentTarget.elements.namedItem("newPassword");
          const value = field.value;
          field.value = "";
          panel.finish(value);
        }}>
          <h2 id="bonni-terminal-dialog-title">Passwort für {panel.loginName}</h2>
          <label>Neues Passwort
            <input name="newPassword" type="password" autoComplete="new-password" autoFocus required minLength={6} maxLength={128} />
          </label>
          <button type="submit">Benutzer anlegen</button>
        </form>
      ) : panel.kind === "confirm-remove" ? (
        <>
          <h2 id="bonni-terminal-dialog-title">Paket deinstallieren?</h2>
          <p>Bonni deinstalliert <code>{panel.key}</code>. Die gespeicherten App-Daten bleiben erhalten.</p>
          <button type="button" onClick={() => panel.finish(true)}>Deinstallieren</button>
        </>
      ) : panel.kind === "import" ? (
        <ProductImport token={token} onDone={onDone} />
      ) : (
        <>
          <h2 id="bonni-terminal-dialog-title">Löschantrag</h2>
          <SystemErasurePanel
            token={token}
            actorAccountId={actorAccountId}
            targetAccountId={panel.targetAccountId}
            targetLabel={panel.targetLabel}
          />
        </>
      )}
      <button type="button" className="bonni-terminal__dialog-close" onClick={onClose}>
        {panel.finish ? "Abbrechen" : "Schließen"}
      </button>
    </TerminalDialog>
  );
}
