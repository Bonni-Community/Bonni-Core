import { useEffect, useMemo, useState } from "react";

import { apiRequest } from "../../../system/api/apiClient.js";
import {
  checkCoreUpdate,
  checkLocalSourceUpdate,
  fetchCoreUpdateStatus,
  prepareCoreUpdate,
} from "../../../system/api/coreUpdateApi.js";
import { BONNI_CORE_VERSION } from "../../../system/version.js";
import MonitorIcon from "../system/MonitorIcon.jsx";
import CoreUpdatePopover from "../update/CoreUpdatePopover.jsx";
import {
  formatBonniCoreVersion,
  normalizeUpdateActionError,
  UPDATE_ACTION_ERROR_STORAGE_KEY,
} from "../update/localUpdatePresentation.js";


function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatBackendUptime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(toNumber(totalSeconds, 0)));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return `${days} ${days === 1 ? "Tag" : "Tage"} ${hours} ${hours === 1 ? "Stunde" : "Stunden"}`;
  }

  if (hours > 0) {
    return `${hours} ${hours === 1 ? "Stunde" : "Stunden"} ${minutes} ${minutes === 1 ? "Minute" : "Minuten"}`;
  }

  if (minutes > 0) {
    return `${minutes} ${minutes === 1 ? "Minute" : "Minuten"}`;
  }

  return "unter 1 Minute";
}

function extractRuntimeStatus(payload) {
  const runtime = payload?.runtime || payload?.live?.runtime || payload?.ready?.runtime || null;
  const startedAt = runtime?.startedAt ? new Date(runtime.startedAt) : null;
  const uptimeSeconds = toNumber(runtime?.uptimeSeconds, 0);

  return {
    startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null,
    uptimeSeconds,
    slotName: runtime?.slotName || runtime?.slot || null,
    slotRole: runtime?.slotRole || null,
  };
}

const LOCAL_SOURCE_ATTENTION_STATES = new Set([
  "available",
  "ready",
  "queued",
  "checking",
  "validating",
  "backing-up",
  "maintenance",
  "stopping",
  "applying",
  "setting-up",
  "restarting",
  "health-check",
  "in-progress",
  "installing",
  "running",
  "failed",
  "invalid",
  "id-collision",
  "multiple-packages",
  "recovery-required",
]);

