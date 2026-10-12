import { useEffect, useMemo, useRef, useState } from "react";

import {
  fetchEmergencyBackendStatus,
  updateEmergencyBackendSettings,
} from "../../../system/api/emergencyBackendApi.js";
import {
  getControlCenterDatabaseSettings,
  getControlCenterSystemSettings,
  pingControlCenterDatabase,
  replayControlCenterJsonEmergency,
  saveControlCenterDatabaseSettings,
  saveControlCenterDatabaseRouting,
  saveControlCenterSystemSettings,
  runControlCenterDatabaseFullSync,
} from "../../../system/api/systemSettingsApi.js";
import {
  ACTIVE_API_ORIGIN_URL,
  EMERGENCY_API_ORIGIN_URL,
  normalizeOrigin,
} from "../../../system/api/apiConfig.js";
import {
  getRuntimeEndpointState,
  selectRuntimeEndpoint,
} from "../../../system/api/runtimeEndpointRouter.js";
import ServerBackendConfigTab from "./tab/BackendConfig.jsx";
import ServerDatabaseConfigTab from "./tab/DatabaseConfig.jsx";
import ServerJsonBackupTab from "./tab/JsonBackup.jsx";
import ServerSwitchTab from "./tab/Switch.jsx";
import { formatBonniCoreVersion } from "../update/localUpdatePresentation.js";
import "./ServerPage.css";

function formatDelay(ms) {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return "sofort";
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} Sekunden`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} Min. ${rest} Sek.` : `${minutes} Minuten`;
}

function makeOrigin({ bind, port, fallback }) {
  const fallbackOrigin = normalizeOrigin(fallback || "");
  const host = String(bind || "").trim() || "127.0.0.1";
  const selectedPort = Number(port || 0);

  if (!selectedPort) {
    return fallbackOrigin;
  }

  return normalizeOrigin(`http://${host}:${selectedPort}`);
}

function parseOrigin(origin) {
  try {
    const url = new URL(normalizeOrigin(origin));
    return {
      origin: normalizeOrigin(origin),
      host: url.hostname || "—",
      port: url.port || (url.protocol === "https:" ? "443" : "80"),
      protocol: url.protocol.replace(":", ""),
    };
  } catch {
    return {
      origin: normalizeOrigin(origin || ""),
      host: "—",
      port: "—",
      protocol: "http",
    };
  }
}

const initialJsonForm = {
  enabled: true,
  backupEnabled: true,
  backupPath: "",
};

function normalizeJsonForm(settings) {
  return {
    ...initialJsonForm,
    ...(settings?.json || {}),
  };
}

const initialDatabaseForm = {
  normal: {
    host: "localhost",
    port: "5432",
    database: "bonni",
    user: "bonni_user",
    password: "",
    passwordConfigured: false,
    schema: "public",
    sslMode: "prefer",
    autoConnect: true,
  },
  redundant: {
    host: "localhost",
    port: "5433",
    database: "bonni_redundant",
    user: "bonni_user",
    password: "",
    passwordConfigured: false,
    schema: "public",
    sslMode: "prefer",
    autoConnect: false,
  },
};

const initialDatabaseRouting = {
  mode: "normal",
  primary: "normal",
  writeTargets: { normal: true, redundant: false },
  degraded: false,
  lastFailure: null,
  lastFullSync: null,
  maintenance: null,
  jsonEmergency: {
    enabled: true,
    active: false,
    pendingCount: 0,
    encrypted: true,
    lastQueuedAt: null,
    lastDatabaseRecoveredAt: null,
    lastReplayAt: null,
    lastReplayTarget: null,
    lastError: null,
  },
};

function databaseTargetForm(target, fallback) {
  if (!target) return fallback;
  return {
    ...fallback,
    host: target.host || fallback.host,
    port: String(target.port || fallback.port),
    database: target.database || fallback.database,
    user: target.user || fallback.user,
    password: "",
    passwordConfigured: Boolean(target.passwordConfigured),
    schema: target.schema || "public",
    sslMode: target.sslMode || "prefer",
    autoConnect: Boolean(target.autoConnect),
  };
}

function untestedDatabaseHealth() {
  return {
    state: "unknown",
    available: null,
    checkedAt: null,
    latencyMs: null,
    message: "Noch nicht geprüft.",
    code: null,
  };
}

function databaseHealthLabel(health) {
  if (health?.state === "checking") return "Verbindung wird geprüft";
  if (health?.available === true) return "verfügbar";
  if (health?.available === false) return "nicht verfügbar";
  return "noch nicht geprüft";
}

function databaseCardState(selected, health) {
  if (health?.state === "checking") {
    return { label: "Prüft", variant: "working" };
  }
  if (health?.available === false) {
    return { label: "Nicht verfügbar", variant: "idle" };
  }
  if (health?.available === true) {
    const latency = health.latencyMs == null ? "" : ` · ${health.latencyMs} ms`;
    return selected
      ? { label: `Aktiv${latency}`, variant: "active" }
      : { label: "Verfügbar", variant: "ready" };
  }
  return selected
    ? { label: "Aktiv", variant: "active" }
    : { label: "Nicht geprüft", variant: "idle" };
}

