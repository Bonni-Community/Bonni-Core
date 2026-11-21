import { useEffect, useId, useRef, useState } from "react";
import { searchDiagnosticApplications } from "../../../system/diagnostics/journalModel.js";

export default function DiagnosticApplicationPicker({ applications, selectedId, onSelect }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef(null);
  const trigger = useRef(null);
  const search = useRef(null);
  const panelId = useId();
  const selected = applications.find(application => application.id === selectedId);
  const matches = open ? searchDiagnosticApplications(applications, query) : [];

  function dismiss() {
    setOpen(false);
    setQuery("");
  }

  useEffect(() => {
    if (!open) return undefined;
    search.current?.focus();

    function dismissOutside(event) {
      if (!root.current?.contains(event.target)) dismiss();
    }

    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [open]);

  function choose(id) {
    onSelect(id);
    dismiss();
    trigger.current?.focus();
  }

  return (
    <div className="cc-diagnostic-picker" ref={root} onKeyDown={event => {
      if (!open || event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
      trigger.current?.focus();
    }}>
      <button
        type="button"
        className="cc-diagnostic-picker__trigger"
        ref={trigger}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="Anwendung auswählen oder suchen"
        onClick={() => open ? dismiss() : setOpen(true)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="m15 15 4 4" />
        </svg>
        <span>{selected?.name || selectedId || "Alles"}</span>
        <svg aria-hidden="true" className="cc-diagnostic-picker__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="cc-diagnostic-picker__panel" id={panelId}>
          <input
            type="search"
            aria-label="Anwendung suchen"
            placeholder="Anwendung suchen"
            autoComplete="off"
            ref={search}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && matches.length === 1) {
                event.preventDefault();
                choose(matches[0].id);
              }
            }}
          />
          <ul role="list" aria-label="Verfügbare Anwendungen">
            {[{ id: "", name: "Alles" }, ...matches].map(item => (
              <li key={item.id}>
                <button type="button" aria-pressed={selectedId === item.id} title={item.id || undefined} onClick={() => choose(item.id)}>
                  <span>{item.name}</span>
                  {selectedId === item.id && <span className="cc-diagnostic-picker__check" aria-hidden="true">✓</span>}
                </button>
              </li>
            ))}
          </ul>
          {query.trim() && !matches.length && <p role="status">Keine passende Anwendung gefunden.</p>}
        </div>
      )}
    </div>
  );
}
