import React, { useCallback, useEffect, useRef, useState } from "react";

import ExactSecretInput from "../../two-factor/components/ExactSecretInput.jsx";
import BrandName from "../../../../../system/brand/BrandName.jsx";
import {
  countUnicodeCodePoints,
  LOCAL_PASSWORD_MAX_LENGTH,
  validateExactSecret,
} from "../../two-factor/model/exactSecretPolicy.js";
import "./PasswordRecoveryFlow.css";

export const PASSWORD_RECOVERY_NEUTRAL_MESSAGE = "Die Passwort-Wiederherstellung wurde angefordert. Bitte wenden Sie sich an den Support.";

const EMPTY_PASSWORDS = Object.freeze({
  newPassword: "",
  repeatedPassword: "",
});

const PUBLIC_RECOVERY_STATUSES = new Set(["NONE", "PENDING", "APPROVED", "EXPIRED"]);
const RECOVERY_REFERENCE = /^PR-[A-Z2-9]{5}-[A-Z2-9]{5}$/u;

function assertPublicStatus(result) {
  if (!result || typeof result !== "object" || !PUBLIC_RECOVERY_STATUSES.has(result.status)) {
    throw new Error("Der Wiederherstellungsstatus ist nicht eindeutig.");
  }
  if (result.status === "NONE" && result.reference !== null) {
    throw new Error("Ein leerer Status darf keine Vorgangsnummer enthalten.");
  }
  if (result.status !== "NONE" && !RECOVERY_REFERENCE.test(result.reference || "")) {
    throw new Error("Die Vorgangsnummer ist nicht eindeutig.");
  }
  if (
    typeof result.supportCodeAllowed !== "boolean"
    || (result.status === "NONE" && result.supportCodeAllowed !== true)
    || (result.status !== "NONE" && result.supportCodeAllowed !== false)
  ) throw new Error("Der Support-Code-Status ist nicht eindeutig.");
  return result;
}

function statusPhase(result) {
  const normalized = assertPublicStatus(result);
  const status = normalized.status;
  if (status === "PENDING") return "pending";
  if (status === "APPROVED") return "approved";
  return "request";
}

function assertRequestResult(result) {
  if (
    !result
    || typeof result !== "object"
    || result.status !== "REQUESTED"
    || !RECOVERY_REFERENCE.test(result.reference || "")
  ) {
    throw new Error("Der Wiederherstellungsauftrag wurde nicht eindeutig bestätigt.");
  }
  return result;
}

function assertCompletionResult(result) {
  if (
    !result
    || typeof result !== "object"
    || result.status !== "COMPLETED"
    || result.requiresFreshLogin !== true
  ) throw new Error("Der Abschlussvertrag der Wiederherstellung ist ungültig.");
  return result;
}

/**
 * Public, provider-neutral Core UI. The injected API is deliberately the only
 * transport dependency until the native backend contract is frozen.
 */