function untestedBackendHealth() {
  return {
    state: "unknown",
    reachable: null,
    ready: null,
    live: null,
    checkedAt: null,
    latencyMs: null,
    message: "Noch nicht geprüft.",
  };
}

function backendHealthLabel(health) {
  if (health?.state === "checking") return "Status wird geprüft";
  if (health?.processAlive && health?.reachable === false) return "Prozess läuft, Health-Prüfung offen";
  if (health?.reachable === false) return "nicht erreichbar";
  if (health?.ready === true) return "bereit";
  if (health?.reachable === true) return "erreichbar, aber nicht bereit";
  return "noch nicht geprüft";
}

function backendCardState(selected, health, fallback = {}) {
  if (fallback.operation) {
    return { label: fallback.operation, variant: "working" };
  }
  if (health?.state === "checking") {
    return { label: "Prüft", variant: "working" };
  }
  if (health?.processAlive && health?.reachable === false) {
    return { label: "Prozess läuft", variant: "working" };
  }
  if (health?.reachable === false) {
    return { label: "Nicht erreichbar", variant: "idle" };
  }
  if (health?.reachable === true) {
    const latency = health.latencyMs == null ? "" : ` · ${health.latencyMs} ms`;
    if (selected) return { label: `Aktiv${latency}`, variant: "active" };
    if (health.ready) return { label: `Bereit${latency}`, variant: "ready" };
    return { label: `Erreichbar${latency}`, variant: "ready" };
  }
  if (selected) return { label: "Aktiv", variant: "active" };
  return {
    label: fallback.label || "Nicht geprüft",
    variant: "idle",
  };
}

