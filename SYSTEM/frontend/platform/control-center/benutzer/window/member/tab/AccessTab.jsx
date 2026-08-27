import { useCallback, useEffect, useMemo, useState } from "react";

import {
  deleteControlCenterLocalMember,
  updateControlCenterLocalMemberAccess,
} from "../../../../../../system/api/controlCenterUsersApi.js";
import ExactSecretInput from "../../../../../../core/modules/security/two-factor/components/ExactSecretInput.jsx";
import {
  countUnicodeCodePoints,
  validateExactSecret,
} from "../../../../../../core/modules/security/two-factor/model/exactSecretPolicy.js";
import { getAccounts, getPrimaryAccount } from "../memberWindowUtils.js";

function generatePassword(length = 14) {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const numbers = "23456789";
  const symbols = "!?#%+-";
  const all = `${letters}${numbers}${symbols}`;
  const required = [letters, numbers, symbols].map((pool) => pool[Math.floor(Math.random() * pool.length)]);
  const rest = Array.from({ length: Math.max(0, length - required.length) }, () => all[Math.floor(Math.random() * all.length)]);

  return [...required, ...rest].sort(() => Math.random() - 0.5).join("");
}

function getEmailCandidate(member, account) {
  const accountEmail = String(account?.email || "").trim();
  if (accountEmail) return accountEmail;

  const memberEmail = String(member?.email || "").trim();
  return memberEmail === "—" ? "" : memberEmail;
}

