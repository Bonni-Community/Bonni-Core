import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import ExactSecretInput from "./ExactSecretInput.jsx";
import { buildProviderProof } from "../model/twoFactorPayload.js";
import { secretInputWouldBeInvalid } from "../model/exactSecretPolicy.js";

const EMPTY_VALUES = Object.freeze({
  code: "",
  token: "",
  password: "",
  recoveryCode: "",
});

function supportsLocalRecovery(providerId, enabled) {
  return enabled && String(providerId || "").toLowerCase() === "local";
}

export default function ProviderProofForm({
  provider,
  proofFields,
  recoveryAllowed = false,
  busy = false,
  submitLabel = "Bestaetigen",
  onVerify,
  onCancel,
  className = "",
}) {
  const fields = useMemo(() => (
    Array.isArray(proofFields) ? proofFields : []
  ), [proofFields]);
  const [values, setValues] = useState(EMPTY_VALUES);
  const valuesRef = useRef(EMPTY_VALUES);
  const inputNodes = useRef(new Map());
  const [recovery, setRecovery] = useState(false);
  const [invalidSecrets, setInvalidSecrets] = useState({});
  const [error, setError] = useState("");
  const localRecovery = supportsLocalRecovery(provider?.id, recoveryAllowed);

  function replaceValues(next) {
    valuesRef.current = next;
    setValues(next);
  }

  const purgeDomAndRefs = useCallback(() => {
    for (const node of inputNodes.current.values()) {
      if (node) node.value = "";
    }
    valuesRef.current = EMPTY_VALUES;
  }, []);

  const purge = useCallback(() => {
    purgeDomAndRefs();
    setValues({ ...EMPTY_VALUES });
    setInvalidSecrets({});
  }, [purgeDomAndRefs]);

  useEffect(() => {
    purge();
    setRecovery(false);
    setError("");
    return () => {
      purgeDomAndRefs();
    };
  }, [provider?.id, fields, purge, purgeDomAndRefs]);

  useEffect(() => {
    const handlePageHide = () => purge();
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [purge]);

  function update(name, value) {
    replaceValues({ ...valuesRef.current, [name]: value });
  }

  function updatePlainField(name, value, maxLength) {
    if (secretInputWouldBeInvalid(value, maxLength)) {
      purge();
      setInvalidSecrets({ proof: false });
      setError("Der 2FA-Nachweis enthaelt unzulaessige Zeichen oder ist zu lang.");
      return;
    }
    setInvalidSecrets((current) => ({ ...current, proof: true }));
    setError("");
    update(name, value);
  }

  function guardPlainInsertion(event, name, maxLength) {
    const inserted = event.data;
    const current = valuesRef.current[name] || "";
    const start = Number.isInteger(event.currentTarget?.selectionStart) ? event.currentTarget.selectionStart : current.length;
    const end = Number.isInteger(event.currentTarget?.selectionEnd) ? event.currentTarget.selectionEnd : start;
    const combined = typeof inserted === "string"
      ? `${current.slice(0, start)}${inserted}${current.slice(end)}`
      : "";
    if (typeof inserted === "string" && secretInputWouldBeInvalid(combined, maxLength)) {
      event.preventDefault();
      purge();
      setInvalidSecrets({ proof: false });
      setError("Der 2FA-Nachweis enthaelt unzulaessige Zeichen oder ist zu lang.");
    }
  }

  function guardPlainPaste(event, name, maxLength) {
    const pasted = event.clipboardData?.getData("text");
    const current = valuesRef.current[name] || "";
    const start = Number.isInteger(event.currentTarget?.selectionStart) ? event.currentTarget.selectionStart : current.length;
    const end = Number.isInteger(event.currentTarget?.selectionEnd) ? event.currentTarget.selectionEnd : start;
    const combined = typeof pasted === "string"
      ? `${current.slice(0, start)}${pasted}${current.slice(end)}`
      : "";
    if (typeof pasted === "string" && secretInputWouldBeInvalid(combined, maxLength)) {
      event.preventDefault();
      purge();
      setInvalidSecrets({ proof: false });
      setError("Der 2FA-Nachweis enthaelt unzulaessige Zeichen oder ist zu lang.");
    }
  }

  function toggleRecovery() {
    purge();
    setError("");
    setRecovery((current) => !current);
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    if (Object.values(invalidSecrets).some((valid) => valid === false)) {
      purge();
      setError("Bitte den Sicherheitsnachweis erneut und vollstaendig eingeben.");
      return;
    }

    let proof;
    try {
      proof = buildProviderProof(valuesRef.current, fields, { recovery });
      // Der Nachweis darf waehrend des laufenden Requests weder im DOM noch
      // im React-State verbleiben.
      purge();
      await onVerify?.(proof);
    } catch (submitError) {
      purge();
      setError(submitError?.message || "Der Sicherheitsnachweis wurde nicht akzeptiert.");
    } finally {
      if (proof) {
        for (const name of Object.keys(proof)) proof[name] = "";
      }
      purgeDomAndRefs();
    }
  }

  function cancel() {
    purge();
    setError("");
    onCancel?.();
  }

  const visibleFields = recovery
    ? [{ name: "recoveryCode", label: "Wiederherstellungscode", type: "password", autocomplete: "off" }]
    : fields;

  return (
    <form className={["bonni-2fa-proof", className].filter(Boolean).join(" ")} onSubmit={submit}>
      <div className="bonni-2fa-proof__head">
        <div>
          <strong>Sicherheitsnachweis</strong>
          <small>{provider?.label || "Bonni Core"}</small>
        </div>
        {localRecovery ? (
          <button type="button" className="is-link" onClick={toggleRecovery} disabled={busy}>
            {recovery ? "Authenticator verwenden" : "Wiederherstellungscode verwenden"}
          </button>
        ) : null}
      </div>

      <div className="bonni-2fa-proof__fields">
        {!visibleFields.length ? (
          <p className="bonni-2fa-alert is-error" role="alert">
            Der 2FA-Anbieter hat keinen gueltigen Pruefvertrag geliefert. Die Aktion bleibt gesperrt.
          </p>
        ) : null}
        {visibleFields.map((field, index) => field.name === "password" ? (
          <ExactSecretInput
            key={field.name}
            value={values.password}
            inputRef={(node) => {
              if (node) inputNodes.current.set(field.name, node);
              else {
                const previous = inputNodes.current.get(field.name);
                if (previous) previous.value = "";
                inputNodes.current.delete(field.name);
              }
            }}
            onChange={(value) => update("password", value)}
            onValidityChange={(valid) => setInvalidSecrets((current) => ({ ...current, password: valid }))}
            label={field.label || "Passwort"}
            autoComplete={field.autocomplete || "current-password"}
            autoFocus={index === 0}
            disabled={busy}
          />
        ) : (
          <label className="bonni-2fa-field" key={field.name}>
            <span>{field.label || "2FA-Nachweis"}</span>
            <input
              ref={(node) => {
                if (node) inputNodes.current.set(field.name, node);
                else {
                  const previous = inputNodes.current.get(field.name);
                  if (previous) previous.value = "";
                  inputNodes.current.delete(field.name);
                }
              }}
              type={field.type === "text" ? "text" : "password"}
              value={values[field.name] || ""}
              onChange={(event) => updatePlainField(
                field.name,
                event.target.value,
                field.name === "recoveryCode" ? 80 : 128,
              )}
              onBeforeInput={(event) => guardPlainInsertion(
                event,
                field.name,
                field.name === "recoveryCode" ? 80 : 128,
              )}
              onPaste={(event) => guardPlainPaste(
                event,
                field.name,
                field.name === "recoveryCode" ? 80 : 128,
              )}
              autoComplete={field.autocomplete || "off"}
              inputMode={field.name === "code" ? "numeric" : undefined}
              autoFocus={index === 0}
              disabled={busy}
              required
            />
            {field.help ? <small>{field.help}</small> : null}
          </label>
        ))}
      </div>

      {error ? <p className="bonni-2fa-alert is-error" role="alert">{error}</p> : null}
      <div className="bonni-2fa-actions">
        {onCancel ? <button type="button" onClick={cancel} disabled={busy}>Abbrechen</button> : null}
        <button type="submit" className="is-primary" disabled={busy || !visibleFields.length}>
          {busy ? "Pruefung laeuft …" : submitLabel}
        </button>
      </div>
    </form>
  );
}
