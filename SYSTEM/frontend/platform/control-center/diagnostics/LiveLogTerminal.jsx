import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fetchCoreLiveLog } from "../../../system/api/systemDiagnosticsApi.js";
import { fetchModulePackages, modulePackageDisplayName, modulePackageId } from "../../../system/feature-modules/featureModuleApi.js";
import TerminalLegend from "../terminal/TerminalLegend.jsx";
import { parseLiveLogLine } from "../terminal/terminalLogTone.js";
import { filterLiveLogEntries, liveLogApplicationOptions } from "./liveLogFilter.js";
import { liveLogDetails, liveLogSummary } from "./liveLogFailure.js";

const defaultFilters = { query: "", hiddenTones: new Set(), application: "all" };

function logSelection(log) {
  const selection = log?.ownerDocument.getSelection();
  return selection?.rangeCount && !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(log)
    ? selection : null;
}

function LogDetails({ entry, entries, applicationName }) {
  const fields = liveLogDetails(entry, entries, applicationName);
  if (!fields.length) return null;
  return (
    <dl className="cc-live-terminal__details">
      {fields.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export default function LiveLogTerminal({ token, onAccessDenied }) {
  const [logLines, setLogLines] = useState([]);
  const [heldLines, setHeldLines] = useState(null);
  const [expandedRow, setExpandedRow] = useState(null);
  const [filters, setFilters] = useState(defaultFilters);
  const [moduleNames, setModuleNames] = useState(() => new Map());
  const [connectionFailed, setConnectionFailed] = useState(false);
  const output = useRef(null);
  const displayedLines = heldLines ?? logLines;
  const entries = useMemo(() => displayedLines.map(parseLiveLogLine), [displayedLines]);
  const visibleEntries = useMemo(() => filterLiveLogEntries(entries, filters, moduleNames), [entries, filters, moduleNames]);
  const applications = useMemo(() => [
    ["all", "Anwendung"],
    ...liveLogApplicationOptions(entries, moduleNames, filters.application),
    ["none", "Anwendungen ausblenden"],
  ], [entries, moduleNames, filters.application]);
  const isFiltered = Boolean(filters.query.trim() || filters.hiddenTones.size || filters.application !== "all");

  useEffect(() => {
    setHeldLines(null);
    setExpandedRow(null);
    setLogLines([]);
    setFilters(defaultFilters);
    setModuleNames(new Map());
    setConnectionFailed(false);
    if (!token) return undefined;

    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(6_000)]);
    void fetchModulePackages(token, { signal }).then(packages => {
      if (!signal.aborted) setModuleNames(new Map(packages.map(item => [modulePackageId(item), String(modulePackageDisplayName(item))])));
    }).catch(() => { /* Raw log text remains searchable if package names are unavailable. */ });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    let pending;
    let disposed = false;

    async function poll() {
      if (pending) return;
      pending = new AbortController();
      try {
        const signal = AbortSignal.any([pending.signal, AbortSignal.timeout(6_000)]);
        const response = await fetchCoreLiveLog(token, { signal });
        if (disposed) return;
        if (!Array.isArray(response?.logLines)) {
          setConnectionFailed(true);
          return;
        }
        setLogLines(previous => previous.length === response.logLines.length
          && previous.every((line, index) => line === response.logLines[index]) ? previous : response.logLines);
        setConnectionFailed(false);
      } catch (error) {
        if (disposed) return;
        if (error?.status === 401 || error?.status === 403) {
          setLogLines([]);
          setHeldLines(null);
          setExpandedRow(null);
          onAccessDenied?.();
        }
        setConnectionFailed(true);
      } finally {
        pending = undefined;
      }
    }

    poll();
    const timer = window.setInterval(poll, 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      pending?.abort();
    };
  }, [token, onAccessDenied]);

  useLayoutEffect(() => {
    if (heldLines === null && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [visibleEntries, heldLines]);

  useLayoutEffect(() => {
    if (expandedRow !== null) {
      output.current?.querySelector("details[open] > dl")?.scrollIntoView({ block: "nearest" });
    }
  }, [expandedRow]);

  useEffect(() => {
    if (heldLines !== null) return undefined;
    function holdSelection() {
      if (logSelection(output.current)) setHeldLines(logLines);
    }
    document.addEventListener("selectionchange", holdSelection);
    return () => document.removeEventListener("selectionchange", holdSelection);
  }, [heldLines, logLines]);

  function holdReadingPosition(event) {
    const log = event.currentTarget;
    if (heldLines === null && log.scrollHeight - log.clientHeight - log.scrollTop > 24) {
      setHeldLines(logLines);
    }
  }

  function selectLogText(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") return;
    const log = event.currentTarget;
    const selection = log.ownerDocument.getSelection();
    if (!selection) return;
    event.preventDefault();
    selection.selectAllChildren(log);
  }

  function updateFilter(event) {
    const { name, value } = event.target;
    setFilters(previous => ({ ...previous, [name]: value }));
    followLatest();
  }

  function toggleTone(tone) {
    setFilters(previous => {
      const hiddenTones = new Set(previous.hiddenTones);
      if (!hiddenTones.delete(tone)) hiddenTones.add(tone);
      return { ...previous, hiddenTones };
    });
    followLatest();
  }

  function renderLegendItem(tone, label) {
    if (tone === "application") {
      const selectedLabel = applications.find(([id]) => id === filters.application)?.[1] ?? label;
      return (
        <label className="bonni-terminal-legend__application" data-hidden={filters.application === "none"}>
          <span aria-hidden="true">{selectedLabel}</span>
          <select
            name="application"
            aria-label="Anwendung auswählen"
            title="Anwendung auswählen"
            value={filters.application}
            onChange={updateFilter}
          >
            {applications.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      );
    }
    const shown = !filters.hiddenTones.has(tone);
    return (
      <button type="button" aria-pressed={shown} title={`${label} ${shown ? "ausblenden" : "einblenden"}`} onClick={() => toggleTone(tone)}>
        {label}
      </button>
    );
  }

  function followLatest() {
    logSelection(output.current)?.removeAllRanges();
    setExpandedRow(null);
    setHeldLines(null);
  }

  function toggleDetails(event, key, entry, applicationName) {
    event.preventDefault();
    if (event.detail > 0 && logSelection(event.currentTarget)) return;
    const open = expandedRow !== key;
    const summary = event.currentTarget;
    if (open && summary.scrollWidth <= summary.clientWidth && !liveLogDetails(entry, entries, applicationName).length) return;
    setExpandedRow(open ? key : null);
    if (open && heldLines === null) setHeldLines(logLines);
  }

  return (
    <section className="cc-live-terminal" aria-label="Live-Terminal für Hintergrundmeldungen">
      <div className="cc-live-terminal__search" role="search" aria-label="Live-Protokoll durchsuchen">
        <label>
          Meldungen durchsuchen
          <input type="search" name="query" value={filters.query} placeholder="Meldung oder App" onChange={updateFilter} />
        </label>
        {connectionFailed && <small role="status">Verbindung wird erneut geprüft</small>}
        {heldLines && <button type="button" onClick={followLatest}>Zu neuesten Meldungen</button>}
      </div>
      <TerminalLegend renderItem={renderLegendItem} />
      <div
        className="cc-core-log-viewer cc-live-terminal__output"
        ref={output}
        tabIndex={0}
        onScroll={holdReadingPosition}
        onKeyDown={selectLogText}
        role="group"
        aria-label="Laufende Core- und App-Meldungen"
      >
        {visibleEntries.length ? visibleEntries.map((entry, index) => {
          const key = `${index}-${entry.line}`;
          const expanded = key === expandedRow;
          const applicationName = moduleNames.get(entry.moduleId);
          return (
            <details className="cc-live-terminal__entry" key={key} open={expanded}>
              <summary data-terminal-tone={entry.tone} onClick={event => toggleDetails(event, key, entry, applicationName)}>
                {liveLogSummary(entry)}
              </summary>
              {expanded && <LogDetails entry={entry} entries={entries} applicationName={applicationName} />}
            </details>
          );
        }) : isFiltered ? "Keine passenden Meldungen." : "Warte auf Hintergrundmeldungen …"}
      </div>
    </section>
  );
}
