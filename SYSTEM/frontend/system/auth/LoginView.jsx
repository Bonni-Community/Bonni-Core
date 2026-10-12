import { useId, useState } from "react";

import {
  LOCAL_PASSWORD_MAX_LENGTH,
  secretInputWouldBeInvalid,
} from "../../core/modules/security/two-factor/model/exactSecretPolicy.js";
import PasswordRecoveryFlow, {
  PasswordRecoveryLauncher,
} from "../../core/modules/security/identity/components/PasswordRecoveryFlow.jsx";
import { passwordRecoveryApi } from "../../core/modules/security/identity/api/accountRecoveryApi.js";
import BrandLogo from "../brand/BrandLogo.jsx";
import BrandName from "../brand/BrandName.jsx";
import { useBranding } from "../brand/BrandContext.jsx";
import "./LoginView.css";

function FieldIcon({ kind }) {
  if (kind === "user") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8" r="3.25" />
        <path d="M5.5 19c.7-3.3 3-5 6.5-5s5.8 1.7 6.5 5" />
      </svg>
    );
  }

  if (kind === "shield") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3.2 18.5 6v5.1c0 4.2-2.4 7.5-6.5 9.7-4.1-2.2-6.5-5.5-6.5-9.7V6L12 3.2Z" />
        <path d="m9.2 12 1.8 1.8 3.9-4" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="2.5" />
      <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
    </svg>
  );
}

function PasswordVisibilityIcon({ visible }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.8 12s3.2-5.2 9.2-5.2 9.2 5.2 9.2 5.2-3.2 5.2-9.2 5.2S2.8 12 2.8 12Z" />
      <circle cx="12" cy="12" r="2.5" />
      {visible ? null : <path d="m4.2 4.2 15.6 15.6" />}
    </svg>
  );
}

function BonniBrandLogo() {
  return (
    <div className="bonni-login-brand__hexagon">
      <div className="bonni-login-brand__hexagon-body">
        <BrandLogo
          className="bonni-login-brand__logo"
        />
      </div>
    </div>
  );
}

function SecureInput({
  value,
  onChange,
  label,
  type = "password",
  autoComplete = "off",
  inputMode,
  maxLength = 128,
  autoFocus = false,
}) {
  const [inputError, setInputError] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const revealable = type === "password";

  function invalid(nextValue) {
    return type === "password"
      ? secretInputWouldBeInvalid(nextValue, maxLength)
      : typeof nextValue !== "string" || nextValue.length > maxLength || /[\r\n\0]/.test(nextValue);
  }

  function purge() {
    onChange("");
    setInputError(`${label} enthält unzulässige Zeichen oder ist zu lang.`);
  }

  function prospectiveValue(event, inserted) {
    const start = Number.isInteger(event.currentTarget?.selectionStart)
      ? event.currentTarget.selectionStart
      : value.length;
    const end = Number.isInteger(event.currentTarget?.selectionEnd)
      ? event.currentTarget.selectionEnd
      : start;
    return `${value.slice(0, start)}${inserted}${value.slice(end)}`;
  }

  function guardInsertion(event) {
    const inserted = event.data;
    if (typeof inserted === "string" && invalid(prospectiveValue(event, inserted))) {
      event.preventDefault();
      purge();
    }
  }

  function guardPaste(event) {
    const pasted = event.clipboardData?.getData("text");
    if (typeof pasted === "string" && invalid(prospectiveValue(event, pasted))) {
      event.preventDefault();
      purge();
    }
  }

  function change(nextValue) {
    if (nextValue && invalid(nextValue)) {
      purge();
      return;
    }
    setInputError("");
    onChange(nextValue);
  }

  return (
    <div className="bonni-login-field">
      <label className="bonni-login-field__label" htmlFor={inputId}>{label}</label>
      <span className={`bonni-login-field__control${revealable ? " bonni-login-field__control--revealable" : ""}`}>
        <span className="bonni-login-field__icon">
          <FieldIcon kind={inputMode === "numeric" ? "shield" : "lock"} />
        </span>
        <input
          id={inputId}
          value={value}
          onChange={(event) => change(event.target.value)}
          onBeforeInput={guardInsertion}
          onPaste={guardPaste}
          placeholder={label}
          type={revealable && passwordVisible ? "text" : type}
          autoComplete={autoComplete}
          inputMode={inputMode}
          autoFocus={autoFocus}
          required
          maxLength={maxLength}
          aria-invalid={Boolean(inputError)}
          aria-describedby={inputError ? errorId : undefined}
        />
        {revealable ? (
          <button
            className="bonni-login-field__visibility"
            type="button"
            onClick={() => setPasswordVisible((current) => !current)}
            aria-label={passwordVisible ? `${label} ausblenden` : `${label} anzeigen`}
            aria-pressed={passwordVisible}
          >
            <PasswordVisibilityIcon visible={passwordVisible} />
          </button>
        ) : null}
      </span>
      {inputError ? <small id={errorId} className="bonni-login-field__error" role="alert">{inputError}</small> : null}
    </div>
  );
}

