import { useEffect, useMemo, useRef, useState } from "react";

import {
  canOpenControlCenter,
  getAssignedTargets,
  normalizeLaunchTarget,
} from "./accessPolicy.js";
import BrandLogo from "../brand/BrandLogo.jsx";
import BrandSloganBanner from "../brand/BrandSloganBanner.jsx";
import { useBranding } from "../brand/BrandContext.jsx";
import UserPanel from "./UserPanel.jsx";
import {
  BONNI_CORE_INDEX_SLOT_COUNT,
  BONNI_CORE_INDEX_VIEW_DESKTOP,
  BONNI_CORE_INDEX_VIEW_MOBILE,
  indexLayoutStorageKey,
  indexViewStorageKey,
  moveIndexTile,
  nextIndexViewMode,
  normalizeIndexLayout,
  readIndexLayout,
  readIndexViewMode,
  writeIndexLayout,
  writeIndexViewMode,
} from "./bonniCoreIndexLayout.js";
import "./AppLauncher.css";

const CONTROL_CENTER_TILE = {
  key: "control-center",
  label: "Control Center",
  description: "Benutzer, Rechte und Einstellungen",
};

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function navigationEntries(shell) {
  return [...asList(shell?.permissions?.navigation), ...asList(shell?.navigation)];
}

function navigationEntry(target, shell) {
  return navigationEntries(shell).find((item) => (
    normalizeLaunchTarget(item?.appRoute || item?.route || item?.key) === target
  ));
}

function targetLabel(target, shell, fallback) {
  const entry = navigationEntry(target, shell);
  return entry?.label || entry?.name || fallback || target.replace(/^app\./, "");
}

function appTile(target, shell) {
  const entry = navigationEntry(target, shell) || {};
  return {
    key: target,
    label: targetLabel(target, shell),
    icon: entry.icon,
    description: entry.description || "Installierte Anwendung",
  };
}