async function fetchBackendHealth(origin) {
  const normalizedOrigin = normalizeOrigin(origin || "");
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 3500);

  async function request(path) {
    const response = await fetch(`${normalizedOrigin}/api/health/${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  }

  try {
    const [liveResult, readyResult] = await Promise.allSettled([
      request("live"),
      request("ready"),
    ]);
    const live = liveResult.status === "fulfilled" ? liveResult.value : null;
    const ready = readyResult.status === "fulfilled" ? readyResult.value : null;
    const reachable = Boolean(live || ready);
    const runtime = ready?.body?.runtime || live?.body?.runtime || null;

    return {
      state: reachable ? "available" : "unavailable",
      reachable,
      live: Boolean(live?.ok),
      ready: Boolean(ready?.ok),
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      runtime,
      message: !reachable
        ? "Backend antwortet nicht."
        : ready?.ok
          ? "Backend ist bereit."
          : "Backend antwortet, ist aber noch nicht bereit.",
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

function mergeRedundantBackendHealth(probedHealth, controlStatus) {
  const processAlive = Boolean(controlStatus?.process?.alive);
  const controlHealth = controlStatus?.health || {};
  const controlReachable = Boolean(controlHealth.reachable);
  const reachable = controlReachable || Boolean(probedHealth?.reachable);
  const readyBody = controlHealth.ready?.body;
  const runtime = readyBody?.runtime || probedHealth?.runtime || null;

  return {
    ...untestedBackendHealth(),
    ...(probedHealth || {}),
    state: reachable ? "available" : processAlive ? "running" : "unavailable",
    reachable,
    ready: Boolean(controlHealth.ready?.ok || probedHealth?.ready),
    live: Boolean(processAlive || probedHealth?.live),
    processAlive,
    runtime,
    checkedAt: new Date().toISOString(),
    message: reachable
      ? "Backend antwortet."
      : processAlive
        ? "Backend-Prozess läuft; der Health-Endpunkt antwortet noch nicht."
        : "Backend-Prozess läuft nicht.",
  };
}

export default function ServerPage({ token }) {
  const [activeTab, setActiveTab] = useState("switch");
  const [configTarget, setConfigTarget] = useState("redundant");
  const [databaseConfigTarget, setDatabaseConfigTarget] = useState("normal");
  const [databaseRouting, setDatabaseRouting] = useState(initialDatabaseRouting);
  const [databaseForm, setDatabaseForm] = useState(initialDatabaseForm);
  const [databaseHealth, setDatabaseHealth] = useState({
    normal: untestedDatabaseHealth(),
    redundant: untestedDatabaseHealth(),
  });
  const [systemSettings, setSystemSettings] = useState(null);
  const [jsonForm, setJsonForm] = useState(initialJsonForm);
  const [status, setStatus] = useState(null);
  const [runtimeEndpoint, setRuntimeEndpoint] = useState(() => getRuntimeEndpointState());
  const [statusTarget, setStatusTarget] = useState(() => (
    getRuntimeEndpointState()?.mode === "emergency" ? "backend-redundant" : "backend-active"
  ));
  const [backendHealth, setBackendHealth] = useState({
    active: untestedBackendHealth(),
    redundant: untestedBackendHealth(),
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [backendOperation, setBackendOperation] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const databaseAutoCheckToken = useRef(null);
  const [form, setForm] = useState({
    enabled: false,
    autoStart: true,
    autoStartDelaySeconds: 120,
    port: 4001,
    bind: "127.0.0.1",
  });

  const enabled = Boolean(status?.config?.enabled);
  const activeDatabase = databaseRouting.primary === "redundant" ? "redundant" : "normal";
  const selectedDatabaseTargets = ["normal", "redundant"].filter(
    (target) => Boolean(databaseRouting.writeTargets?.[target]),
  );
  const jsonEmergencyEngaged = Boolean(
    databaseRouting.jsonEmergency?.enabled
    && (
      databaseRouting.jsonEmergency?.active
      || (selectedDatabaseTargets.length > 0
        && selectedDatabaseTargets.every((target) => databaseHealth[target]?.available === false))
    ),
  );

  useEffect(() => {
    // Beim Wechsel auf die Server-Seite darf eine vom Browser wiederhergestellte
    // Scrollposition den Seitenkopf und die Tabs nicht unter die Sticky-Navigation schieben.
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, []);

  async function checkBackendHealth(origins, { showChecking = true } = {}) {
    if (showChecking) {
      setBackendHealth((current) => ({
        active: { ...current.active, state: "checking" },
        redundant: { ...current.redundant, state: "checking" },
      }));
    }

    const [activeResult, redundantResult] = await Promise.allSettled([
      fetchBackendHealth(origins.active),
      fetchBackendHealth(origins.redundant),
    ]);
    const failedHealth = (reason) => ({
      state: "unavailable",
      reachable: false,
      ready: false,
      live: false,
      checkedAt: new Date().toISOString(),
      latencyMs: null,
      message: reason?.message || "Backend antwortet nicht.",
    });
    const nextHealth = {
      active: activeResult.status === "fulfilled"
        ? activeResult.value
        : failedHealth(activeResult.reason),
      redundant: redundantResult.status === "fulfilled"
        ? redundantResult.value
        : failedHealth(redundantResult.reason),
    };
    setBackendHealth(nextHealth);
    return nextHealth;
  }

  async function loadStatus(options = {}) {
    const syncForm = options?.syncForm !== false;
    const silent = options?.silent === true;

    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      const nextStatus = await fetchEmergencyBackendStatus(token);
      setStatus(nextStatus);
      if (syncForm) {
        setForm({
          enabled: Boolean(nextStatus?.config?.enabled),
          autoStart: Boolean(nextStatus?.config?.autoStart),
          autoStartDelaySeconds: Math.round(Number(nextStatus?.config?.autoStartDelayMs || 0) / 1000),
          port: Number(nextStatus?.config?.port || 4001),
          bind: nextStatus?.config?.bind || "127.0.0.1",
        });
      }
      setRuntimeEndpoint(getRuntimeEndpointState());
      const probedHealth = await checkBackendHealth({
        active: ACTIVE_API_ORIGIN_URL,
        redundant: makeOrigin({
          bind: nextStatus?.config?.bind,
          port: nextStatus?.config?.port,
          fallback: EMERGENCY_API_ORIGIN_URL,
        }),
      }, { showChecking: !silent });
      setBackendHealth({
        ...probedHealth,
        redundant: mergeRedundantBackendHealth(probedHealth.redundant, nextStatus),
      });
    } catch (err) {
      if (!silent) {
        setError(err?.message || "Redundant-Backend-Status konnte nicht geladen werden.");
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }

  async function runAction(label, action, operation = "") {
    setSaving(true);
    setBackendOperation(operation);
    setMessage("");
    setError("");
    try {
      const nextStatus = await action();
      setStatus(nextStatus);
      setMessage(label);
      await loadStatus();
    } catch (err) {
      setError(err?.message || "Aktion fehlgeschlagen.");
    } finally {
      setSaving(false);
      setBackendOperation("");
    }
  }

  async function saveSettings() {
    await runAction("Backend-Konfiguration gespeichert.", () => updateEmergencyBackendSettings(token, {
      enabled: form.enabled,
      autoStart: form.autoStart,
      autoStartDelayMs: Math.max(0, Number(form.autoStartDelaySeconds || 0)) * 1000,
      port: Number(form.port || 4001),
      bind: form.bind || "127.0.0.1",
    }));
  }

  function switchBackend(mode, origin) {
    const nextState = selectRuntimeEndpoint(mode, { origin });
    setRuntimeEndpoint(nextState);
    setMessage(mode === "active" ? "Oberfläche wechselt zum normalen Backend." : "Oberfläche wechselt zum redundanten Backend.");

    window.setTimeout(() => {
      window.location.reload();
    }, 250);
  }

  function setDatabaseField(target, field, value) {
    setDatabaseForm((current) => ({
      ...current,
      [target]: {
        ...current[target],
        [field]: value,
      },
    }));
    setDatabaseHealth((current) => ({
      ...current,
      [target]: untestedDatabaseHealth(),
    }));
  }

  async function pingDatabase(target, { config: configOverride, silent = false } = {}) {
    const label = target === "normal" ? "normale Datenbank" : "redundante Datenbank";
    const config = configOverride || databaseForm[target];

    setDatabaseHealth((current) => ({
      ...current,
      [target]: {
        ...current[target],
        state: "checking",
        message: "Verbindung wird geprüft.",
      },
    }));
    if (!silent) {
      setMessage("");
      setError("");
    }

    try {
      const result = await pingControlCenterDatabase(token, {
        target,
        config: {
          host: config.host,
          port: config.port,
          database: config.database,
          user: config.user,
          password: config.password,
          schema: config.schema,
          sslMode: config.sslMode,
        },
      });

      const nextHealth = {
        state: result?.available ? "available" : "unavailable",
        available: Boolean(result?.available),
        checkedAt: result?.checkedAt || new Date().toISOString(),
        latencyMs: Number.isFinite(Number(result?.latencyMs)) ? Number(result.latencyMs) : null,
        message: result?.message || (result?.available ? "Datenbank ist verfügbar." : "Datenbank ist nicht verfügbar."),
        code: result?.code || null,
      };

      setDatabaseHealth((current) => ({ ...current, [target]: nextHealth }));

      if (!nextHealth.available && !silent) {
        setError(`${label[0].toUpperCase()}${label.slice(1)} ist nicht verfügbar: ${nextHealth.message}`);
      }
      return nextHealth;
    } catch (err) {
      const nextHealth = {
        state: "unavailable",
        available: false,
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        message: err?.message || "Verbindungsprüfung fehlgeschlagen.",
        code: err?.code || "PROBE_FAILED",
      };
      setDatabaseHealth((current) => ({ ...current, [target]: nextHealth }));
      if (!silent) {
        setError(`${label[0].toUpperCase()}${label.slice(1)} konnte nicht geprüft werden: ${nextHealth.message}`);
      }
      return nextHealth;
    }
  }

  async function loadDatabaseSettings({ showMessage = false, autoCheck = true } = {}) {
    setError("");
    try {
      const result = await getControlCenterDatabaseSettings(token);
      const nextForms = {
        normal: databaseTargetForm(result?.targets?.normal, databaseForm.normal),
        redundant: databaseTargetForm(result?.targets?.redundant, databaseForm.redundant),
      };
      setDatabaseForm(nextForms);
      setDatabaseRouting(result?.routing || initialDatabaseRouting);
      setDatabaseHealth({
        normal: untestedDatabaseHealth(),
        redundant: untestedDatabaseHealth(),
      });
      if (showMessage) setMessage("Datenbank-Konfiguration wurde neu geladen.");
      if (autoCheck) {
        await Promise.allSettled([
          pingDatabase("normal", { config: nextForms.normal, silent: true }),
          pingDatabase("redundant", { config: nextForms.redundant, silent: true }),
        ]);
      }
    } catch (err) {
      setError(err?.message || "Datenbank-Konfiguration konnte nicht geladen werden.");
    }
  }

  async function saveDatabaseSettings() {
    const target = databaseConfigTarget;
    const config = databaseForm[target];
    setSaving(true);
    setMessage("");
    setError("");

    try {
      const result = await saveControlCenterDatabaseSettings(token, {
        target,
        config: {
          host: config.host,
          port: config.port,
          database: config.database,
          user: config.user,
          password: config.password,
          schema: config.schema,
          sslMode: config.sslMode,
          autoConnect: config.autoConnect,
        },
      });
      const nextForms = {
        normal: databaseTargetForm(result?.targets?.normal, databaseForm.normal),
        redundant: databaseTargetForm(result?.targets?.redundant, databaseForm.redundant),
      };
      setDatabaseForm(nextForms);
      setDatabaseRouting(result?.routing || databaseRouting);
      setDatabaseHealth((current) => ({
        ...current,
        [target]: untestedDatabaseHealth(),
      }));
      setMessage(`${target === "normal" ? "Normale" : "Redundante"} Datenbank-Konfiguration wurde dauerhaft gespeichert.`);
      await pingDatabase(target, { config: nextForms[target], silent: true });
    } catch (err) {
      setError(err?.message || "Datenbank-Konfiguration konnte nicht gespeichert werden.");
    } finally {
      setSaving(false);
    }
  }

  async function persistDatabaseRoutingMode(mode, options = {}) {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const result = await saveControlCenterDatabaseRouting(token, mode, options);
      setDatabaseRouting(result?.routing || { ...initialDatabaseRouting, mode });
      if (Object.prototype.hasOwnProperty.call(options, "jsonEmergencyEnabled")) {
        setMessage(options.jsonEmergencyEnabled
          ? "JSON-Notlauf ist aktiv und übernimmt automatisch, wenn kein Datenbank-Schreibziel erreichbar ist."
          : "JSON-Notlauf ist deaktiviert. Bereits wartende Vorgänge bleiben verschlüsselt erhalten.");
      } else {
        setMessage(mode === "both"
          ? "Normale Datenbank ist primär; Schreibvorgänge werden zusätzlich redundant gespiegelt."
          : `${mode === "normal" ? "Normale" : "Redundante"} Datenbank übernimmt jetzt die Schreibvorgänge.`);
      }
    } catch (err) {
      setError(err?.message || "Datenbank-Schreibziel konnte nicht geändert werden.");
    } finally {
      setSaving(false);
    }
  }

  async function setDatabaseWriteTarget(target, enabledForWrites) {
    const nextTargets = {
      normal: target === "normal" ? enabledForWrites : Boolean(databaseRouting.writeTargets?.normal),
      redundant: target === "redundant" ? enabledForWrites : Boolean(databaseRouting.writeTargets?.redundant),
    };
    if (!nextTargets.normal && !nextTargets.redundant) {
      setError("Mindestens eine Datenbank muss als Schreibziel aktiviert bleiben.");
      return;
    }
    const mode = nextTargets.normal && nextTargets.redundant
      ? "both"
      : nextTargets.redundant
        ? "redundant"
        : "normal";

    await persistDatabaseRoutingMode(mode);
  }

  async function setJsonEmergencyEnabled(enabledForWrites) {
    await persistDatabaseRoutingMode(databaseRouting.mode || "normal", {
      jsonEmergencyEnabled: enabledForWrites,
    });
  }

  async function replayJsonEmergency(target) {
    if (databaseHealth[target]?.available !== true) {
      setError(`${target === "normal" ? "Normale" : "Redundante"} Datenbank ist nicht erreichbar.`);
      return;
    }
    const pendingCount = Number(databaseRouting.jsonEmergency?.pendingCount || 0);
    if (!window.confirm(
      `${pendingCount} JSON-Vorgang${pendingCount === 1 ? "" : "e"} jetzt in die ${target === "normal" ? "normale" : "redundante"} Datenbank übernehmen?`,
    )) return;

    setSaving(true);
    setMessage("");
    setError("");
    try {
      const result = await replayControlCenterJsonEmergency(token, target);
      if (result?.routing) setDatabaseRouting(result.routing);
      if (!result?.ok) {
        setError("Der JSON-Abgleich wurde angehalten. Der nicht übernommene Vorgang bleibt sicher in der Warteschlange.");
        return;
      }
      setMessage(`${Number(result?.replayed || 0)} JSON-Vorgänge wurden in die ${target === "normal" ? "normale" : "redundante"} Datenbank übernommen.`);
    } catch (err) {
      setError(err?.message || "JSON-Notlauf konnte nicht in die Datenbank übernommen werden.");
    } finally {
      setSaving(false);
    }
  }

  async function runDatabaseFullSync({ source, target, confirmation }) {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const result = await runControlCenterDatabaseFullSync(token, { source, target, confirmation });
      setMessage(result?.message || "Datenbank-Vollabgleich wurde abgeschlossen.");
      await loadDatabaseSettings({ autoCheck: true });
    } catch (err) {
      setError(err?.code === "POSTGRESQL_CLIENT_TOOLS_NOT_INSTALLED"
        ? "PostgreSQL-Werkzeuge fehlen: Für den Vollabgleich müssen pg_dump und pg_restore installiert sein."
        : err?.message || "Datenbank-Vollabgleich ist fehlgeschlagen.");
    } finally {
      setSaving(false);
    }
  }

  async function loadJsonSettings() {
    try {
      const nextSettings = await getControlCenterSystemSettings(token);
      setSystemSettings(nextSettings);
      setJsonForm(normalizeJsonForm(nextSettings));
    } catch (err) {
      setError(err?.message || "JSON-/Backup-Konfiguration konnte nicht geladen werden.");
    }
  }

  function patchJsonForm(patch) {
    setJsonForm((current) => ({
      ...current,
      ...patch,
    }));
  }

  async function saveJsonSettings() {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const payload = {
        json: jsonForm,
      };
      const result = await saveControlCenterSystemSettings(token, payload);
      setSystemSettings(result);
      setJsonForm(normalizeJsonForm(result));
      setMessage("JSON-/Backup-Konfiguration wurde gespeichert.");
    } catch (err) {
      setError(err?.message || "JSON-/Backup-Konfiguration konnte nicht gespeichert werden.");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    loadStatus();
    loadJsonSettings();
    if (databaseAutoCheckToken.current !== token) {
      databaseAutoCheckToken.current = token;
      loadDatabaseSettings({ autoCheck: true });
    }
  }, [token]);

  useEffect(() => {
    if (activeTab !== "backendConfig") return undefined;

    let refreshRunning = false;
    const refreshCurrentBackendStatus = async () => {
      if (refreshRunning || document.visibilityState === "hidden") return;
      refreshRunning = true;
      try {
        await loadStatus({ syncForm: false, silent: true });
      } finally {
        refreshRunning = false;
      }
    };

    void refreshCurrentBackendStatus();
    const interval = window.setInterval(refreshCurrentBackendStatus, 5_000);
    window.addEventListener("focus", refreshCurrentBackendStatus);
    document.addEventListener("visibilitychange", refreshCurrentBackendStatus);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshCurrentBackendStatus);
      document.removeEventListener("visibilitychange", refreshCurrentBackendStatus);
    };
  }, [activeTab, token]);

  const backendTargets = useMemo(() => {
    const active = parseOrigin(ACTIVE_API_ORIGIN_URL);
    const redundantOrigin = makeOrigin({
      bind: form.bind || status?.config?.bind,
      port: form.port || status?.config?.port,
      fallback: EMERGENCY_API_ORIGIN_URL,
    });
    const redundant = parseOrigin(redundantOrigin || EMERGENCY_API_ORIGIN_URL);
    const selectedOrigin = normalizeOrigin(runtimeEndpoint?.origin || ACTIVE_API_ORIGIN_URL);

    return {
      active,
      redundant,
      selectedOrigin,
      activeSelected: selectedOrigin === active.origin,
      redundantSelected: selectedOrigin === redundant.origin || runtimeEndpoint?.mode === "emergency",
    };
  }, [form.bind, form.port, status, runtimeEndpoint]);

  const databaseTargets = useMemo(() => {
    const pendingCount = Number(databaseRouting.jsonEmergency?.pendingCount || 0);
    return {
      normal: databaseForm.normal,
      redundant: databaseForm.redundant,
      json: {
        host: "lokal verschlüsselt",
        port: "—",
        database: pendingCount ? `${pendingCount} wartend` : "Notlauf bereit",
      },
    };
  }, [databaseForm, databaseRouting.jsonEmergency?.pendingCount]);

  const databaseCardStates = useMemo(() => ({
    normal: databaseCardState(Boolean(databaseRouting.writeTargets?.normal), databaseHealth.normal),
    redundant: databaseCardState(Boolean(databaseRouting.writeTargets?.redundant), databaseHealth.redundant),
    json: !databaseRouting.jsonEmergency?.enabled
      ? { label: "Deaktiviert", variant: "idle" }
      : jsonEmergencyEngaged
        ? {
            label: `Notlauf aktiv · ${Number(databaseRouting.jsonEmergency?.pendingCount || 0)} offen`,
            variant: "working",
          }
        : Number(databaseRouting.jsonEmergency?.pendingCount || 0) > 0
          ? {
              label: `${Number(databaseRouting.jsonEmergency?.pendingCount || 0)} offen`,
              variant: "ready",
            }
          : { label: "Bereit", variant: "ready" },
  }), [databaseHealth, databaseRouting.jsonEmergency, databaseRouting.writeTargets, jsonEmergencyEngaged]);

  const activeCardState = backendCardState(
    backendTargets.activeSelected && !backendTargets.redundantSelected,
    backendHealth.active,
  );

  const redundantCardState = backendCardState(
    backendTargets.redundantSelected,
    backendHealth.redundant,
    {
      operation: backendOperation,
      label: enabled ? "Gestoppt" : "Deaktiviert",
    },
  );

  const activeDatabaseLabel = jsonEmergencyEngaged
    ? "JSON-Notlauf"
    : databaseRouting.mode === "both"
      ? "Normal + Redundant"
      : activeDatabase === "normal"
        ? "Normale Datenbank"
        : "Redundante Datenbank";

  const switchStatusPanel = useMemo(() => {
    if (statusTarget === "backend-active" || statusTarget === "backend-redundant") {
      const target = statusTarget === "backend-redundant" ? "redundant" : "active";
      const targetConfig = backendTargets[target];
      const health = backendHealth[target];
      const isRedundant = target === "redundant";
      const connected = isRedundant
        ? backendTargets.redundantSelected
        : backendTargets.activeSelected && !backendTargets.redundantSelected;
      const title = isRedundant ? "Redundantes Backend" : "Normales Backend";
      const pillLabel = health?.state === "checking"
        ? "Prüft"
        : health?.processAlive && health?.reachable === false
          ? "Prozess läuft"
          : health?.reachable === false
            ? "Nicht erreichbar"
            : connected
              ? "Verbunden"
              : health?.ready
                ? "Bereit"
                : "Ansehen";

      return {
        kind: "backend",
        target,
        title,
        eyebrow: "Ausgewählte Backend-Kachel",
        pillLabel,
        pillVariant: health?.reachable === false && !health?.processAlive ? "warn" : connected || health?.processAlive ? "ok" : "neutral",
        diagnostics: [
          ["Backend", title],
          ["Backend-Status", backendHealthLabel(health)],
          ["Oberfläche", connected ? "aktiv verbunden" : "nicht verbunden"],
          ["Antwortzeit", health?.latencyMs == null ? "—" : `${health.latencyMs} ms`],
          ["Letzte Prüfung", health?.checkedAt ? new Date(health.checkedAt).toLocaleString("de-DE") : "—"],
          ["Rolle", health?.runtime?.slotRole || (isRedundant ? "redundant" : "normal")],
          ["Version", formatBonniCoreVersion(health?.runtime?.version)],
          ["PID", health?.runtime?.pid || (isRedundant ? status?.process?.pid || "—" : "—")],
          ["Origin", targetConfig?.origin || "—"],
        ],
      };
    }

    if (statusTarget === "database-normal" || statusTarget === "database-redundant") {
      const target = statusTarget === "database-redundant" ? "redundant" : "normal";
      const targetConfig = databaseTargets[target];
      const health = databaseHealth[target];
      const selected = Boolean(databaseRouting.writeTargets?.[target]);
      const title = target === "normal" ? "Normale Datenbank" : "Redundante Datenbank";
      const latency = health?.latencyMs == null ? "" : ` · ${health.latencyMs} ms`;
      const pillLabel = health?.state === "checking"
        ? "Prüft"
        : health?.available === false
          ? "Nicht verfügbar"
          : selected
            ? `Aktiv${latency}`
            : health?.available === true
              ? `Verfügbar${latency}`
              : "Nicht geprüft";

      return {
        kind: "database",
        target,
        title,
        eyebrow: "Ausgewählte Datenbank-Kachel",
        pillLabel,
        pillVariant: health?.available === false ? "warn" : health?.available === true ? "ok" : "neutral",
        diagnostics: [
          ["Datenbank", title],
          ["Verbindungsstatus", databaseHealthLabel(health)],
          ["Schreibziel", selected ? "aktiv" : "nicht aktiv"],
          ["Primäres Ziel", databaseRouting.primary === target ? "ja" : "nein"],
          ["Antwortzeit", health?.latencyMs == null ? "—" : `${health.latencyMs} ms`],
          ["Letzte Prüfung", health?.checkedAt ? new Date(health.checkedAt).toLocaleString("de-DE") : "—"],
          ["Host", targetConfig?.host || "—"],
          ["Port", targetConfig?.port || "—"],
          ["Name", targetConfig?.database || "—"],
          ["Benutzer", targetConfig?.user || "—"],
          ["Schema", targetConfig?.schema || "public"],
        ],
      };
    }

    const jsonEmergency = databaseRouting.jsonEmergency || {};
    const pendingCount = Number(jsonEmergency.pendingCount || 0);
    const jsonStatus = !jsonEmergency.enabled
      ? "deaktiviert"
      : jsonEmergencyEngaged
        ? "Notlauf aktiv"
        : "bereit";
    return {
      kind: "json",
      target: "json",
      title: "JSON-Notlauf",
      eyebrow: "Ausgewählte Notlauf-Kachel",
      pillLabel: jsonEmergencyEngaged ? `Aktiv · ${pendingCount} offen` : jsonEmergency.enabled ? "Bereit" : "Deaktiviert",
      pillVariant: jsonEmergencyEngaged ? "warn" : jsonEmergency.enabled ? "ok" : "neutral",
      diagnostics: [
        ["JSON-Notlauf", jsonStatus],
        ["Verschlüsselung", jsonEmergency.encrypted === false ? "deaktiviert" : "aktiv"],
        ["Offene Vorgänge", String(pendingCount)],
        ["Letzter Eintrag", jsonEmergency.lastQueuedAt ? new Date(jsonEmergency.lastQueuedAt).toLocaleString("de-DE") : "—"],
        ["Letzter Abgleich", jsonEmergency.lastReplayAt ? new Date(jsonEmergency.lastReplayAt).toLocaleString("de-DE") : "—"],
        ["Letztes Ziel", jsonEmergency.lastReplayTarget || "—"],
        [
          "Letzter Fehler",
          typeof jsonEmergency.lastError === "string"
            ? jsonEmergency.lastError
            : jsonEmergency.lastError
              ? JSON.stringify(jsonEmergency.lastError)
              : "—",
        ],
        ["Speicher", "lokal verschlüsselt"],
      ],
    };
  }, [backendHealth, backendTargets, databaseHealth, databaseRouting, databaseTargets, jsonEmergencyEngaged, status, statusTarget]);

  const backendDiagnostics = useMemo(() => {
    const target = configTarget === "active" ? "active" : "redundant";
    const health = backendHealth[target];
    const runtime = health?.runtime || {};
    const targetConfig = backendTargets[target];
    const checkedAt = health?.checkedAt
      ? new Date(health.checkedAt).toLocaleString("de-DE")
      : "—";
    const latency = health?.latencyMs == null ? "—" : `${health.latencyMs} ms`;

    if (target === "active") {
      return [
        ["Status", backendHealthLabel(health)],
        ["Prozess", health?.reachable === true ? "läuft" : "nicht erreichbar"],
        ["Antwortzeit", latency],
        ["Letzte Prüfung", checkedAt],
        ["Rolle", runtime.slotRole || "normal"],
        ["Version", formatBonniCoreVersion(runtime.version)],
        ["PID", runtime.pid || "—"],
        ["Origin", targetConfig?.origin || "—"],
      ];
    }

    const reachable = health?.reachable === true;
    const managedProcessAlive = Boolean(status?.process?.alive);
    const processState = managedProcessAlive
      ? "läuft (verwaltet)"
      : reachable
        ? "läuft (extern erkannt)"
        : "gestoppt";

    return [
      ["Status", backendHealthLabel(health)],
      ["Prozess", processState],
      ["Bereitschaft", health?.ready === true ? "bereit" : reachable ? "noch nicht bereit" : "—"],
      ["Antwortzeit", latency],
      ["Letzte Prüfung", checkedAt],
      ["PID", runtime.pid || status?.process?.pid || "—"],
      ["Startmodus", status?.config?.autoStart ? "automatisch" : "manuell"],
      ["Verzögerung", formatDelay(status?.config?.autoStartDelayMs)],
      ["Geplant für", status?.schedule?.scheduledFor || "—"],
      ["Origin", status?.health?.origin || targetConfig?.origin || "—"],
    ];
  }, [backendHealth, backendTargets, configTarget, status]);

  const databaseDiagnostics = useMemo(() => {
    const active = databaseTargets[activeDatabase];
    const health = databaseHealth[activeDatabase];
    return [
      ["Aktive Datenbank", activeDatabaseLabel],
      ["Verbindungsstatus", databaseHealthLabel(health)],
      ["Antwortzeit", health.latencyMs == null ? "—" : `${health.latencyMs} ms`],
      ["Letzte Prüfung", health.checkedAt ? new Date(health.checkedAt).toLocaleString("de-DE") : "—"],
      ["Host", active.host],
      ["Port", active.port],
      ["Datenbank", active.database],
      ["Schema", active.schema || "public"],
    ];
  }, [activeDatabase, activeDatabaseLabel, databaseHealth, databaseTargets]);

  const selectedDatabaseForm = databaseForm[databaseConfigTarget];

  return (
    <section className="cc-menu-layout-page cc-system-page security-page">
      <div className="cc-user-page__header cc-menu-page-header">
        <div>
          <h1>Server</h1>
          <p>Redundanz, Backend, Datenbank und JSON-/Backup-Konfiguration verwalten.</p>
        </div>
      </div>

      <div className="cc-system-tabbar" role="tablist" aria-label="Redundanz und Datenbank">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "switch"}
          className={activeTab === "switch" ? "cc-system-tab cc-system-tab--active" : "cc-system-tab"}
          onClick={() => setActiveTab("switch")}
        >
          Umschalten
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "backendConfig"}
          className={activeTab === "backendConfig" ? "cc-system-tab cc-system-tab--active" : "cc-system-tab"}
          onClick={() => setActiveTab("backendConfig")}
        >
          Backend konfigurieren
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "databaseConfig"}
          className={activeTab === "databaseConfig" ? "cc-system-tab cc-system-tab--active" : "cc-system-tab"}
          onClick={() => setActiveTab("databaseConfig")}
        >
          Datenbank konfigurieren
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "jsonBackup"}
          className={activeTab === "jsonBackup" ? "cc-system-tab cc-system-tab--active" : "cc-system-tab"}
          onClick={() => setActiveTab("jsonBackup")}
        >
          JSON / Backup
        </button>
      </div>

      <article className="cc-menu-page-content security-card security-card--wide">
        {message ? <div className="security-message security-message--ok">{message}</div> : null}
        {error ? <div className="security-message security-message--error">{error}</div> : null}

        {activeTab === "switch" ? (
          <ServerSwitchTab
            activeCardState={activeCardState}
            backendHealth={backendHealth}
            backendTargets={backendTargets}
            databaseCardStates={databaseCardStates}
            databaseHealth={databaseHealth}
            databaseTargets={databaseTargets}
            databaseRouting={databaseRouting}
            jsonEmergencyEngaged={jsonEmergencyEngaged}
            enabled={enabled}
            statusPanel={switchStatusPanel}
            statusTarget={statusTarget}
            setStatusTarget={setStatusTarget}
            redundantCardState={redundantCardState}
            redundantProcessAlive={Boolean(status?.process?.alive || backendHealth.redundant?.reachable)}
            runAction={runAction}
            runDatabaseFullSync={runDatabaseFullSync}
            replayJsonEmergency={replayJsonEmergency}
            saving={saving}
            setDatabaseWriteTarget={setDatabaseWriteTarget}
            setJsonEmergencyEnabled={setJsonEmergencyEnabled}
            refreshBackendHealth={loadStatus}
            refreshDatabaseHealth={(target) => pingDatabase(target, { silent: true })}
            switchBackend={switchBackend}
            token={token}
          />
        ) : null}

        {activeTab === "backendConfig" ? (
          <ServerBackendConfigTab
            activeCardState={activeCardState}
            backendDiagnostics={backendDiagnostics}
            backendTargets={backendTargets}
            configTarget={configTarget}
            form={form}
            redundantCardState={redundantCardState}
            runAction={runAction}
            saveSettings={saveSettings}
            saving={saving}
            setConfigTarget={setConfigTarget}
            setForm={setForm}
            token={token}
          />
        ) : null}

        {activeTab === "databaseConfig" ? (
          <ServerDatabaseConfigTab
            activeDatabase={activeDatabase}
            databaseCardStates={databaseCardStates}
            databaseConfigTarget={databaseConfigTarget}
            databaseDiagnostics={databaseDiagnostics}
            databaseTargets={databaseTargets}
            pingDatabase={pingDatabase}
            reloadDatabaseSettings={() => loadDatabaseSettings({ showMessage: true })}
            saveDatabaseSettings={saveDatabaseSettings}
            saving={saving}
            selectedDatabaseForm={selectedDatabaseForm}
            setDatabaseConfigTarget={setDatabaseConfigTarget}
            setDatabaseField={setDatabaseField}
            setMessage={setMessage}
          />
        ) : null}

        {activeTab === "jsonBackup" ? (
          <ServerJsonBackupTab
            settings={systemSettings}
            jsonForm={jsonForm}
            onPatchJson={patchJsonForm}
            onReload={loadJsonSettings}
            onSave={saveJsonSettings}
            saving={saving}
            token={token}
          />
        ) : null}
      </article>
    </section>
  );
}
