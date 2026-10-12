import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { fetchBranding } from "../api/brandingApi.js";
import { DEFAULT_BRANDING, normalizeBranding } from "./brandModel.js";

const BRANDING_CACHE_KEY = "bonni.branding.v1";
const PASSIVE_REVALIDATION_INTERVAL_MS = 5_000;
const BrandContext = createContext(null);

function readCachedBranding() {
  if (typeof window === "undefined") return DEFAULT_BRANDING;
  try {
    const raw = window.localStorage.getItem(BRANDING_CACHE_KEY);
    return raw ? normalizeBranding(JSON.parse(raw)) : DEFAULT_BRANDING;
  } catch {
    return DEFAULT_BRANDING;
  }
}

function cacheBranding(branding) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify(branding));
  } catch {
    // Das eingebettete Standardlogo bleibt auch ohne Browser-Speicher verfügbar.
  }
}

export function BrandProvider({ children }) {
  const [branding, setBranding] = useState(readCachedBranding);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestSequenceRef = useRef(0);
  const controllerRef = useRef(null);
  const requestInFlightRef = useRef(false);
  const lastRefreshStartedAtRef = useRef(0);
  const passiveRevalidationTimerRef = useRef(null);

  const refreshBranding = useCallback(async () => {
    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    requestInFlightRef.current = true;
    lastRefreshStartedAtRef.current = Date.now();
    setLoading(true);
    setError("");
    try {
      const next = normalizeBranding(await fetchBranding({ signal: controller.signal }));
      if (!controller.signal.aborted && requestSequenceRef.current === sequence) {
        setBranding(next);
        cacheBranding(next);
      }
      return next;
    } catch (loadError) {
      if (loadError?.name !== "AbortError" && !controller.signal.aborted) {
        setError(loadError?.message || "Die zentrale Darstellung konnte nicht geladen werden.");
      }
      return null;
    } finally {
      if (requestSequenceRef.current === sequence) {
        requestInFlightRef.current = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  }, []);

  const requestPassiveRevalidation = useCallback(() => {
    const elapsed = Date.now() - lastRefreshStartedAtRef.current;
    const delay = Math.max(0, PASSIVE_REVALIDATION_INTERVAL_MS - elapsed);
    if (!requestInFlightRef.current && delay === 0) {
      void refreshBranding();
      return;
    }
    if (passiveRevalidationTimerRef.current !== null) return;
    passiveRevalidationTimerRef.current = window.setTimeout(() => {
      passiveRevalidationTimerRef.current = null;
      if (!requestInFlightRef.current) void refreshBranding();
    }, Math.max(delay, 250));
  }, [refreshBranding]);

  useEffect(() => {
    refreshBranding();
    return () => {
      controllerRef.current?.abort();
      if (passiveRevalidationTimerRef.current !== null) {
        window.clearTimeout(passiveRevalidationTimerRef.current);
        passiveRevalidationTimerRef.current = null;
      }
    };
  }, [refreshBranding]);

  useEffect(() => {
    function onStorage(event) {
      if (event.storageArea !== window.localStorage || event.key !== BRANDING_CACHE_KEY) return;
      if (event.newValue) {
        try {
          const next = normalizeBranding(JSON.parse(event.newValue));
          setBranding((current) => {
            const currentRevision = Number(current?.revision);
            const nextRevision = Number(next.revision);
            return Number.isSafeInteger(nextRevision)
              && (!Number.isSafeInteger(currentRevision) || nextRevision >= currentRevision)
              ? next
              : current;
          });
        } catch {
          // Beschädigte fremde Cache-Einträge werden nur serverseitig neu validiert.
        }
      }
      requestPassiveRevalidation();
    }

    function onFocus() {
      requestPassiveRevalidation();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") requestPassiveRevalidation();
    }

    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [requestPassiveRevalidation]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const displayName = typeof branding?.displayName === "string"
      ? branding.displayName.trim()
      : "";
    document.title = displayName || DEFAULT_BRANDING.displayName;
  }, [branding?.displayName]);

  const contextValue = useMemo(() => ({
    branding,
    brandingLoading: loading,
    brandingError: error,
    refreshBranding,
  }), [branding, error, loading, refreshBranding]);

  return <BrandContext.Provider value={contextValue}>{children}</BrandContext.Provider>;
}

export function useBranding() {
  return useContext(BrandContext) || {
    branding: DEFAULT_BRANDING,
    brandingLoading: false,
    brandingError: "",
    refreshBranding: async () => DEFAULT_BRANDING,
  };
}
