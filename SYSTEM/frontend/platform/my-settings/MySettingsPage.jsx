import { useEffect, useRef, useState } from "react";

import {
  confirmCurrentTotpEnrollment,
  disableCurrentTwoFactor,
  fetchCurrentTwoFactorStatus,
  regenerateCurrentRecoveryCodes,
  startCurrentTotpEnrollment,
} from "../../core/modules/security/two-factor/api/twoFactorApi.js";
import ExactSecretInput from "../../core/modules/security/two-factor/components/ExactSecretInput.jsx";
import ProviderProofForm from "../../core/modules/security/two-factor/components/ProviderProofForm.jsx";
import RecoveryCodesPanel from "../../core/modules/security/two-factor/components/RecoveryCodesPanel.jsx";
import {
  ENROLLMENT_PASSWORD_MAX_LENGTH,
} from "../../core/modules/security/two-factor/model/exactSecretPolicy.js";
import {
  isCompleteTotpCode,
  retainTotpSetupAfterError,
} from "../../core/modules/security/two-factor/model/enrollmentFlowPolicy.js";
import AccountRecoveryPanel from "../../core/modules/security/identity/components/AccountRecoveryPanel.jsx";
import {
  resetBrandingLogo,
  saveBrandingMetadata,
  uploadBrandingLogo,
} from "../../system/api/brandingApi.js";
import { useBranding } from "../../system/brand/BrandContext.jsx";
import BrandLogo from "../../system/brand/BrandLogo.jsx";
import {
  applyOwnBrandingLogoSuccess,
  applyOwnBrandingMetadataSuccess,
  brandingEditConflictState,
  brandingEditHasConflict,
  brandingEditHasDirtyText,
  brandingFileExpectedRevision,
  brandingTextExpectedRevision,
  changeBrandingText,
  createBrandingEditState,
  discardLocalBrandingEdits,
  observeBrandingRevision,
  selectBrandingEditFile,
} from "../../system/brand/brandingEditState.js";
import {
  brandingErrorMessage,
  classifyBrandingMutationFailure,
  isBrandingRevisionConflict,
} from "../../system/brand/brandingErrorMessages.js";
import MySettingsFrame from "./MySettingsFrame.jsx";
import UserSettingsSection, { USER_SETTINGS_SECTIONS } from "./UserSettingsSections.jsx";
import "./MySettingsPage.css";
import "./BrandSettings.css";
import "./MySettingsOverlay.css";

const EMPTY_SETUP_INPUT = Object.freeze({
  enrollmentPassword: "",
  currentPassword: "",
});