function isValidEmail(value) {
  if (!value) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function encodeMailtoValue(value) {
  return encodeURIComponent(value || "").replace(/%20/g, "+");
}

function createAccessMailto({ email, loginName, password }) {
  const subject = "Deine Zugangsdaten";
  const body = [
    "Hallo,",
    "",
    "hier sind deine Zugangsdaten:",
    "",
    `Benutzer: ${loginName}`,
    `Passwort: ${password}`,
    "",
    "Bitte ändere das Passwort nach der ersten Anmeldung, falls das System diese Funktion anbietet.",
  ].join("\n");

  return `mailto:${encodeMailtoValue(email)}?subject=${encodeMailtoValue(subject)}&body=${encodeMailtoValue(body)}`;
}

function getAccessErrorMessage(error) {
  const code = error?.code || error?.data?.code;

  if (code === "LOCAL_MEMBER_PASSWORD_TOO_SHORT") return "Das Passwort muss mindestens 6 Zeichen haben.";
  if (code === "LOCAL_MEMBER_EMAIL_INVALID") return "Bitte eine gültige E-Mail-Adresse eingeben.";
  if (code === "LOCAL_MEMBER_ACCOUNT_NOT_FOUND") return "Dieser Zugang wurde nicht gefunden.";
  if (code === "LOCAL_MEMBER_ACCESS_NO_CHANGES") return "Es gibt keine Änderungen zum Speichern.";

  return error?.message || "Zugang konnte nicht aktualisiert werden.";
}

function getFooterLabel({ saving, emailChanged, passwordChanged }) {
  if (saving) return "Speichert...";
  if (passwordChanged) return "Passwort ändern";
  if (emailChanged) return "E-Mail speichern";
  return "Schließen";
}

function AccessPanel({
  member,
  account,
  token,
  onAccountChange,
  onDeleted,
  onBusyChange,
  onFooterActionChange,
  bootstrapAdmin = false,
}) {
  const [email, setEmail] = useState(() => getEmailCandidate(member, account));
  const [password, setPassword] = useState("");
  const [passwordRepeat, setPasswordRepeat] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const accountId = account?.accountId || account?.id;
  const loginName = account?.loginName || member?.loginName || member?.name || "";
  const originalEmail = useMemo(() => getEmailCandidate(member, account), [account, member]);
  const cleanEmail = email.trim();
  const emailChanged = cleanEmail !== originalEmail;
  const passwordChanged = Boolean(password || passwordRepeat);
  const hasAccessChanges = emailChanged || passwordChanged;

  useEffect(() => {
    setEmail(getEmailCandidate(member, account));
    setPassword("");
    setPasswordRepeat("");
    setShowPassword(false);
    setMessage("");
    setError("");
  }, [accountId, account, member]);

  const setBusy = useCallback((busy) => {
    setSaving(busy);
    onBusyChange?.(busy);
  }, [onBusyChange]);

  const handleGenerate = useCallback(() => {
    const nextPassword = generatePassword();
    setPassword(nextPassword);
    setPasswordRepeat(nextPassword);
    setShowPassword(true);
    setError("");
    setMessage("Passwort wurde generiert. Unten auf „Passwort ändern“ klicken, um es zu speichern.");
  }, []);

  const handleSend = useCallback(() => {
    if (!cleanEmail) {
      setError("Bitte zuerst eine E-Mail-Adresse eingeben.");
      return;
    }

    if (!isValidEmail(cleanEmail)) {
      setError("Bitte eine gültige E-Mail-Adresse eingeben.");
      return;
    }

    if (!password) {
      setError("Bitte zuerst ein Passwort eingeben oder generieren.");
      return;
    }

    const passwordError = validateExactSecret(password, { label: "Das Passwort" });
    if (passwordError || countUnicodeCodePoints(password) < 6) {
      setError(passwordError || "Das Passwort muss mindestens 6 Zeichen haben.");
      return;
    }

    if (password !== passwordRepeat) {
      setError("Die Passwort-Wiederholung stimmt nicht überein.");
      return;
    }

    setError("");
    setMessage("E-Mail-Programm wird geöffnet. Bitte dort noch einmal prüfen und absenden.");
    window.location.href = createAccessMailto({ email: cleanEmail, loginName, password });
  }, [cleanEmail, loginName, password, passwordRepeat]);

  const handleSave = useCallback(async () => {
    if (!accountId) {
      setError("Dieser Benutzer hat keinen lokalen Zugang zum Aktualisieren.");
      return;
    }

    const payload = {};

    if (!isValidEmail(cleanEmail)) {
      setError("Bitte eine gültige E-Mail-Adresse eingeben.");
      return;
    }

    if (emailChanged) {
      payload.email = cleanEmail || null;
    }

    if (passwordChanged) {
      const passwordError = validateExactSecret(password, { label: "Das Passwort" });
      if (passwordError || countUnicodeCodePoints(password) < 6) {
        setError(passwordError || "Das Passwort muss mindestens 6 Zeichen haben.");
        return;
      }

      if (password !== passwordRepeat) {
        setError("Die Passwort-Wiederholung stimmt nicht überein.");
        return;
      }

      payload.password = password;
    }

    if (!Object.keys(payload).length) {
      setError("Es gibt keine Änderungen zum Speichern.");
      return;
    }

    setBusy(true);
    setError("");
    setMessage("");

    try {
      const result = await updateControlCenterLocalMemberAccess(token, accountId, payload);
      const updatedAccount = result?.account || { ...account, email: cleanEmail || null };
      onAccountChange?.({ ...account, ...updatedAccount, email: cleanEmail || updatedAccount.email || null });
      setPassword("");
      setPasswordRepeat("");
      setMessage(passwordChanged ? "Passwort wurde geändert." : "E-Mail-Adresse wurde gespeichert.");
    } catch (saveError) {
      setError(getAccessErrorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }, [account, accountId, cleanEmail, emailChanged, password, passwordChanged, passwordRepeat, setBusy, token, onAccountChange]);

  const handleDelete = useCallback(async () => {
    if (!accountId) {
      setError("Dieser Benutzer hat keinen löschbaren Zugang.");
      return;
    }

    const confirmed = window.confirm(`Benutzer "${loginName}" wirklich löschen? Dieser Vorgang kann nicht automatisch rückgängig gemacht werden.`);
    if (!confirmed) return;

    setDeleting(true);
    onBusyChange?.(true);
    setError("");
    setMessage("");

    try {
      await deleteControlCenterLocalMember(token, accountId);
      onDeleted?.(member);
    } catch (deleteError) {
      setError(deleteError?.message || "Benutzer konnte nicht gelöscht werden.");
    } finally {
      setDeleting(false);
      onBusyChange?.(false);
    }
  }, [accountId, loginName, member, onBusyChange, onDeleted, token]);

  useEffect(() => {
    if (!onFooterActionChange) return undefined;

    if (!hasAccessChanges) {
      onFooterActionChange(null);
      return undefined;
    }

    onFooterActionChange({
      label: getFooterLabel({ saving, emailChanged, passwordChanged }),
      className: "cc-member-window__primary",
      disabled: saving || deleting,
      onClick: handleSave,
    });

    return () => onFooterActionChange(null);
  }, [deleting, emailChanged, handleSave, hasAccessChanges, onFooterActionChange, passwordChanged, saving]);

  return (
    <section className="cc-member-window-card cc-member-window-access-card">
      <h3>Zugang verwalten</h3>

      {error ? <div className="cc-member-error" role="status">{error}</div> : null}
      {message ? <div className="cc-member-success" role="status">{message}</div> : null}

      <div className="cc-member-window-grid cc-member-window-grid--single">
        <label className="cc-member-window-field cc-member-window-field--editable">
          <span>E-Mail-Adresse</span>
          <input
            className="cc-member-window-input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.de"
            autoComplete="email"
          />
        </label>

        <div className="cc-member-window-field cc-member-window-field--editable">
          <div className="cc-member-window-password-row">
            <ExactSecretInput
              className="cc-member-window-field cc-member-window-field--editable"
              inputClassName="cc-member-window-input"
              inputType={showPassword ? "text" : "password"}
              label="Neues Passwort"
              value={password}
              onChange={setPassword}
              placeholder="Passwort eingeben oder generieren"
              autoComplete="new-password"
              required={false}
            />
            <button
              type="button"
              className="cc-member-window-reveal-button"
              onClick={(event) => {
                event.preventDefault();
                setShowPassword((current) => !current);
              }}
              aria-pressed={showPassword}
            >
              {showPassword ? "Verbergen" : "Anzeigen"}
            </button>
          </div>
        </div>

        <div className="cc-member-window-field cc-member-window-field--editable">
          <div className="cc-member-window-password-row">
            <ExactSecretInput
              className="cc-member-window-field cc-member-window-field--editable"
              inputClassName="cc-member-window-input"
              inputType={showPassword ? "text" : "password"}
              label="Passwort wiederholen"
              value={passwordRepeat}
              onChange={setPasswordRepeat}
              placeholder="Passwort erneut eingeben"
              autoComplete="new-password"
              required={false}
            />
          </div>
        </div>
      </div>

      <div className="cc-member-window-access-actions">
        <button type="button" className="cc-member-window__secondary" onClick={handleGenerate} disabled={saving || deleting}>
          Passwort generieren
        </button>
        <button type="button" className="cc-member-window__secondary" onClick={handleSend} disabled={saving || deleting}>
          Zugangsdaten per E-Mail vorbereiten
        </button>
      </div>

      <p className="cc-member-window-note">
        Das Passwort wird nur in diesem Fenster angezeigt. Speichern läuft über den unteren Button „Passwort ändern“.
      </p>

      {bootstrapAdmin ? (
        <p className="cc-member-window-note">
          Der feste Systembenutzer admin kann nicht gelöscht oder deaktiviert werden. Sein Passwort darf hier geändert werden.
        </p>
      ) : (
        <div className="cc-member-window-danger-zone">
          <div>
            <strong>Benutzer löschen</strong>
            <span>Entfernt den lokalen Zugang und blendet den Benutzer aus der Verwaltung aus.</span>
          </div>
          <button type="button" className="cc-member-window__danger" onClick={handleDelete} disabled={saving || deleting}>
            {deleting ? "Löscht..." : "Benutzer löschen"}
          </button>
        </div>
      )}
    </section>
  );
}

export default function AccessTab({
  member,
  token,
  onAccountChange,
  onDeleted,
  onBusyChange,
  onFooterActionChange,
  bootstrapAdmin = false,
}) {
  const accounts = getAccounts(member);
  const primaryAccount = getPrimaryAccount(member) || accounts[0] || null;

  useEffect(() => () => onFooterActionChange?.(null), [onFooterActionChange]);

  if (!accounts.length) {
    return <div className="cc-member-window-empty">Keine Zugänge vorhanden.</div>;
  }

  return (
    <div className="cc-member-window-stack">
      <AccessPanel
        member={member}
        account={primaryAccount}
        token={token}
        onAccountChange={onAccountChange}
        onDeleted={onDeleted}
        onBusyChange={onBusyChange}
        onFooterActionChange={onFooterActionChange}
        bootstrapAdmin={bootstrapAdmin}
      />
    </div>
  );
}