export default function PasswordRecoveryFlow({
  active,
  loginName,
  api,
  onActiveChange,
}) {
  const [phase, setPhase] = useState("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [passwords, setPasswords] = useState(EMPTY_PASSWORDS);
  const [supportCode, setSupportCode] = useState("");
  const [supportCodeMode, setSupportCodeMode] = useState(false);
  const [reference, setReference] = useState(null);
  const passwordsRef = useRef(EMPTY_PASSWORDS);
  const supportCodeRef = useRef("");
  const inputNodesRef = useRef(new Map());
  const controllerRef = useRef(null);
  const activePayloadsRef = useRef(new Set());
  const mountedRef = useRef(true);

  const purgeDomAndRefs = useCallback(() => {
    for (const node of inputNodesRef.current.values()) {
      if (node) node.value = "";
    }
    passwordsRef.current = EMPTY_PASSWORDS;
    supportCodeRef.current = "";
    for (const payload of activePayloadsRef.current) {
      if (!payload || typeof payload !== "object") continue;
      if (Object.hasOwn(payload, "supportCode")) payload.supportCode = undefined;
      if (Object.hasOwn(payload, "newPassword")) payload.newPassword = undefined;
      if (Object.hasOwn(payload, "newPasswordConfirmation")) payload.newPasswordConfirmation = undefined;
    }
  }, []);

  const purgePasswords = useCallback(() => {
    purgeDomAndRefs();
    if (mountedRef.current) setPasswords({ ...EMPTY_PASSWORDS });
    if (mountedRef.current) setSupportCode("");
  }, [purgeDomAndRefs]);

  const abortAndPurge = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    purgePasswords();
  }, [purgePasswords]);

  function nextController() {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller;
  }

  function replacePasswords(next) {
    passwordsRef.current = next;
    setPasswords(next);
  }

  function replaceSupportCode(next) {
    supportCodeRef.current = next;
    setSupportCode(next);
  }

  useEffect(() => {
    mountedRef.current = true;
    const controller = nextController();
    Promise.resolve()
      .then(() => api.getStatus({ signal: controller.signal }))
      .then((result) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        const nextPhase = statusPhase(result);
        setPhase(nextPhase);
        setReference(result.reference);
        if (nextPhase !== "request") onActiveChange(true);
      })
      .catch((statusError) => {
        if (statusError?.name === "AbortError" || controller.signal.aborted || !mountedRef.current) return;
        setPhase("request");
        // A missing/invalid contract must never disclose whether an account
        // exists and must not silently invent a recovery state.
        setError("Die Passwort-Wiederherstellung ist derzeit nicht verfügbar.");
      });

    const handlePageHide = () => abortAndPurge();
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("pagehide", handlePageHide);
      controllerRef.current?.abort();
      controllerRef.current = null;
      purgeDomAndRefs();
      inputNodesRef.current.clear();
    };
  }, [api, abortAndPurge, onActiveChange, purgeDomAndRefs]);

  function cancel() {
    abortAndPurge();
    setBusy(false);
    setError("");
    setNotice("");
    setPhase((current) => current === "completed" ? "request" : current);
    if (phase === "completed") setReference(null);
    onActiveChange(false);
  }

  async function requestRecovery(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const controller = nextController();
    try {
      const result = assertRequestResult(await api.request(loginName, { signal: controller.signal }));
      if (controller.signal.aborted || !mountedRef.current) return;
      setPhase("pending");
      setReference(result.reference);
      setNotice(PASSWORD_RECOVERY_NEUTRAL_MESSAGE);
    } catch (requestError) {
      if (requestError?.name !== "AbortError" && !controller.signal.aborted && mountedRef.current) {
        setError("Die Passwort-Wiederherstellung konnte nicht angefordert werden.");
      }
    } finally {
      if (mountedRef.current && controllerRef.current === controller) setBusy(false);
    }
  }


  async function resumeWithSupportCode(event) {
    event.preventDefault();
    if (busy) return;
    const payload = { supportCode: supportCodeRef.current };
    purgePasswords();
    activePayloadsRef.current.add(payload);
    setBusy(true);
    setError("");
    setNotice("");
    const controller = nextController();
    try {
      const result = assertPublicStatus(await api.resume(payload, { signal: controller.signal }));
      payload.supportCode = undefined;
      if (controller.signal.aborted || !mountedRef.current) return;
      if (result.status !== "APPROVED" || result.supportCodeAllowed !== false) {
        throw new Error("Der Support-Code wurde nicht eindeutig bestätigt.");
      }
      setSupportCodeMode(false);
      setReference(result.reference);
      setPhase("approved");
    } catch (resumeError) {
      payload.supportCode = undefined;
      if (resumeError?.name !== "AbortError" && !controller.signal.aborted && mountedRef.current) {
        setError("Der Support-Code konnte nicht bestätigt werden.");
      }
    } finally {
      payload.supportCode = undefined;
      activePayloadsRef.current.delete(payload);
      if (mountedRef.current && controllerRef.current === controller) setBusy(false);
    }
  }

  async function refreshStatus() {
    if (busy) return;
    setBusy(true);
    setError("");
    const controller = nextController();
    try {
      const result = assertPublicStatus(await api.getStatus({ signal: controller.signal }));
      if (controller.signal.aborted || !mountedRef.current) return;
      setReference(result.reference);
      setPhase(statusPhase(result));
    } catch (statusError) {
      if (statusError?.name !== "AbortError" && !controller.signal.aborted && mountedRef.current) {
        setError("Der Wiederherstellungsstatus konnte nicht geladen werden.");
      }
    } finally {
      if (mountedRef.current && controllerRef.current === controller) setBusy(false);
    }
  }

  async function submitNewPassword(event) {
    event.preventDefault();
    if (busy) return;
    let passwordProof = passwordsRef.current.newPassword;
    let repeatedProof = passwordsRef.current.repeatedPassword;
    const passwordError = validateExactSecret(passwordProof, {
      label: "Das neue Passwort",
      maxLength: LOCAL_PASSWORD_MAX_LENGTH,
    });
    const repeatedError = validateExactSecret(repeatedProof, {
      label: "Die Passwort-Wiederholung",
      maxLength: LOCAL_PASSWORD_MAX_LENGTH,
    });
    const passwordTooShort = typeof passwordProof === "string" && countUnicodeCodePoints(passwordProof) < 12;
    if (passwordError || repeatedError || passwordTooShort || passwordProof !== repeatedProof) {
      purgePasswords();
      setError(passwordError || repeatedError || (passwordTooShort
        ? "Das neue Passwort muss mindestens 12 Zeichen enthalten."
        : "Die beiden Passwoerter stimmen nicht ueberein."));
      return;
    }

    const payload = {
      newPassword: passwordProof,
      newPasswordConfirmation: repeatedProof,
    };
    passwordProof = undefined;
    repeatedProof = undefined;
    // State, refs and physical DOM inputs are purged synchronously before the
    // transport receives the exact proof copy.
    purgePasswords();
    activePayloadsRef.current.add(payload);
    setBusy(true);
    setError("");
    setNotice("");
    const controller = nextController();
    try {
      const result = assertCompletionResult(await api.complete(payload, { signal: controller.signal }));
      payload.newPassword = undefined;
      payload.newPasswordConfirmation = undefined;
      if (controller.signal.aborted || !mountedRef.current) return;
      setPhase("completed");
      setNotice("Das Passwort wurde geändert. Bitte melden Sie sich erneut über den normalen Login an.");
    } catch (completeError) {
      payload.newPassword = undefined;
      payload.newPasswordConfirmation = undefined;
      purgePasswords();
      if (completeError?.name !== "AbortError" && !controller.signal.aborted && mountedRef.current) {
        setError("Das neue Passwort konnte nicht gespeichert werden.");
      }
    } finally {
      payload.newPassword = undefined;
      payload.newPasswordConfirmation = undefined;
      activePayloadsRef.current.delete(payload);
      if (mountedRef.current && controllerRef.current === controller) setBusy(false);
    }
  }

  if (!active) return null;

  return (
    <section className="bonni-password-recovery" aria-label="Passwort-Wiederherstellung">
      <header>
        <BrandName as="p" />
        <h2>{phase === "approved" ? "Neues Passwort" : "Passwort-Wiederherstellung"}</h2>
      </header>

      {phase === "checking" ? <p role="status">Status wird geladen …</p> : null}
      {error ? <p className="bonni-password-recovery__alert is-error" role="alert">{error}</p> : null}
      {notice ? <p className="bonni-password-recovery__alert is-success" role="status">{notice}</p> : null}

      {phase === "request" ? (
        supportCodeMode ? (
          <form onSubmit={resumeWithSupportCode}>
            <p>Mit einem separat erhaltenen Support-Code können Sie die freigegebene Wiederherstellung in diesem Browser fortsetzen.</p>
            <ExactSecretInput
              value={supportCode}
              onChange={replaceSupportCode}
              inputRef={(node) => {
                if (node) inputNodesRef.current.set("supportCode", node);
                else inputNodesRef.current.delete("supportCode");
              }}
              label="Support-Code"
              maxLength={23}
              autoComplete="off"
              autoFocus
              disabled={busy}
            />
            <div className="bonni-password-recovery__actions">
              <button type="button" onClick={() => { purgePasswords(); setSupportCodeMode(false); setError(""); }} disabled={busy}>Zurueck</button>
              <button type="submit" className="is-primary" disabled={busy || !supportCode}>{busy ? "Wird geprüft …" : "Support-Code verwenden"}</button>
            </div>
          </form>
        ) : (
          <form onSubmit={requestRecovery}>
            <p>Fordere die Wiederherstellung fuer den eingegebenen Benutzernamen an. Aus Sicherheitsgruenden verraet Bonni nicht, ob ein passendes Konto vorhanden ist.</p>
            <dl><div><dt>Benutzername</dt><dd>{loginName || "Nicht eingegeben"}</dd></div></dl>
            <div className="bonni-password-recovery__actions">
              <button type="button" onClick={cancel} disabled={busy}>Zurueck zum Login</button>
              <button type="button" onClick={() => { setSupportCodeMode(true); setError(""); }} disabled={busy}>Support-Code verwenden</button>
              <button type="submit" className="is-primary" disabled={busy || !loginName}>{busy ? "Wird angefordert …" : "Wiederherstellung anfordern"}</button>
            </div>
          </form>
        )
      ) : null}

      {phase === "pending" ? (
        <div className="bonni-password-recovery__status">
          <span>Wird geprüft</span>
          {reference ? <dl><div><dt>Vorgangsnummer</dt><dd>{reference}</dd></div></dl> : null}
          <p>Die Pruefung laeuft serverseitig bis zu 48 Stunden weiter. Du kannst diesen Browser schliessen und spaeter zurueckkommen.</p>
          <div className="bonni-password-recovery__actions">
            <button type="button" onClick={cancel} disabled={busy}>Zurueck zum Login</button>
            <button type="button" onClick={() => { setPhase("request"); setSupportCodeMode(true); setError(""); }} disabled={busy}>Support-Code verwenden</button>
            <button type="button" className="is-primary" onClick={refreshStatus} disabled={busy}>{busy ? "Wird geladen …" : "Status aktualisieren"}</button>
          </div>
        </div>
      ) : null}

      {phase === "approved" ? (
        <form onSubmit={submitNewPassword}>
          <div className="bonni-password-recovery__status"><span className="is-approved">Freigegeben</span></div>
          {reference ? <dl><div><dt>Vorgangsnummer</dt><dd>{reference}</dd></div></dl> : null}
          <p>Lege jetzt ein neues Passwort fest. Es wird weder normalisiert noch gekuerzt.</p>
          <div className="bonni-password-recovery__fields">
            <ExactSecretInput
              value={passwords.newPassword}
              onChange={(value) => replacePasswords({ ...passwordsRef.current, newPassword: value })}
              inputRef={(node) => {
                if (node) inputNodesRef.current.set("newPassword", node);
                else inputNodesRef.current.delete("newPassword");
              }}
              label="Neues Passwort"
              maxLength={LOCAL_PASSWORD_MAX_LENGTH}
              autoComplete="new-password"
              autoFocus
              disabled={busy}
            />
            <ExactSecretInput
              value={passwords.repeatedPassword}
              onChange={(value) => replacePasswords({ ...passwordsRef.current, repeatedPassword: value })}
              inputRef={(node) => {
                if (node) inputNodesRef.current.set("repeatedPassword", node);
                else inputNodesRef.current.delete("repeatedPassword");
              }}
              label="Neues Passwort wiederholen"
              maxLength={LOCAL_PASSWORD_MAX_LENGTH}
              autoComplete="new-password"
              disabled={busy}
            />
          </div>
          <div className="bonni-password-recovery__actions">
            <button type="button" onClick={cancel} disabled={busy}>Abbrechen</button>
            <button type="submit" className="is-primary" disabled={busy}>{busy ? "Wird gespeichert …" : "Neues Passwort speichern"}</button>
          </div>
        </form>
      ) : null}

      {phase === "completed" ? (
        <div>
          <p>Die Wiederherstellung ist abgeschlossen. Es erfolgt keine automatische Anmeldung.</p>
          <div className="bonni-password-recovery__actions"><button type="button" className="is-primary" onClick={cancel}>Zum normalen Login</button></div>
        </div>
      ) : null}
    </section>
  );
}

export function PasswordRecoveryLauncher({ onOpen }) {
  return <button type="button" className="bonni-password-recovery-launcher" onClick={onOpen}>Passwort vergessen?</button>;
}