const SETTINGS_FRAME_SECTIONS = Object.freeze(USER_SETTINGS_SECTIONS.map((section) => Object.freeze({
  id: section.key,
  label: section.label,
  subsections: Object.freeze(section.tabs.map((tab) => Object.freeze({
    id: tab.key,
    label: tab.label,
  }))),
})));

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function enrollmentMessage(request) {
  if (!request) return "Ein Administrator muss die Einrichtung zuerst fuer genau dieses Konto freigeben.";
  if (request.status === "EXPIRED") return "Der 2FA-Auftrag ist abgelaufen. Ein Administrator muss ein neues Freigabepasswort erzeugen.";
  if (request.status === "IN_PROGRESS") return "Das Freigabepasswort wurde bereits verbraucht. Wenn der QR-Code nicht mehr in dieser geoeffneten Ansicht sichtbar ist, muss ein Administrator den Auftrag rotieren.";
  return "Der Administrator-Auftrag ist bereit. Verwende das separat erhaltene Freigabepasswort.";
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function canonicalAdminKey(value) {
  return String(value?.key || value || "")
    .trim()
    .toUpperCase()
    .replace(/[.\s-]+/g, "_");
}

function canManageRecoveryPolicy(user, shell) {
  const roles = [
    ...list(user?.roles),
    ...list(user?.permissions?.roles),
    ...list(shell?.identity?.roles),
    ...list(shell?.permissions?.roles),
  ].map(canonicalAdminKey);

  if (roles.some((role) => ["ADMIN", "ADMINISTRATOR", "SYSTEM_ADMIN"].includes(role))) {
    return true;
  }

  return [
    ...list(user?.permissions),
    ...list(user?.permissions?.permissions),
    ...list(shell?.identity?.permissions),
    ...list(shell?.permissions?.permissions),
  ].some((entry) => {
    const raw = String(entry?.key || entry || "").trim();
    return raw === "*" || canonicalAdminKey(raw) === "SYSTEM_ADMIN";
  });
}

export default function MySettingsPage({ token, user, shell, onClose, onSessionRevoked, onSessionInvalidated, onProfileUpdated, appLogoUrl, appLogoAlt }) {
  const {
    branding,
    brandingLoading,
    brandingError: brandingLoadError,
    refreshBranding,
  } = useBranding();
  const [activeTab, setActiveTab] = useState("profile:data");
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [setupInput, setSetupInput] = useState(EMPTY_SETUP_INPUT);
  const setupInputRef = useRef(EMPTY_SETUP_INPUT);
  const [invalidSetupFields, setInvalidSetupFields] = useState({});
  const [totpSetup, setTotpSetup] = useState(null);
  const [confirmationCode, setConfirmationCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [proofAction, setProofAction] = useState("");
  const [sessionRevokedMessage, setSessionRevokedMessage] = useState("");
  const controllerRef = useRef(null);
  const brandingControllerRef = useRef(null);
  const brandingFileInputRef = useRef(null);
  const setupScopeRef = useRef(null);
  const [brandingEdits, setBrandingEdits] = useState(() => createBrandingEditState(branding));
  const [brandingPreviewUrl, setBrandingPreviewUrl] = useState("");
  const [brandingBusy, setBrandingBusy] = useState(false);
  const [brandingReconciling, setBrandingReconciling] = useState(false);
  const [brandingReconciliationNeeded, setBrandingReconciliationNeeded] = useState(false);
  const [brandingError, setBrandingError] = useState("");
  const [brandingNotice, setBrandingNotice] = useState("");
  const accountId = user?.accountId || user?.id || shell?.identity?.accountId || shell?.identity?.id || "";
  const canManageBranding = canManageRecoveryPolicy(user, shell);
  const brandingConflicts = brandingEditConflictState(brandingEdits, branding.revision);
  const brandingEditConflict = brandingEditHasConflict(brandingEdits, branding.revision);
  const brandingEditorBlocked = brandingBusy
    || brandingReconciling
    || brandingReconciliationNeeded
    || brandingLoading
    || Boolean(brandingLoadError);
  const brandingWriteBlocked = brandingEditorBlocked || brandingEditConflict;
  const brandingHasDirtyText = brandingEditHasDirtyText(brandingEdits);
  const brandingDraft = brandingEdits.draft;
  const brandingFile = brandingEdits.file;

  useEffect(() => {
    setBrandingEdits((current) => observeBrandingRevision(current, branding));
  }, [
    branding.revision,
    branding.displayName,
    branding.logoAltText,
  ]);

  useEffect(() => {
    if (!brandingFile) {
      setBrandingPreviewUrl("");
      return undefined;
    }
    const previewUrl = URL.createObjectURL(brandingFile);
    setBrandingPreviewUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [brandingFile]);

  function replaceSetupInput(next) {
    setupInputRef.current = next;
    setSetupInput(next);
  }

  function purgeOneShotState() {
    replaceSetupInput({ ...EMPTY_SETUP_INPUT });
    setInvalidSetupFields({});
    setTotpSetup(null);
    setConfirmationCode("");
    setRecoveryCodes([]);
    setupScopeRef.current = null;
  }

  function finishRevokedSession(message = sessionRevokedMessage) {
    controllerRef.current?.abort();
    purgeOneShotState();
    setProofAction("");
    onSessionRevoked?.(message || "Deine Sitzung wurde nach der Sicherheitsaenderung beendet. Bitte melde dich erneut an.");
  }

  function nextController() {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller;
  }

  async function loadStatus({ quiet = false } = {}) {
    const controller = nextController();
    if (!quiet) setLoading(true);
    setError("");
    try {
      const nextStatus = await fetchCurrentTwoFactorStatus(token, { signal: controller.signal });
      if (!controller.signal.aborted) setStatus(nextStatus);
      return nextStatus;
    } catch (loadError) {
      if (loadError?.name !== "AbortError" && !controller.signal.aborted) {
        setStatus(null);
        setError(loadError?.message || "Der 2FA-Status konnte nicht geladen werden.");
      }
      return null;
    } finally {
      if (!quiet && !controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    loadStatus();
    function purgeOnPageHide() {
      controllerRef.current?.abort();
      purgeOneShotState();
    }
    window.addEventListener("pagehide", purgeOnPageHide);
    function purgeOnScreenshotKey(event) {
      if (event.key === "PrintScreen") purgeOnPageHide();
    }
    window.addEventListener("keydown", purgeOnScreenshotKey);
    return () => {
      window.removeEventListener("pagehide", purgeOnPageHide);
      window.removeEventListener("keydown", purgeOnScreenshotKey);
      controllerRef.current?.abort();
      brandingControllerRef.current?.abort();
      brandingControllerRef.current = null;
      setupInputRef.current = { ...EMPTY_SETUP_INPUT };
    };
  }, [token, accountId]);

  function nextBrandingController() {
    brandingControllerRef.current?.abort();
    const controller = new AbortController();
    brandingControllerRef.current = controller;
    return controller;
  }

  function finishBrandingMutation(controller) {
    if (brandingControllerRef.current !== controller) return;
    brandingControllerRef.current = null;
    setBrandingBusy(false);
  }

  async function reloadBrandingForEditing({ interrupted = false } = {}) {
    if (brandingReconciling) return;
    setBrandingReconciling(true);
    setBrandingError("");
    setBrandingNotice("");
    try {
      const next = await refreshBranding();
      if (!next) throw new Error("Die aktuelle Darstellung konnte nicht vom Server geladen werden.");
      setBrandingReconciliationNeeded(false);
      setBrandingNotice(interrupted
        ? "Der aktuelle Serverstand wurde nach der unterbrochenen Speicheranfrage neu geladen. Bitte prüfe Name, Alternativtext und Logo vor einer weiteren Änderung."
        : "Der aktuelle Serverstand der Darstellung wurde neu geladen.");
    } catch (reloadError) {
      setBrandingReconciliationNeeded(true);
      setBrandingError(brandingErrorMessage(
        reloadError,
        "Der aktuelle Serverstand konnte nicht bestätigt werden. Speichern bleibt gesperrt; bitte erneut laden.",
      ));
    } finally {
      setBrandingReconciling(false);
    }
  }

  async function handleBrandingRevisionConflict(failureSentence) {
    const next = await refreshBranding();
    setBrandingNotice("");
    if (next) {
      setBrandingReconciliationNeeded(false);
      setBrandingError(`Die Darstellung wurde zwischenzeitlich in einer anderen Sitzung geändert. Der aktuelle Serverstand wurde neu geladen. ${failureSentence} Lokale Entwürfe bleiben zur Prüfung sichtbar, können aber erst nach Auflösung des Revisionskonflikts verwendet werden.`);
      return;
    }
    setBrandingReconciliationNeeded(true);
    setBrandingError(`Die Darstellung wurde zwischenzeitlich in einer anderen Sitzung geändert. ${failureSentence} Der aktuelle Serverstand konnte nicht geladen werden; Speichern bleibt gesperrt.`);
  }

  function markBrandingMutationUncertain(actionLabel) {
    setBrandingReconciliationNeeded(true);
    setBrandingNotice("");
    setBrandingError(`Der Ausgang der Anfrage „${actionLabel}“ ist unklar. Die Änderung kann serverseitig bereits wirksam sein. Vor weiteren Änderungen muss der aktuelle Serverstand neu geladen werden.`);
  }

  function selectBrandingFile(event) {
    const file = event.target.files?.[0] || null;
    setBrandingError("");
    setBrandingNotice("");
    if (!file) {
      setBrandingEdits((current) => selectBrandingEditFile(current, null, branding.revision));
      return;
    }
    if (file.type !== "image/png" || file.size <= 0 || file.size > 2 * 1024 * 1024) {
      event.target.value = "";
      setBrandingEdits((current) => selectBrandingEditFile(current, null, branding.revision));
      setBrandingError("Bitte eine gültige PNG-Datei mit höchstens 2 MB auswählen.");
      return;
    }
    setBrandingEdits((current) => selectBrandingEditFile(current, file, branding.revision));
  }

  function updateBrandingDraft(field, value) {
    setBrandingEdits((current) => changeBrandingText(current, field, value, branding.revision));
    setBrandingError("");
    setBrandingNotice("");
  }

  function discardBrandingConflict() {
    setBrandingEdits((current) => discardLocalBrandingEdits(current, branding));
    if (brandingFileInputRef.current) brandingFileInputRef.current.value = "";
    setBrandingError("");
    setBrandingNotice("Der aktuelle Serverstand wurde übernommen. Lokale Textentwürfe und eine ausgewählte Logo-Datei wurden verworfen.");
  }

  async function saveBranding(event) {
    event.preventDefault();
    if (!canManageBranding || brandingWriteBlocked || !brandingHasDirtyText) return;
    const controller = nextBrandingController();
    setBrandingBusy(true);
    setBrandingError("");
    setBrandingNotice("");
    let mutationCompleted = false;
    let requestStarted = false;
    try {
      requestStarted = true;
      await saveBrandingMetadata(token, {
        displayName: brandingDraft.displayName.trim(),
        logoAltText: brandingDraft.logoAltText.trim(),
        expectedRevision: brandingTextExpectedRevision(brandingEdits, branding.revision),
      }, { signal: controller.signal });
      mutationCompleted = true;
      const afterMetadata = await refreshBranding();
      if (!afterMetadata) throw new Error("Die gespeicherte Darstellung konnte nicht neu geladen werden.");
      if (!controller.signal.aborted) {
        setBrandingEdits((current) => applyOwnBrandingMetadataSuccess(current, afterMetadata));
        setBrandingNotice("Name und Alternativtext wurden gespeichert. Das Logo wurde nicht verändert und wird nur über die eigene Upload-Aktion geändert.");
      }
    } catch (saveError) {
      if (!controller.signal.aborted) {
        const failureKind = classifyBrandingMutationFailure(saveError, { requestStarted });
        if (mutationCompleted) {
          markBrandingMutationUncertain("Name und Alternativtext speichern");
        } else if (failureKind === "conflict" || isBrandingRevisionConflict(saveError)) {
          await handleBrandingRevisionConflict("Name und Alternativtext wurden nicht gespeichert.");
        } else if (failureKind === "uncertain") {
          markBrandingMutationUncertain("Name und Alternativtext speichern");
        } else {
          setBrandingError(brandingErrorMessage(
            saveError,
            "Name und Alternativtext konnten nicht gespeichert werden.",
          ));
        }
      }
    } finally {
      finishBrandingMutation(controller);
    }
  }

  async function uploadSelectedBrandingLogo() {
    if (!canManageBranding || brandingWriteBlocked || !brandingFile) return;
    const expectedRevision = brandingFileExpectedRevision(brandingEdits);
    if (expectedRevision === null) return;
    const controller = nextBrandingController();
    setBrandingBusy(true);
    setBrandingError("");
    setBrandingNotice("");
    let mutationCompleted = false;
    let requestStarted = false;
    try {
      requestStarted = true;
      await uploadBrandingLogo(token, brandingFile, expectedRevision, { signal: controller.signal });
      mutationCompleted = true;
      const next = await refreshBranding();
      if (!next) throw new Error("Das gespeicherte Logo konnte nicht neu geladen werden.");
      if (!controller.signal.aborted) {
        setBrandingEdits((current) => applyOwnBrandingLogoSuccess(current, next));
        if (brandingFileInputRef.current) brandingFileInputRef.current.value = "";
        setBrandingNotice(`Das Logo wurde gespeichert. Login und Bonni Core verwenden es sofort; angebundene Apps erhalten es über den zentralen Kontext. ${brandingHasDirtyText ? "Deine ungespeicherten Änderungen an Name oder Alternativtext bleiben im Formular erhalten." : "Name und Alternativtext wurden nicht verändert."}`);
      }
    } catch (uploadError) {
      if (!controller.signal.aborted) {
        const failureKind = classifyBrandingMutationFailure(uploadError, { requestStarted });
        if (mutationCompleted) {
          markBrandingMutationUncertain("Logo hochladen");
        } else if (failureKind === "conflict" || isBrandingRevisionConflict(uploadError)) {
          await handleBrandingRevisionConflict("Das Logo wurde nicht gespeichert.");
        } else if (failureKind === "uncertain") {
          markBrandingMutationUncertain("Logo hochladen");
        } else {
          setBrandingError(`Das Logo wurde nicht gespeichert. ${brandingErrorMessage(
            uploadError,
            "Der PNG-Upload ist fehlgeschlagen.",
          )}`);
        }
      }
    } finally {
      finishBrandingMutation(controller);
    }
  }

  async function restoreDefaultLogo() {
    if (!canManageBranding || brandingWriteBlocked) return;
    const controller = nextBrandingController();
    setBrandingBusy(true);
    setBrandingError("");
    setBrandingNotice("");
    let mutationCompleted = false;
    let requestStarted = false;
    try {
      requestStarted = true;
      await resetBrandingLogo(token, branding.revision, { signal: controller.signal });
      mutationCompleted = true;
      const next = await refreshBranding();
      if (!next) throw new Error("Das Standardlogo konnte nicht neu geladen werden.");
      if (!controller.signal.aborted) {
        setBrandingEdits((current) => applyOwnBrandingLogoSuccess(current, next));
        if (brandingFileInputRef.current) brandingFileInputRef.current.value = "";
        setBrandingNotice(`Das mit Bonni Core gelieferte Standardlogo ist wieder aktiv. ${brandingHasDirtyText ? "Deine ungespeicherten Änderungen an Name oder Alternativtext bleiben im Formular erhalten." : "Name und Alternativtext wurden nicht verändert."}`);
      }
    } catch (resetError) {
      if (!controller.signal.aborted) {
        const failureKind = classifyBrandingMutationFailure(resetError, { requestStarted });
        if (mutationCompleted) {
          markBrandingMutationUncertain("Standardlogo wiederherstellen");
        } else if (failureKind === "conflict" || isBrandingRevisionConflict(resetError)) {
          await handleBrandingRevisionConflict("Das Logo wurde nicht zurückgesetzt.");
        } else if (failureKind === "uncertain") {
          markBrandingMutationUncertain("Standardlogo wiederherstellen");
        } else {
          setBrandingError(brandingErrorMessage(
            resetError,
            "Das Logo konnte nicht zurückgesetzt werden.",
          ));
        }
      }
    } finally {
      finishBrandingMutation(controller);
    }
  }

  useEffect(() => {
    const request = status?.enrollmentRequest;
    if (!request || !["PENDING", "IN_PROGRESS"].includes(request.status)) return undefined;
    const expiresAt = Date.parse(request.expiresAt);
    if (!Number.isFinite(expiresAt)) return undefined;
    const delay = expiresAt - Date.now();
    if (delay <= 0) {
      purgeOneShotState();
      loadStatus({ quiet: true });
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      controllerRef.current?.abort();
      purgeOneShotState();
      setNotice("");
      setError("Der 2FA-Auftrag ist abgelaufen. Ein Administrator muss ihn rotieren.");
      loadStatus({ quiet: true });
    }, Math.min(delay, 2_147_000_000));
    return () => window.clearTimeout(timeout);
  }, [status?.enrollmentRequest?.id, status?.enrollmentRequest?.status, status?.enrollmentRequest?.expiresAt]);

  useEffect(() => {
    const nextScope = `${token}:${accountId}:${status?.enrollmentRequest?.id || "none"}`;
    const previousScope = setupScopeRef.current?.scopeKey;
    if (previousScope && previousScope !== nextScope) {
      controllerRef.current?.abort();
      purgeOneShotState();
    }
  }, [token, accountId, status?.enrollmentRequest?.id]);

  function updateSetupInput(name, value) {
    replaceSetupInput({ ...setupInputRef.current, [name]: value });
  }

  async function startEnrollment(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (Object.values(invalidSetupFields).some((valid) => valid === false)) {
      purgeOneShotState();
      setError("Bitte beide Passwoerter erneut eingeben.");
      return;
    }
    const requestId = status?.enrollmentRequest?.id;
    if (!requestId) {
      purgeOneShotState();
      setError("Es liegt kein gueltiger Administrator-Auftrag vor.");
      return;
    }
    if (status.enrollmentRequest.status !== "PENDING" || Date.parse(status.enrollmentRequest.expiresAt) <= Date.now()) {
      purgeOneShotState();
      setError("Der 2FA-Auftrag ist nicht mehr frisch. Ein Administrator muss ihn rotieren.");
      loadStatus({ quiet: true });
      return;
    }

    const payload = {
      enrollmentRequestId: requestId,
      enrollmentPassword: setupInputRef.current.enrollmentPassword,
      currentPassword: setupInputRef.current.currentPassword,
    };
    replaceSetupInput({ ...EMPTY_SETUP_INPUT });
    setInvalidSetupFields({});
    setBusy(true);
    const controller = nextController();
    try {
      const result = await startCurrentTotpEnrollment(token, payload, { signal: controller.signal });
      if (!controller.signal.aborted) {
        setTotpSetup(result);
        setupScopeRef.current = {
          scopeKey: `${token}:${accountId}:${requestId}`,
          requestId,
          accountId,
          token,
          expiresAt: status.enrollmentRequest.expiresAt,
        };
        setNotice("Der persoenliche QR-Code wurde erzeugt. Er ist nur in dieser Ansicht sichtbar.");
      }
    } catch (setupError) {
      purgeOneShotState();
      if (setupError?.name !== "AbortError" && !controller.signal.aborted) {
        const message = setupError?.message || "Die TOTP-Einrichtung konnte nicht gestartet werden.";
        setBusy(false);
        await loadStatus({ quiet: true });
        setError(message);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function updateConfirmationCode(value) {
    if (typeof value !== "string" || value.length > 8 || !/^\d*$/.test(value)) {
      setConfirmationCode("");
      setError("Der Authenticator-Code darf nur aus 6 oder 8 Ziffern bestehen.");
      return;
    }
    setError("");
    setConfirmationCode(value);
  }

  async function confirmEnrollment(event) {
    event.preventDefault();
    if (!totpSetup || !status?.enrollmentRequest?.id) return;
    if (!isCompleteTotpCode(confirmationCode)) {
      setError("Bitte den vollstaendigen sechs- oder achtstelligen Authenticator-Code eingeben.");
      return;
    }
    const liveScope = setupScopeRef.current;
    const expectedScope = `${token}:${accountId}:${status.enrollmentRequest.id}`;
    if (
      !liveScope
      || liveScope.scopeKey !== expectedScope
      || liveScope.token !== token
      || liveScope.accountId !== accountId
      || Date.parse(liveScope.expiresAt) <= Date.now()
    ) {
      purgeOneShotState();
      setError("Der QR-Code gehoert nicht mehr zum aktuellen, frischen Auftrag. Der Administrator muss den Auftrag rotieren.");
      loadStatus({ quiet: true });
      return;
    }
    const payload = {
      enrollmentRequestId: status.enrollmentRequest.id,
      credentialId: totpSetup.credentialId,
      code: confirmationCode,
    };
    setConfirmationCode("");
    setError("");
    setNotice("");
    setBusy(true);
    const controller = nextController();
    try {
      const result = await confirmCurrentTotpEnrollment(token, payload, { signal: controller.signal });
      if (controller.signal.aborted) return;
      onSessionInvalidated?.();
      setTotpSetup(null);
      setupScopeRef.current = null;
      setRecoveryCodes(result.recoveryCodes);
      setNotice(result.alreadyConfirmed
        ? "Die Authenticator-App war bereits bestaetigt. Alte Wiederherstellungscodes werden nicht erneut angezeigt."
        : "Die Zwei-Faktor-Authentifizierung ist jetzt aktiv.");
      const revokedMessage = "2FA wurde aktiviert und deine bisherige Sitzung aus Sicherheitsgruenden beendet. Bitte melde dich erneut an.";
      setSessionRevokedMessage(revokedMessage);
      setBusy(false);
      if (result.alreadyConfirmed || !result.recoveryCodes.length) finishRevokedSession(revokedMessage);
    } catch (confirmError) {
      if (confirmError?.name !== "AbortError" && !controller.signal.aborted) {
        const recoverable = retainTotpSetupAfterError(confirmError);
        const message = confirmError?.message || "Der Authenticator-Code wurde nicht akzeptiert.";
        if (recoverable) {
          setConfirmationCode("");
          setBusy(false);
          setError(`${message} Der persoenliche QR-Code bleibt bis zum Ablauf dieses Auftrags sichtbar.`);
          return;
        }
        purgeOneShotState();
        setBusy(false);
        await loadStatus({ quiet: true });
        setError(`${message} Der Zustand ist nicht eindeutig; ein Administrator muss den Auftrag bei Bedarf rotieren.`);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function runProofAction(proof) {
    setError("");
    setNotice("");
    setBusy(true);
    const controller = nextController();
    try {
      if (proofAction === "recovery") {
        const result = await regenerateCurrentRecoveryCodes(token, proof, { signal: controller.signal });
        if (!controller.signal.aborted) {
          onSessionInvalidated?.();
          setRecoveryCodes(result.recoveryCodes);
          setNotice("Neue Wiederherstellungscodes wurden erzeugt. Die bisherigen Codes sind ungueltig.");
          setSessionRevokedMessage("Die Recoverycodes wurden erneuert und deine bisherige Sitzung beendet. Speichere die neuen Codes und melde dich danach erneut an.");
        }
      } else if (proofAction === "disable") {
        await disableCurrentTwoFactor(token, proof, { signal: controller.signal });
        if (!controller.signal.aborted) {
          onSessionInvalidated?.();
          purgeOneShotState();
          setBusy(false);
          finishRevokedSession("2FA wurde deaktiviert und deine bisherige Sitzung beendet. Bitte melde dich erneut an.");
        }
      }
      if (!controller.signal.aborted) setProofAction("");
    } catch (actionError) {
      purgeOneShotState();
      setProofAction("");
      if (actionError?.name !== "AbortError" && !controller.signal.aborted) {
        setError(actionError?.message || "Die Sicherheitsaktion wurde nicht ausgefuehrt.");
      }
      throw actionError;
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function close() {
    if (sessionRevokedMessage) {
      finishRevokedSession();
      return;
    }
    controllerRef.current?.abort();
    if (brandingControllerRef.current) {
      brandingControllerRef.current.abort();
      brandingControllerRef.current = null;
      void refreshBranding();
    }
    purgeOneShotState();
    setProofAction("");
    onClose?.();
  }

  function selectTab(nextTab) {
    if (nextTab === activeTab) return;
    controllerRef.current?.abort();
    if (brandingControllerRef.current) {
      const interruptedBrandingController = brandingControllerRef.current;
      brandingControllerRef.current = null;
      setBrandingBusy(false);
      setBrandingReconciliationNeeded(true);
      setBrandingError("");
      setBrandingNotice("");
      interruptedBrandingController.abort();
    }
    purgeOneShotState();
    setProofAction("");
    setError("");
    setNotice("");
    setActiveTab(nextTab);
    if (nextTab === "security:two-factor") loadStatus();
    if (nextTab === "profile:image" && brandingReconciliationNeeded) {
      void reloadBrandingForEditing({ interrupted: true });
    }
  }

  const [activeSection, activeSubsection] = activeTab.split(":");

  function selectSection(sectionId) {
    const nextSection = USER_SETTINGS_SECTIONS.find((section) => section.key === sectionId);
    const firstTab = nextSection?.tabs?.[0]?.key;
    if (firstTab) selectTab(`${sectionId}:${firstTab}`);
  }

  function selectSubsection(subsectionId) {
    selectTab(`${activeSection}:${subsectionId}`);
  }

  const request = status?.enrollmentRequest;
  const expectedSetupScope = `${token}:${accountId}:${request?.id || "none"}`;
  const liveTotpSetup = totpSetup
    && setupScopeRef.current?.scopeKey === expectedSetupScope
    && setupScopeRef.current?.token === token
    && setupScopeRef.current?.accountId === accountId
    && Date.parse(setupScopeRef.current?.expiresAt) > Date.now()
      ? totpSetup
      : null;
  const localEnrollment = status?.provider?.externallyManaged !== true;
  const localRecoveryCodes = status?.provider?.id === "local"
    && status?.provider?.externallyManaged !== true;
  const canStartEnrollment = !status?.enabled
    && !sessionRevokedMessage
    && localEnrollment
    && request
    && request.status === "PENDING"
    && Date.parse(request.expiresAt) > Date.now();

  return (
    <MySettingsFrame
      user={user}
      shell={shell}
      activeSection={activeSection}
      activeSubsection={activeSubsection}
      sections={SETTINGS_FRAME_SECTIONS}
      onSelectSection={selectSection}
      onSelectSubsection={selectSubsection}
      onClose={close}
      appLogoUrl={appLogoUrl}
      appLogoAlt={appLogoAlt}
    >
      <UserSettingsSection
        activeKey={activeTab}
        token={token}
        user={user}
        shell={shell}
        onSessionRevoked={onSessionRevoked}
        onSessionInvalidated={onSessionInvalidated}
        onProfileUpdated={onProfileUpdated}
        brandingPanel={(
            <form className="bonni-brand-settings" onSubmit={saveBranding}>
              <div className="bonni-my-settings__heading">
                <div><p className="bonni-2fa-eyebrow">Zentrale Darstellung</p><h2>Logo und sichtbarer Name</h2><p>Diese Darstellung gilt sofort im Login und in Bonni Core. Angebundene Apps erhalten sie als zentralen Kontext und müssen ihn in ihrer jeweiligen App-Version verwenden.</p></div>
                <span className={`bonni-2fa-status${canManageBranding && !brandingWriteBlocked ? " is-active" : ""}`}>{brandingLoading ? "Wird geladen" : canManageBranding ? brandingWriteBlocked ? "Gesperrt" : "Bearbeitbar" : "Nur Ansicht"}</span>
              </div>

              {brandingError ? <p className="bonni-2fa-alert is-error" role="alert">{brandingError}</p> : null}
              {brandingLoadError && !brandingError ? <p className="bonni-2fa-alert is-error" role="alert">Die aktuelle Darstellung konnte nicht bestätigt werden. Speichern bleibt gesperrt, bis der Serverstand neu geladen wurde.</p> : null}
              {brandingNotice ? <p className="bonni-2fa-alert is-success" role="status">{brandingNotice}</p> : null}
              {brandingLoading && !brandingReconciliationNeeded ? <p className="bonni-brand-settings__loading" role="status">Der aktuelle Serverstand der Darstellung wird geladen. Änderungen sind bis dahin gesperrt.</p> : null}
              {brandingReconciliationNeeded ? (
                <div className="bonni-brand-settings__reconcile" role="status">
                  <p>{brandingReconciling ? "Der aktuelle Serverstand wird nach einer unterbrochenen Anfrage neu geladen …" : "Eine unterbrochene Anfrage kann serverseitig bereits abgeschlossen sein. Vor weiteren Änderungen muss der aktuelle Stand neu geladen werden."}</p>
                  {!brandingReconciling ? <button type="button" onClick={() => reloadBrandingForEditing({ interrupted: true })}>Aktuellen Serverstand neu laden</button> : null}
                </div>
              ) : brandingLoadError ? (
                <div className="bonni-brand-settings__reconcile"><button type="button" onClick={() => reloadBrandingForEditing()}>Darstellung erneut laden</button></div>
              ) : null}
              {brandingEditConflict ? (
                <div className="bonni-brand-settings__revision-conflict" role="alert">
                  <div>
                    <strong>Die zentrale Darstellung wurde parallel geändert.</strong>
                    <p>{brandingConflicts.text && brandingConflicts.file
                      ? "Dein Textentwurf und die ausgewählte Logo-Datei gehören zu einer älteren Revision. Speichern und Upload bleiben gesperrt."
                      : brandingConflicts.text
                        ? "Dein Textentwurf gehört zu einer älteren Revision. Speichern und Logoaktionen bleiben gesperrt."
                        : "Die ausgewählte Logo-Datei gehört zu einer älteren Revision. Der Upload bleibt gesperrt."}</p>
                  </div>
                  <button type="button" onClick={discardBrandingConflict}>Lokale Entwürfe verwerfen und Serverstand übernehmen</button>
                </div>
              ) : null}

              <section className="bonni-2fa-card bonni-brand-settings__editor">
                <div>
                  <p className="bonni-2fa-eyebrow">Eine Quelle für das ganze System</p>
                  <h3>Aktives Erscheinungsbild</h3>
                  <p>Bonni Core verwendet diese Quelle direkt. Angebundene Apps bekommen den Branding-Kontext zentral bereitgestellt; sichtbar wird er dort, sobald die jeweilige App-Version ihn verwendet.</p>
                </div>
                <div className="bonni-brand-settings__fields">
                  <label className="bonni-2fa-field"><span>Sichtbarer Name</span><input value={brandingDraft.displayName} onChange={(event) => updateBrandingDraft("displayName", event.target.value)} maxLength={120} required disabled={!canManageBranding || brandingEditorBlocked} /></label>
                  <label className="bonni-2fa-field"><span>Alternativtext des Logos</span><input value={brandingDraft.logoAltText} onChange={(event) => updateBrandingDraft("logoAltText", event.target.value)} maxLength={180} required disabled={!canManageBranding || brandingEditorBlocked} /><small>Wird von Vorleseprogrammen verwendet, wenn das Logo nicht nur dekorativ ist.</small></label>
                  {brandingHasDirtyText ? <p className="bonni-brand-settings__draft-note" role="status">Ungespeicherte Änderungen an Name oder Alternativtext bleiben bei Logo-Upload und Logo-Reset erhalten.</p> : null}
                  <div className="bonni-brand-settings__upload"><label><span>Neues Logo als PNG</span><input ref={brandingFileInputRef} type="file" accept="image/png,.png" onChange={selectBrandingFile} disabled={!canManageBranding || brandingEditorBlocked} /></label><small>Maximal 2 MB und 2048 × 2048 Pixel. Das Seitenverhältnis bleibt unverändert. Der Upload ist bewusst vom Speichern des Namens getrennt.</small><button type="button" onClick={uploadSelectedBrandingLogo} disabled={!canManageBranding || brandingWriteBlocked || !brandingFile}>Ausgewähltes Logo hochladen</button></div>
                </div>
              </section>

              <section className="bonni-2fa-card bonni-brand-settings__previews" aria-label="Logo-Vorschau">
                <header><div><p className="bonni-2fa-eyebrow">Vorschau</p><h3>Hell, dunkel und kompakt</h3></div><small>Revision {branding.revision}</small></header>
                <div>
                  {["light", "dark", "compact"].map((surface) => (
                    <figure className={`bonni-brand-preview is-${surface}`} key={surface}>
                      {brandingPreviewUrl
                        ? <img src={brandingPreviewUrl} alt={brandingDraft.logoAltText || "Logo-Vorschau"} />
                        : <BrandLogo alt={brandingDraft.logoAltText} />}
                      <figcaption>{surface === "light" ? "Helle Fläche" : surface === "dark" ? "Dunkle Fläche" : "Kompakte Verwendung"}<strong>{brandingDraft.displayName || branding.displayName}</strong></figcaption>
                    </figure>
                  ))}
                </div>
              </section>

              {!canManageBranding ? <p className="bonni-brand-settings__admin-note">Nur Administratoren dürfen die zentrale Darstellung verändern.</p> : null}
              <div className="bonni-2fa-actions">
                <button type="button" onClick={restoreDefaultLogo} disabled={!canManageBranding || brandingWriteBlocked}>Standardlogo wiederherstellen</button>
                <button type="submit" className="is-primary" disabled={!canManageBranding || brandingWriteBlocked || !brandingHasDirtyText || !brandingDraft.displayName.trim() || !brandingDraft.logoAltText.trim()}>{brandingBusy ? "Wird gespeichert …" : "Name und Alternativtext speichern"}</button>
              </div>
            </form>
        )}
        recoveryPanel={(
            <AccountRecoveryPanel
              token={token}
              canManagePolicy={canManageRecoveryPolicy(user, shell)}
            />
        )}
        twoFactorPanel={(
            <>
          <div className="bonni-my-settings__heading">
            <div><p className="bonni-2fa-eyebrow">Kontosicherheit</p><h2>Zwei-Faktor-Authentifizierung (2FA)</h2><p>Schuetzt die Anmeldung und sensible Bereiche zusaetzlich zum Passwort.</p></div>
            <span className={`bonni-2fa-status${status?.enabled ? " is-active" : ""}`}>
              {loading ? "Wird geprueft" : status?.enabled ? "Aktiv" : "Nicht aktiv"}
            </span>
          </div>

          {error ? <p className="bonni-2fa-alert is-error" role="alert">{error}</p> : null}
          {notice ? <p className="bonni-2fa-alert is-success" role="status">{notice}</p> : null}
          {sessionRevokedMessage ? <p className="bonni-2fa-alert is-warning" role="status">{sessionRevokedMessage}</p> : null}

          {loading ? <section className="bonni-2fa-card">Sicherheitsstatus wird geladen …</section> : null}

          {!loading && status ? (
            <>
              <section className="bonni-2fa-card bonni-2fa-overview">
                <div className="bonni-2fa-overview__icon" aria-hidden="true">✓</div>
                <div>
                  <h3>{status.enabled ? "Dein Konto ist mit 2FA geschuetzt" : "2FA ist fuer dein Konto noch nicht aktiv"}</h3>
                  <p>{status.enabled
                    ? `Anbieter: ${status.provider.label}. Bei der Anmeldung wird ein zweiter Nachweis verlangt.`
                    : enrollmentMessage(request)}</p>
                </div>
                <dl>
                  <div><dt>Anbieter</dt><dd>{status.provider.label}</dd></div>
                  <div><dt>Sicherheitsabfrage gueltig</dt><dd>{status.challengeExpiresSeconds} Sekunden</dd></div>
                  <div><dt>Versuche</dt><dd>{status.maxAttempts}</dd></div>
                  <div><dt>Recoverycodes</dt><dd>{status.unusedRecoveryCodeCount}</dd></div>
                </dl>
              </section>

              {!status.enabled && request ? (
                <section className="bonni-2fa-card bonni-2fa-request">
                  <div><p className="bonni-2fa-eyebrow">Administrator-Auftrag</p><h3>{request.status === "EXPIRED" ? "Abgelaufen" : "Zur Einrichtung freigegeben"}</h3></div>
                  <dl><div><dt>Erstellt</dt><dd>{formatDateTime(request.requestedAt)}</dd></div><div><dt>Gueltig bis</dt><dd>{formatDateTime(request.expiresAt)}</dd></div></dl>
                </section>
              ) : null}

              {canStartEnrollment && !liveTotpSetup ? (
                <form className="bonni-2fa-card bonni-2fa-enrollment-form" onSubmit={startEnrollment}>
                  <div><p className="bonni-2fa-eyebrow">Schritt 1 von 2</p><h3>Persoenlichen QR-Code anfordern</h3><p>Gib beide Passwoerter exakt ein. Bonni speichert sie nicht im Browser.</p></div>
                  <div className="bonni-2fa-form-grid">
                    <ExactSecretInput
                      value={setupInput.enrollmentPassword}
                      onChange={(value) => updateSetupInput("enrollmentPassword", value)}
                      onValidityChange={(valid) => setInvalidSetupFields((current) => ({ ...current, enrollmentPassword: valid }))}
                      label="Freigabepasswort vom Administrator"
                      maxLength={ENROLLMENT_PASSWORD_MAX_LENGTH}
                      autoComplete="off"
                      disabled={busy}
                    />
                    <ExactSecretInput
                      value={setupInput.currentPassword}
                      onChange={(value) => updateSetupInput("currentPassword", value)}
                      onValidityChange={(valid) => setInvalidSetupFields((current) => ({ ...current, currentPassword: valid }))}
                      label="Dein aktuelles Passwort"
                      autoComplete="current-password"
                      disabled={busy}
                    />
                  </div>
                  <div className="bonni-2fa-actions"><button type="submit" className="is-primary" disabled={busy}>Persoenlichen QR-Code erzeugen</button></div>
                </form>
              ) : null}

              {liveTotpSetup ? (
                <form className="bonni-2fa-card bonni-2fa-qr" onSubmit={confirmEnrollment}>
                  <div className="bonni-2fa-qr__image"><img src={liveTotpSetup.qrCodeDataUrl} alt="Persoenlicher QR-Code fuer die Authenticator-App" /></div>
                  <div>
                    <p className="bonni-2fa-eyebrow">Schritt 2 von 2</p>
                    <h3>QR-Code scannen und bestaetigen</h3>
                    <ol><li>Authenticator-App auf deinem eigenen Geraet oeffnen.</li><li>QR-Code scannen.</li><li>Den angezeigten sechs- oder achtstelligen Code unten eingeben.</li></ol>
                    <p className="bonni-2fa-warning"><strong>Nicht fotografieren oder weitergeben.</strong> Der QR-Code enthaelt deinen persoenlichen 2FA-Schluessel.</p>
                    <label className="bonni-2fa-field"><span>Authenticator-Code</span><input value={confirmationCode} onChange={(event) => updateConfirmationCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required disabled={busy} /></label>
                    <div className="bonni-2fa-actions"><button type="button" onClick={purgeOneShotState} disabled={busy}>Abbrechen</button><button type="submit" className="is-primary" disabled={busy || !isCompleteTotpCode(confirmationCode)}>2FA aktivieren</button></div>
                  </div>
                </form>
              ) : null}

              {status.enabled && !proofAction && !sessionRevokedMessage ? (
                <section className="bonni-2fa-card">
                  <p className="bonni-2fa-eyebrow">Verwaltung</p><h3>Aktive Zwei-Faktor-Authentifizierung</h3>
                  <p>{localRecoveryCodes
                    ? "Neue Wiederherstellungscodes machen alle noch unbenutzten bisherigen Codes ungueltig."
                    : "Wiederherstellung und Geraeteverwaltung erfolgen beim externen 2FA-Anbieter. Bonni Core verwaltet nur die kontogenaue Verknuepfung."}</p>
                  <div className="bonni-2fa-actions">{localRecoveryCodes ? <button type="button" onClick={() => { setRecoveryCodes([]); setProofAction("recovery"); }}>Recoverycodes neu erzeugen</button> : null}<button type="button" className="is-danger" onClick={() => { setRecoveryCodes([]); setProofAction("disable"); }}>{localRecoveryCodes ? "2FA deaktivieren" : "Externe 2FA-Verknuepfung deaktivieren"}</button></div>
                </section>
              ) : null}

              {status.enabled && proofAction && !sessionRevokedMessage ? (
                <section className="bonni-2fa-card">
                  <p className="bonni-2fa-eyebrow">Erneute Bestaetigung</p>
                  <h3>{proofAction === "disable" ? (localRecoveryCodes ? "2FA wirklich deaktivieren" : "Externe 2FA-Verknuepfung wirklich deaktivieren") : "Neue Recoverycodes erzeugen"}</h3>
                  <ProviderProofForm
                    provider={status.provider}
                    proofFields={status.provider.proofFields}
                    recoveryAllowed={status.provider.id === "local"}
                    busy={busy}
                    submitLabel={proofAction === "disable" ? "2FA deaktivieren" : "Neue Codes erzeugen"}
                    onVerify={runProofAction}
                    onCancel={() => setProofAction("")}
                  />
                </section>
              ) : null}

              <RecoveryCodesPanel
                codes={recoveryCodes}
                onDismiss={() => sessionRevokedMessage ? finishRevokedSession() : setRecoveryCodes([])}
                dismissLabel={sessionRevokedMessage ? "Sicher gespeichert und neu anmelden" : undefined}
              />

              {sessionRevokedMessage && !recoveryCodes.length ? (
                <section className="bonni-2fa-card">
                  <h3>Erneute Anmeldung erforderlich</h3>
                  <p>Die alte Sitzung wird nicht fuer weitere Statusabfragen verwendet.</p>
                  <div className="bonni-2fa-actions"><button type="button" className="is-primary" onClick={() => finishRevokedSession()}>Jetzt neu anmelden</button></div>
                </section>
              ) : null}

              <section className="bonni-2fa-card bonni-2fa-guide">
                <p className="bonni-2fa-eyebrow">Kurzanleitung</p><h3>So wird 2FA eingerichtet</h3>
                <ol><li><span>1</span><div><strong>Administrator beauftragt 2FA</strong><p>Der Auftrag gilt nur fuer dein genaues Konto.</p></div></li><li><span>2</span><div><strong>Freigabepasswort getrennt erhalten</strong><p>Der Administrator uebermittelt es ueber einen anderen Weg.</p></div></li><li><span>3</span><div><strong>Beide Passwoerter eingeben</strong><p>Freigabepasswort und eigenes aktuelles Passwort werden gemeinsam geprueft.</p></div></li><li><span>4</span><div><strong>QR-Code selbst scannen</strong><p>Nur du siehst den persoenlichen QR-Code.</p></div></li><li><span>5</span><div><strong>Recoverycodes sichern</strong><p>Sie werden nach erfolgreicher Aktivierung genau einmal angezeigt.</p></div></li></ol>
              </section>
            </>
          ) : null}
            </>
        )}
      />
    </MySettingsFrame>
  );
}