function AppIcon({ tile }) {
  const configuredIcon = typeof tile.icon === "string" ? tile.icon.trim() : "";
  if (configuredIcon && Array.from(configuredIcon).length <= 3) {
    return <span aria-hidden="true">{configuredIcon}</span>;
  }

  const key = tile.key.toLowerCase();
  if (key === "control-center") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" /></svg>;
  }
  if (key.includes("meet")) {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></svg>;
  }
  if (key.includes("kontor")) {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l3 3v15H6zM14 3v4h4M9 11h6M9 15h6" /></svg>;
  }
  if (key.includes("stueberl") || key.includes("stüberl")) {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h11v9a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3zM16 10h2a2 2 0 0 1 0 4h-2M8 4v2M12 4v2" /></svg>;
  }
  if (key.includes("hocket")) {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18M8 14h2M14 14h2" /></svg>;
  }
  if (key.includes("kasse") || key.includes("pos")) {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" /></svg>;
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export default function BonniCoreIndex({ user, shell, onOpenTarget, onOpenControlCenter, onOpenMembers, onOpenMySettings, onOpenMyDocuments, onLogout }) {
  const { branding } = useBranding();
  const holdTimerRef = useRef(null);
  const pressRef = useRef(null);
  const suppressClickRef = useRef(false);
  const [draggingKey, setDraggingKey] = useState("");
  const [dropIndex, setDropIndex] = useState(null);
  const assignedApps = getAssignedTargets(user, shell).filter((target) => target.startsWith("app."));
  const controlCenterAllowed = canOpenControlCenter(user, shell);
  const tiles = [
    ...assignedApps.map((target) => appTile(target, shell)),
    ...(controlCenterAllowed ? [CONTROL_CENTER_TILE] : []),
  ];
  const tileKeys = tiles.map((tile) => tile.key);
  const tileKeySignature = tileKeys.join("|");
  const storageKey = indexLayoutStorageKey(user, shell);
  const viewStorageKey = indexViewStorageKey(user, shell);
  const [slots, setSlots] = useState(() => normalizeIndexLayout(null, tileKeys));
  const storedViewMode = useMemo(
    () => typeof window === "undefined"
      ? BONNI_CORE_INDEX_VIEW_DESKTOP
      : readIndexViewMode(window.localStorage, viewStorageKey),
    [viewStorageKey],
  );
  const [viewSelection, setViewSelection] = useState(null);
  const viewMode = viewSelection?.storageKey === viewStorageKey
    ? viewSelection.mode
    : storedViewMode;
  const tilesByKey = new Map(tiles.map((tile) => [tile.key, tile]));

  useEffect(() => {
    setSlots(readIndexLayout(window.localStorage, storageKey, tileKeys));
  }, [storageKey, tileKeySignature]);

  useEffect(() => () => window.clearTimeout(holdTimerRef.current), []);

  function clearHoldTimer() {
    window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  }

  function beginHold(event, sourceIndex, tileKey) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    clearHoldTimer();
    pressRef.current = {
      pointerId: event.pointerId,
      sourceIndex,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    holdTimerRef.current = window.setTimeout(() => {
      if (!pressRef.current || pressRef.current.pointerId !== event.pointerId) return;
      pressRef.current.active = true;
      suppressClickRef.current = true;
      setDraggingKey(tileKey);
      setDropIndex(sourceIndex);
    }, 520);
  }

  function moveHold(event) {
    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;

    if (!press.active) {
      const distance = Math.hypot(event.clientX - press.startX, event.clientY - press.startY);
      if (distance > 9) clearHoldTimer();
      return;
    }

    const slot = document.elementFromPoint(event.clientX, event.clientY)?.closest?.("[data-index-slot]");
    const target = Number(slot?.dataset?.indexSlot);
    if (Number.isInteger(target) && target >= 0 && target < BONNI_CORE_INDEX_SLOT_COUNT) {
      setDropIndex(target);
    }
  }

  function endHold(event) {
    const press = pressRef.current;
    clearHoldTimer();
    pressRef.current = null;
    if (!press || press.pointerId !== event.pointerId || !press.active) return;

    const releasedSlot = document.elementFromPoint(event.clientX, event.clientY)?.closest?.("[data-index-slot]");
    const releasedIndex = Number(releasedSlot?.dataset?.indexSlot);
    const targetIndex = Number.isInteger(releasedIndex)
      && releasedIndex >= 0
      && releasedIndex < BONNI_CORE_INDEX_SLOT_COUNT
      ? releasedIndex
      : Number.isInteger(dropIndex) ? dropIndex : press.sourceIndex;
    setSlots((current) => {
      const next = moveIndexTile(current, press.sourceIndex, targetIndex);
      writeIndexLayout(window.localStorage, storageKey, next);
      return next;
    });
    setDraggingKey("");
    setDropIndex(null);
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  }

  function cancelHold() {
    clearHoldTimer();
    pressRef.current = null;
    setDraggingKey("");
    setDropIndex(null);
  }

  function openTile(event, tile) {
    if (suppressClickRef.current) {
      event.preventDefault();
      return;
    }
    if (tile.key === "control-center") onOpenControlCenter();
    else onOpenTarget(tile.key);
  }

  function moveTileWithKeyboard(event, sourceIndex) {
    if (!event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const columns = viewMode === BONNI_CORE_INDEX_VIEW_MOBILE ? 3 : 6;
    let targetIndex = sourceIndex;
    if (event.key === "ArrowLeft" && sourceIndex % columns > 0) targetIndex -= 1;
    if (event.key === "ArrowRight" && sourceIndex % columns < columns - 1) targetIndex += 1;
    if (event.key === "ArrowUp" && sourceIndex >= columns) targetIndex -= columns;
    if (event.key === "ArrowDown" && sourceIndex + columns < BONNI_CORE_INDEX_SLOT_COUNT) targetIndex += columns;
    if (targetIndex === sourceIndex) return;

    setSlots((current) => {
      const next = moveIndexTile(current, sourceIndex, targetIndex);
      writeIndexLayout(window.localStorage, storageKey, next);
      return next;
    });
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-index-slot="${targetIndex}"] button`)?.focus();
    });
  }

  function toggleViewMode() {
    const nextViewMode = writeIndexViewMode(
      window.localStorage,
      viewStorageKey,
      nextIndexViewMode(viewMode),
    );
    setViewSelection({ storageKey: viewStorageKey, mode: nextViewMode });
  }

  return (
    <main
      className="bonni-launcher"
      data-view-mode={viewMode}
      aria-label={`${branding.displayName} Übersicht`}
    >
      <div className="bonni-launcher__surface">
        <BrandLogo className="bonni-launcher__watermark" decorative />

        <header className="bonni-launcher__topbar">
          <UserPanel
            user={user}
            shell={shell}
            onOpenMembers={onOpenMembers}
            onOpenMySettings={onOpenMySettings}
            onOpenMyDocuments={onOpenMyDocuments}
            onLogout={onLogout}
          />
        </header>

        <section className="bonni-launcher__content" aria-label="Freigeschaltete Bereiche">
          <div className="bonni-launcher__grid" role="list" aria-label="24 App-Positionen">
            {slots.map((tileKey, index) => {
              const tile = tileKey ? tilesByKey.get(tileKey) : null;
              const label = tile ? targetLabel(tile.key, shell, tile.label) : "";
              const isDropTarget = draggingKey && dropIndex === index;

              return (
                <div
                  key={index}
                  className={`bonni-launcher__slot${isDropTarget ? " is-drop-target" : ""}`}
                  data-index-slot={index}
                  role="listitem"
                  aria-label={tile ? `Position ${index + 1}: ${label}` : `Position ${index + 1}: frei`}
                >
                  {tile ? (
                    <button
                      className={`bonni-launcher__tile${draggingKey === tile.key ? " is-dragging" : ""}`}
                      type="button"
                      onClick={(event) => openTile(event, tile)}
                      onPointerDown={(event) => beginHold(event, index, tile.key)}
                      onPointerMove={moveHold}
                      onPointerUp={endHold}
                      onPointerCancel={cancelHold}
                      onKeyDown={(event) => moveTileWithKeyboard(event, index)}
                      aria-label={`${label} öffnen. Zum Verschieben länger gedrückt halten oder Alt plus Pfeiltaste verwenden.`}
                    >
                      <span className="bonni-launcher__tile-icon"><AppIcon tile={tile} /></span>
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      </div>
      <BrandSloganBanner
        compact
        githubUrl="https://github.com/Bonni-Community"
        documentationUrl="/documentation"
        termsUrl="/terms"
        viewMode={viewMode}
        onToggleViewMode={toggleViewMode}
      />
    </main>
  );
}