function readStoredUpdateError() {
  try {
    const raw = window.sessionStorage.getItem(UPDATE_ACTION_ERROR_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeUpdateError(error) {
  try {
    if (error) {
      window.sessionStorage.setItem(UPDATE_ACTION_ERROR_STORAGE_KEY, JSON.stringify(error));
    } else {
      window.sessionStorage.removeItem(UPDATE_ACTION_ERROR_STORAGE_KEY);
    }
  } catch {
    // Die Statusanzeige bleibt auch ohne verfügbaren Sitzungsspeicher nutzbar.
  }
}

function hasLocalSourceUpdateAttention(localSourceUpdate) {
  return Boolean(localSourceUpdate?.updateAvailable)
    || LOCAL_SOURCE_ATTENTION_STATES.has(String(localSourceUpdate?.state || "").toLowerCase())
    || LOCAL_SOURCE_ATTENTION_STATES.has(String(
      localSourceUpdate?.progress?.status || localSourceUpdate?.progress?.phase || "",
    ).toLowerCase());
}

const QUICK_ACTIONS = [
  { key: "secure", icon: "▣", label: "Sicherer Zugriff", kind: "status" },
  { key: "sync", icon: "↻", label: "Registry synchronisieren", action: "sync" },
  { key: "logout", icon: "⎋", label: "Logout", action: "logout" },
  { key: "my-settings", icon: "◉", label: "Einstellungen", action: "my-settings" },
  { key: "terminal", icon: ">_", label: "Terminal", target: "terminal", title: "Terminal in neuem Fenster öffnen" },
  { key: "system-monitor", icon: <MonitorIcon />, label: "Systemmonitor", target: "system-monitor", title: "Systemdaten in neuem Fenster öffnen" },
  { key: "live-terminal", icon: "▤", label: "Live-Terminal", target: "live-terminal", title: "Live-Terminal in neuem Fenster öffnen" },
  { key: "help", icon: "?", label: "Core-Diagnose", target: "diagnostics" },
];

export default function ControlCenterTopBar({
  token,
  activeNavigationKey,
  navItems = [],
  onHome,
  onNavigate,
  onLogout,
  onSyncRegistry,
  onMainMenu,
  onOpenMySettings,
}) {
  const [versionOpen, setVersionOpen] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState(null);
  const [runtimeTick, setRuntimeTick] = useState(Date.now());
  const [updateStatus, setUpdateStatus] = useState(null);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateAction, setUpdateAction] = useState("");
  const [updateError, setUpdateError] = useState(() => readStoredUpdateError()?.message || "");

  useEffect(() => {
    let cancelled = false;
    let intervalId;

    async function loadRuntimeStatus() {
      try {
        const payload = await apiRequest("/api/runtime", { auth: false });
        if (!cancelled) {
          setRuntimeStatus(extractRuntimeStatus(payload));
        }
      } catch (error) {
        console.warn("Backend-Betriebszeit konnte nicht geladen werden", error);
        if (!cancelled) {
          setRuntimeStatus(null);
        }
      }
    }

    loadRuntimeStatus();
    intervalId = window.setInterval(loadRuntimeStatus, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let intervalId;
    let automaticCheckHandled = false;
    let automaticDownloadHandled = false;

    async function loadUpdateStatus({ quiet = true } = {}) {
      if (!token) return;
      if (!quiet) setUpdateLoading(true);
      try {
        // Local test packages already reside in UPDATE, so the lightweight
        // inbox scan remains independent from the production download cycle.
        await checkLocalSourceUpdate(token).catch(() => null);
        let payload = await fetchCoreUpdateStatus(token);
        if (!automaticCheckHandled && payload?.settings?.automaticChecks) {
          automaticCheckHandled = true;
          await checkCoreUpdate(token).catch(() => null);
          payload = await fetchCoreUpdateStatus(token);
        }
        if (
          !automaticDownloadHandled
          && payload?.settings?.automaticDownload
          && payload?.updateAvailable
          && payload?.updateKind !== "local-source"
          && !["running", "ready"].includes(payload?.workflow?.status)
        ) {
          automaticDownloadHandled = true;
          await prepareCoreUpdate(token).catch(() => null);
          payload = await fetchCoreUpdateStatus(token);
        }
        if (!cancelled) {
          setUpdateStatus(payload);
        }
      } catch (error) {
        if (!cancelled && !quiet) {
          const normalized = normalizeUpdateActionError(
            error,
            "Update-Status konnte nicht geladen werden.",
            "current",
          );
          setUpdateError(normalized.message);
          storeUpdateError(normalized);
        }
      } finally {
        if (!cancelled && !quiet) setUpdateLoading(false);
      }
    }

    loadUpdateStatus({ quiet: false });
    intervalId = window.setInterval(() => loadUpdateStatus({ quiet: true }), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [token]);

  useEffect(() => {
    if (!versionOpen) return;
    setUpdateError(readStoredUpdateError()?.message || "");
  }, [versionOpen]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setRuntimeTick(Date.now()), 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const backendUptimeSeconds = useMemo(() => {
    if (!runtimeStatus) return null;

    if (runtimeStatus.startedAt) {
      return Math.max(0, Math.floor((runtimeTick - runtimeStatus.startedAt.getTime()) / 1000));
    }

    return runtimeStatus.uptimeSeconds;
  }, [runtimeStatus, runtimeTick]);

  const backendUptimeLabel = backendUptimeSeconds == null
    ? "Betriebszeit wird geladen"
    : `Backend-Betriebszeit ${formatBackendUptime(backendUptimeSeconds)}`;

  const backendUptimeTitle = runtimeStatus?.startedAt
    ? `Backend gestartet: ${runtimeStatus.startedAt.toLocaleString("de-DE")}`
    : "Betriebszeit des aktuell erreichbaren Backends";
  const versionMismatch = Boolean(
    updateStatus?.currentVersion
    && updateStatus.currentVersion !== BONNI_CORE_VERSION,
  );
  const localSourceUpdateAttention = hasLocalSourceUpdateAttention(updateStatus?.localSourceUpdate);

  const navItemsByKey = useMemo(() => {
    const map = new Map();
    for (const item of navItems) {
      map.set(item.key, item);
      if (item.targetModule) map.set(item.targetModule, item);
    }
    return map;
  }, [navItems]);

  function handleBrandClick() {
    if (typeof onMainMenu === "function") {
      onMainMenu();
      return;
    }

    onHome?.();
  }

  function navigateTo(key) {
    const item = navItemsByKey.get(key);
    if (item) {
      onNavigate?.(item);
      return;
    }

    if (["terminal", "system-monitor", "live-terminal"].includes(key)) {
      onNavigate?.({ key });
      return;
    }

    if (key === "changelog") {
      onNavigate?.({ key: "changelog", label: "Änderungsprotokoll" });
      return;
    }

    if (key === "backup") {
      onNavigate?.({ key: "backup", targetModule: "backup", label: "Backup & Wiederherstellung" });
      return;
    }

    if (key === "update-settings") {
      onNavigate?.({ key: "update-settings", label: "Update-Einstellungen" });
      return;
    }

    if (key === "update") {
      onNavigate?.({ key: "update", label: "Aktualisierung" });
      return;
    }

    if (key === "release-notes") {
      onNavigate?.({ key: "changelog", label: "Release Notes" });
    }
  }

  async function handleCheckForUpdates() {
    if (!token || updateAction) return;
    setUpdateAction("check");
    setUpdateError("");
    storeUpdateError(null);
    try {
      const checks = await Promise.allSettled([
        checkCoreUpdate(token),
        checkLocalSourceUpdate(token),
      ]);
      const rejected = checks.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      setUpdateStatus(await fetchCoreUpdateStatus(token));
      storeUpdateError(null);
    } catch (error) {
      const normalized = normalizeUpdateActionError(error, "Updateprüfung fehlgeschlagen.", "current");
      setUpdateError(normalized.message);
      storeUpdateError(normalized);
    } finally {
      setUpdateAction("");
    }
  }

  function handleUpdateNavigate(key) {
    setVersionOpen(false);
    navigateTo(key);
  }

  function handleQuickAction(action) {
    if (action.action === "sync") {
      onSyncRegistry?.();
      return;
    }

    if (action.action === "logout") {
      onLogout?.();
      return;
    }

    if (action.action === "my-settings") {
      onOpenMySettings?.();
      return;
    }

    if (action.target) {
      navigateTo(action.target);
    }
  }

  return (
    <header className="control-center-topbar cc-unraid-nav">
      <div className="cc-unraid-nav__main">
        <div className="cc-unraid-brand-block">
          <button
            className="cc-unraid-brand"
            type="button"
            onClick={handleBrandClick}
            aria-label="Zur CTA-Übersicht zurückkehren"
            title="Zur CTA-Übersicht zurückkehren"
          >
            Control Center
          </button>

          <button
            className="cc-version-trigger"
            type="button"
            onClick={() => setVersionOpen((open) => !open)}
            aria-expanded={versionOpen}
            title="Versionsinformationen"
          >
            <span
              className={`cc-version-dot${
                updateStatus?.updateAvailable || versionMismatch
                  ? " is-update"
                  : localSourceUpdateAttention
                    ? " is-local-update"
                    : ""
              }`}
              aria-hidden="true"
            />
            {formatBonniCoreVersion(updateStatus?.currentVersion || BONNI_CORE_VERSION)}
            <span className="cc-version-caret" aria-hidden="true">⌄</span>
          </button>

          {versionOpen ? (
            <CoreUpdatePopover
              status={updateStatus}
              installedVersion={BONNI_CORE_VERSION}
              loading={updateLoading}
              action={updateAction}
              error={updateError}
              onCheck={handleCheckForUpdates}
              onNavigate={handleUpdateNavigate}
            />
          ) : null}
        </div>

        <div className="cc-nav-status cc-nav-status--compact" aria-label="Control Center Status">
          <div className="cc-nav-status__meta">
            <span title={backendUptimeTitle}>{backendUptimeLabel}</span>
          </div>

          <div className="cc-nav-tools" aria-label="Schnellzugriffe">
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action.key}
                type="button"
                className={`cc-tool-button${action.kind === "status" ? " cc-tool-button--status" : ""}`}
                onClick={() => handleQuickAction(action)}
                title={action.title || action.label}
                aria-label={action.label}
                aria-current={action.key === "help" && activeNavigationKey === "diagnostics" ? "page" : undefined}
              >
                {action.icon}
              </button>
            ))}
          </div>
        </div>
      </div>

      <nav className="cc-primary-nav" aria-label="Control Center Navigation">
        {navItems.filter(item => item.showInTopBar !== false).map((item) => {
          const active = activeNavigationKey === item.key;

          return (
            <button
              key={item.key}
              type="button"
              className={`cc-primary-nav__item${active ? " is-active" : ""}`}
              onClick={() => onNavigate?.(item)}
              title={item.description}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