export default function LoginView({
  loginName,
  password,
  twoFactorChallenge,
  twoFactorProofValues,
  twoFactorRecoveryMode,
  message,
  onLoginNameChange,
  onPasswordChange,
  onTwoFactorProofChange,
  onTwoFactorRecoveryModeChange,
  onCancelTwoFactor,
  onSubmit,
}) {
  const { branding } = useBranding();
  const [passwordRecoveryActive, setPasswordRecoveryActive] = useState(false);
  const localRecoveryAllowed = Boolean(
    twoFactorChallenge
    && String(twoFactorChallenge.provider || "").toLowerCase() === "local"
  );
  const proofFields = twoFactorRecoveryMode
    ? [{ name: "recoveryCode", label: "Wiederherstellungscode", type: "password", autocomplete: "off" }]
    : (twoFactorChallenge?.proofFields || []);
  const loginTitle = twoFactorChallenge ? "Anmeldung bestätigen" : "Willkommen zurück!";

  return (
    <main className="bonni-login-page">
      <div className="bonni-login-page__content">
        <section className="bonni-login-brand">
          <BonniBrandLogo />
        </section>

        <section className="bonni-login-panel" aria-label={passwordRecoveryActive ? "Passwort-Wiederherstellung" : "Anmeldung"}>
          <PasswordRecoveryFlow
            active={passwordRecoveryActive}
            loginName={loginName}
            api={passwordRecoveryApi}
            onActiveChange={setPasswordRecoveryActive}
          />

          {!passwordRecoveryActive ? (
            <form className="bonni-login-card" onSubmit={onSubmit} aria-labelledby="bonni-login-title">
              <header className="bonni-login-card__header">
                <h1 id="bonni-login-title">{loginTitle}</h1>
                <p>
                  {twoFactorChallenge
                    ? `Bestätigen Sie Ihre Anmeldung über ${twoFactorChallenge.providerLabel || "Bonni"}.`
                    : "Bitte melden Sie sich an, um fortzufahren."}
                </p>
              </header>

              <div className="bonni-login-card__fields">
                {!twoFactorChallenge ? (
                  <label className="bonni-login-field" htmlFor="bonni-login-name">
                    <span className="bonni-login-field__label">Benutzername</span>
                    <span className="bonni-login-field__control">
                      <span className="bonni-login-field__icon"><FieldIcon kind="user" /></span>
                      <input
                        id="bonni-login-name"
                        value={loginName}
                        onChange={(event) => onLoginNameChange(event.target.value)}
                        placeholder="Benutzername eingeben"
                        type="text"
                        autoComplete="username"
                        autoCapitalize="none"
                        spellCheck="false"
                        maxLength={128}
                        required
                        autoFocus
                      />
                    </span>
                  </label>
                ) : null}

                {!twoFactorChallenge ? (
                  <SecureInput
                    value={password}
                    onChange={onPasswordChange}
                    label="Passwort"
                    autoComplete="current-password"
                    maxLength={LOCAL_PASSWORD_MAX_LENGTH}
                  />
                ) : null}

                {twoFactorChallenge && !proofFields.length ? (
                  <p className="bonni-login-card__message" role="alert">
                    Der 2FA-Anbieter hat keinen gültigen Prüfvertrag geliefert.
                  </p>
                ) : null}

                {twoFactorChallenge ? proofFields.map((field, index) => (
                  <SecureInput
                    key={field.name}
                    value={twoFactorProofValues?.[field.name] || ""}
                    onChange={(value) => onTwoFactorProofChange(field.name, value)}
                    label={field.label || "2FA-Nachweis"}
                    type={field.type === "text" ? "text" : "password"}
                    autoComplete={field.autocomplete || "off"}
                    inputMode={field.name === "code" ? "numeric" : undefined}
                    maxLength={field.name === "password" ? LOCAL_PASSWORD_MAX_LENGTH : field.name === "recoveryCode" ? 80 : 128}
                    autoFocus={index === 0}
                  />
                )) : null}
              </div>

              {!twoFactorChallenge ? (
                <div className="bonni-login-card__recovery">
                  <PasswordRecoveryLauncher onOpen={() => setPasswordRecoveryActive(true)} />
                </div>
              ) : null}

              <div className="bonni-login-card__actions">
                {localRecoveryAllowed ? (
                  <button
                    className="bonni-login-button bonni-login-button--secondary"
                    type="button"
                    onClick={() => onTwoFactorRecoveryModeChange(!twoFactorRecoveryMode)}
                  >
                    {twoFactorRecoveryMode ? "Authenticator verwenden" : "Wiederherstellungscode verwenden"}
                  </button>
                ) : null}

                <button
                  className="bonni-login-button bonni-login-button--primary"
                  type="submit"
                  disabled={Boolean(twoFactorChallenge && !proofFields.length)}
                >
                  {twoFactorChallenge ? "2FA bestätigen" : "Anmelden"}
                </button>

                {twoFactorChallenge ? (
                  <button
                    className="bonni-login-button bonni-login-button--secondary"
                    type="button"
                    onClick={onCancelTwoFactor}
                  >
                    Zurück
                  </button>
                ) : null}
              </div>

              {message ? (
                <p className="bonni-login-card__message" role="alert" aria-live="assertive">{message}</p>
              ) : null}
            </form>
          ) : null}
        </section>
      </div>

      <aside className="bonni-login-slogan" aria-label={branding.displayName}>
        <p>Organisationen sollen genau die Werkzeuge nutzen können, die sie benötigen – nicht mehr und nicht weniger.</p>
        <p className="bonni-login-slogan__copyright"><BrandName /> © 2025</p>
      </aside>
    </main>
  );
}
