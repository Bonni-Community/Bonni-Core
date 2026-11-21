import { useEffect, useMemo, useState } from "react";

import {
  changeOwnPassword,
  fetchOwnChangeHistory,
  fetchOwnProfile,
  updateOwnProfile,
} from "./userSettingsApi.js";
import "./UserSettingsSections.css";
import SystemErasurePanel from "../../core/modules/security/identity/components/SystemErasurePanel.jsx";
import { isBootstrapAdminLoginName } from "../../system/auth/systemAccountPolicy.js";

export const USER_SETTINGS_SECTIONS = Object.freeze([
  Object.freeze({
    key: "profile",
    label: "Profil",
    icon: "profile",
    tabs: Object.freeze([
      Object.freeze({ key: "data", label: "Daten" }),
      Object.freeze({ key: "image", label: "Bild" }),
      Object.freeze({ key: "rights", label: "Rechte" }),
      Object.freeze({ key: "logs", label: "Protokolle" }),
    ]),
  }),
  Object.freeze({
    key: "bank",
    label: "Bankverbindung",
    icon: "bank",
    tabs: Object.freeze([
      Object.freeze({ key: "bank-account", label: "Bankkonto" }),
      Object.freeze({ key: "paypal", label: "PayPal-Konto" }),
    ]),
  }),
  Object.freeze({
    key: "privacy",
    label: "Datenschutz",
    icon: "privacy",
    tabs: Object.freeze([
      Object.freeze({ key: "bonni-core", label: "Bonni Core" }),
      Object.freeze({ key: "stueberl", label: "StüberlApp" }),
      Object.freeze({ key: "kontor", label: "KontorApp" }),
      Object.freeze({ key: "meet", label: "MeetApp" }),
      Object.freeze({ key: "confirmations", label: "Bestätigung" }),
      Object.freeze({ key: "erasure", label: "Löschantrag" }),
    ]),
  }),
  Object.freeze({
    key: "security",
    label: "Sicherheit",
    icon: "security",
    tabs: Object.freeze([
      Object.freeze({ key: "password", label: "Passwort" }),
      Object.freeze({ key: "two-factor", label: "2FA" }),
      Object.freeze({ key: "logs", label: "Protokolle" }),
    ]),
  }),
]);

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function profileNameParts(value) {
  const parts = String(value || "").trim().split(/\s+/u).filter(Boolean);
  return {
    firstName: parts.shift() || "",
    secondFirstName: parts.join(" "),
  };
}

function dateInputValue(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function emptyProfile(user, shell) {
  const displayName = user?.displayName
    || shell?.identity?.displayName
    || user?.name
    || user?.loginName
    || "";
  return {
    firstName: "",
    secondFirstName: "",
    lastName: "",
    nickname: "",
    displayName,
    birthDate: "",
    email: user?.email || shell?.identity?.email || "",
  };
}

function profileDraft(result, user, shell) {
  const person = result?.person || {};
  const names = Object.prototype.hasOwnProperty.call(person, "secondFirstName")
    ? { firstName: person.firstName || "", secondFirstName: person.secondFirstName || "" }
    : profileNameParts(person.firstName);
  return {
    firstName: names.firstName,
    secondFirstName: names.secondFirstName,
    lastName: person.lastName || "",
    nickname: person.nickname || "",
    displayName: person.displayName || emptyProfile(user, shell).displayName,
    birthDate: dateInputValue(person.birthDate),
    email: result?.email || person.email || emptyProfile(user, shell).email,
  };
}

function SettingsNotice({ error, notice }) {
  if (error) return <p className="bonni-user-settings__notice is-error" role="alert">{error}</p>;
  if (notice) return <p className="bonni-user-settings__notice is-success" role="status">{notice}</p>;
  return null;
}

function ProfileDataPanel({ token, user, shell, onProfileUpdated }) {
  const [draft, setDraft] = useState(() => emptyProfile(user, shell));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetchOwnProfile(token, { signal: controller.signal })
      .then((result) => setDraft(profileDraft(result, user, shell)))
      .catch((loadError) => {
        if (loadError?.name !== "AbortError") {
          setError(loadError?.message || "Die Profildaten konnten nicht geladen werden.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, user?.id, user?.accountId]);

  function patch(key, value) {
    setNotice("");
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await updateOwnProfile(token, draft);
      setDraft(profileDraft(result, user, shell));
      onProfileUpdated?.(result);
      setNotice("Die Profildaten wurden gespeichert.");
    } catch (saveError) {
      setError(saveError?.message || "Die Profildaten konnten nicht gespeichert werden.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="bonni-user-settings__form" onSubmit={save}>
      <p className="bonni-user-settings__intro">Persönliche Angaben, die zentral für Bonni Core und alle angebundenen Apps gelten.</p>
      <SettingsNotice error={error} notice={notice} />
      {loading ? <p className="bonni-user-settings__loading" role="status">Profildaten werden geladen …</p> : null}
      <div className="bonni-user-settings__fields">
        <label><span>Vorname</span><input value={draft.firstName} onChange={(event) => patch("firstName", event.target.value)} maxLength={100} disabled={loading || saving} /></label>
        <label><span>2. Vorname</span><input value={draft.secondFirstName} onChange={(event) => patch("secondFirstName", event.target.value)} maxLength={100} disabled={loading || saving} /></label>
        <label className="is-wide"><span>Nachname</span><input value={draft.lastName} onChange={(event) => patch("lastName", event.target.value)} maxLength={100} disabled={loading || saving} /></label>
        <label><span>Spitzname</span><input value={draft.nickname} onChange={(event) => patch("nickname", event.target.value)} maxLength={100} disabled={loading || saving} /></label>
        <label><span>Anzeigename</span><input value={draft.displayName} onChange={(event) => patch("displayName", event.target.value)} maxLength={160} required disabled={loading || saving} /></label>
        <label><span>Geburtstag</span><input type="date" value={draft.birthDate} onChange={(event) => patch("birthDate", event.target.value)} disabled={loading || saving} /></label>
        <label><span>E-Mail-Adresse</span><input type="email" value={draft.email} onChange={(event) => patch("email", event.target.value)} maxLength={200} disabled={loading || saving} /></label>
      </div>
      <div className="bonni-user-settings__actions">
        <button type="submit" className="is-primary" disabled={loading || saving || !draft.displayName.trim()}>
          {saving ? "Wird gespeichert …" : "Speichern"}
        </button>
      </div>
    </form>
  );
}

function initials(user, shell) {
  const name = user?.displayName || shell?.identity?.displayName || user?.loginName || "B";
  return String(name).split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function ProfileImagePanel({ user, shell, brandingPanel }) {
  const imageUrl = user?.profileImageUrl || user?.avatarUrl || shell?.identity?.profileImageUrl || "";
  return (
    <div className="bonni-user-settings__stack">
      <section className="bonni-user-settings__panel">
        <p className="bonni-user-settings__eyebrow">Persönliches Benutzerbild</p>
        <h3>Bild im User Panel</h3>
        <div className="bonni-user-settings__image-row">
          <span className="bonni-user-settings__avatar">
            {imageUrl ? <img src={imageUrl} alt="Aktuelles Benutzerbild" /> : initials(user, shell)}
          </span>
          <div>
            <p>Das Benutzerbild wird in der Benutzerakte und im User Panel verwendet.</p>
            <button type="button" disabled>Bild auswählen</button>
            <small>Der geschützte Bildupload wird mit der persönlichen Medienablage angebunden.</small>
          </div>
        </div>
      </section>
      {brandingPanel}
    </div>
  );
}

function RightsPanel({ user, shell }) {
  const roles = [...asList(user?.roles), ...asList(shell?.identity?.roles)];
  const permissions = [
    ...asList(user?.permissions),
    ...asList(user?.permissions?.permissions),
    ...asList(shell?.identity?.permissions),
  ];
  const roleLabels = [...new Set(roles.map((entry) => String(entry?.label || entry?.name || entry?.key || entry)).filter(Boolean))];
  const permissionLabels = [...new Set(permissions.map((entry) => String(entry?.label || entry?.name || entry?.key || entry)).filter(Boolean))];
  return (
    <div className="bonni-user-settings__stack">
      <p className="bonni-user-settings__intro">Die Benutzerakte zeigt die aktuell wirksamen Rollen und Berechtigungen nur lesend an.</p>
      <section className="bonni-user-settings__panel">
        <p className="bonni-user-settings__eyebrow">Rollen</p>
        <div className="bonni-user-settings__chips">
          {roleLabels.length ? roleLabels.map((role) => <span key={role}>{role}</span>) : <span>Keine Rolle gemeldet</span>}
        </div>
      </section>
      <section className="bonni-user-settings__panel">
        <p className="bonni-user-settings__eyebrow">Berechtigungen</p>
        <div className="bonni-user-settings__rights-list">
          {permissionLabels.length
            ? permissionLabels.slice(0, 30).map((permission) => <span key={permission}>{permission}</span>)
            : <span>Keine einzelnen Berechtigungen gemeldet.</span>}
        </div>
      </section>
    </div>
  );
}

const HISTORY_LABELS = Object.freeze({
  USER_PROFILE_UPDATED: ["Profildaten geändert", "Persönliche Daten wurden aktualisiert."],
  USER_PASSWORD_CHANGED: ["Passwort geändert", "Das Passwort und die laufenden Sitzungen wurden erneuert."],
  USER_PASSWORD_CHANGE_FAILED: ["Passwortänderung fehlgeschlagen", "Die angeforderte Passwortänderung wurde nicht ausgeführt."],
  USER_PASSWORD_CHANGE_BLOCKED: ["Passwortänderung blockiert", "Die Passwortänderung wurde durch eine Sicherheitsprüfung verhindert."],
  SYSTEM_BRANDING_UPDATED: ["Darstellung geändert", "Der sichtbare Name oder der Alternativtext wurde aktualisiert."],
  SYSTEM_BRANDING_LOGO_UPDATED: ["Logo geändert", "Das zentrale Logo wurde aktualisiert."],
  SYSTEM_BRANDING_LOGO_RESET: ["Logo zurückgesetzt", "Das zentrale Standardlogo wurde wiederhergestellt."],
  TWO_FACTOR_TOTP_ENABLED: ["2FA aktiviert", "Die Zwei-Faktor-Authentifizierung wurde eingerichtet."],
  TWO_FACTOR_DISABLED_FAIL_CLOSED: ["2FA deaktiviert", "Die Zwei-Faktor-Verknüpfung wurde sicher beendet."],
  TWO_FACTOR_RECOVERY_CODES_REGENERATED: ["Recoverycodes erneuert", "Neue Wiederherstellungscodes wurden erzeugt."],
  ACCOUNT_RECOVERY_PASSWORD_COMPLETED: ["Passwort wiederhergestellt", "Die Kontowiederherstellung wurde abgeschlossen."],
});

function HistoryPanel({ token, securityOnly = false }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setEntries([]);
    setError("");
    fetchOwnChangeHistory(token, { signal: controller.signal, scope: securityOnly ? "security" : undefined })
      .then((result) => {
        const next = asList(result?.entries).slice(0, 4);
        setEntries(next);
      })
      .catch((loadError) => {
        if (loadError?.name !== "AbortError") setError(loadError?.message || "Der Verlauf konnte nicht geladen werden.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, securityOnly]);

  return (
    <section>
      <p className="bonni-user-settings__intro">Die letzten vier Änderungen in zeitlicher Reihenfolge.</p>
      {error ? <SettingsNotice error={error} /> : null}
      {loading ? <p className="bonni-user-settings__loading" role="status">Änderungsverlauf wird geladen …</p> : null}
      {!loading && !entries.length ? <p className="bonni-user-settings__empty">Noch keine protokollierten Änderungen vorhanden.</p> : null}
      <ol className="bonni-user-settings__timeline" aria-label="Änderungsverlauf">
        {entries.map((entry) => {
          const [title, description] = HISTORY_LABELS[entry.event] || ["Änderung", entry.event];
          const date = new Date(entry.createdAt);
          return (
            <li key={entry.id}>
              <span className="bonni-user-settings__timeline-dot" aria-hidden="true" />
              <span><strong>{title}</strong><small>{description}</small></span>
              <time dateTime={entry.createdAt}>
                <span>{Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("de-DE")}</span>
                <small>{Number.isNaN(date.getTime()) ? "" : `${date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr`}</small>
              </time>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function LockedBankPanel({ kind }) {
  const paypal = kind === "paypal";
  return (
    <section className="bonni-user-settings__panel bonni-user-settings__bank">
      <p className="bonni-user-settings__eyebrow">{paypal ? "PayPal-Konto" : "Bankkonto"}</p>
      <h3>{paypal ? "Persönliches PayPal-Konto" : "Persönliche Bankverbindung"}</h3>
      <p>Bankdaten gehören zum verschlüsselten persönlichen Datenbereich und werden nicht im Browser zwischengespeichert.</p>
      <div className="bonni-user-settings__locked-fields" role="group" aria-label="Geschützte Bankdaten">
        {paypal ? (
          <label><span>PayPal-E-Mail-Adresse</span><input type="email" disabled placeholder="Nach sicherer Freigabe verfügbar" /></label>
        ) : (
          <>
            <label><span>Kontoinhaber</span><input disabled placeholder="Nach sicherer Freigabe verfügbar" /></label>
            <label><span>IBAN</span><input disabled placeholder="Nach sicherer Freigabe verfügbar" /></label>
            <label><span>BIC</span><input disabled placeholder="Nach sicherer Freigabe verfügbar" /></label>
          </>
        )}
      </div>
      <p className="bonni-user-settings__secure-note">Die Speicherung wird erst nach einer persönlichen 2FA-Freigabe über den geschützten People-Datendienst aktiviert.</p>
    </section>
  );
}

const PRIVACY_COPY = Object.freeze({
  "bonni-core": ["Bonni Core", "Zentrale Anmeldung, Benutzerkonto, Rollen und Plattformdienste."],
  stueberl: ["StüberlApp", "Käufe, Bierdeckelvorgänge und persönliche Stüberldaten."],
  kontor: ["KontorApp", "Mitgliedschafts-, Dokumenten- und Organisationsdaten."],
  meet: ["MeetApp", "Konferenzen, Einladungen, Kamera und Mikrofon."],
});

function PrivacyPanel({ tab, user, shell }) {
  const confirmations = asList(user?.privacyConfirmations || shell?.identity?.privacyConfirmations);
  if (tab === "confirmations") {
    return (
      <section className="bonni-user-settings__panel">
        <p className="bonni-user-settings__eyebrow">Bestätigungen</p>
        <h3>Datenschutzverlauf</h3>
        {confirmations.length ? (
          <div className="bonni-user-settings__confirmations">
            {confirmations.map((entry, index) => (
              <div key={entry?.id || index}><strong>{entry?.label || entry?.app || "Datenschutz"}</strong><span>{entry?.confirmedAt || "Bestätigt"}</span></div>
            ))}
          </div>
        ) : <p>Noch keine zentral gemeldeten Bestätigungen vorhanden.</p>}
      </section>
    );
  }
  const [title, copy] = PRIVACY_COPY[tab] || ["Datenschutz", "Datenschutzhinweise"];
  const confirmation = confirmations.find((entry) => String(entry?.key || entry?.app || "").toLowerCase().includes(tab));
  return (
    <section className="bonni-user-settings__panel">
      <p className="bonni-user-settings__eyebrow">Datenschutz</p>
      <h3>{title}</h3>
      <p>{copy}</p>
      <span className={`bonni-user-settings__status${confirmation ? " is-confirmed" : ""}`}>
        {confirmation ? "Bestätigt" : "Keine Bestätigung hinterlegt"}
      </span>
    </section>
  );
}

function PasswordPanel({ token, recoveryPanel, onSessionRevoked, onSessionInvalidated }) {
  const [values, setValues] = useState({ currentPassword: "", newPassword: "", newPasswordConfirmation: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (values.newPassword !== values.newPasswordConfirmation) {
      setError("Die neuen Passwörter stimmen nicht überein.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await changeOwnPassword(token, values);
      setValues({ currentPassword: "", newPassword: "", newPasswordConfirmation: "" });
      onSessionInvalidated?.();
      onSessionRevoked?.("Das Passwort wurde geändert. Alle bisherigen Sitzungen wurden beendet. Bitte melde dich erneut an.");
    } catch (changeError) {
      setValues((current) => ({ ...current, currentPassword: "", newPassword: "", newPasswordConfirmation: "" }));
      setError(changeError?.message || "Das Passwort konnte nicht geändert werden.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bonni-user-settings__stack">
      <form className="bonni-user-settings__form" onSubmit={submit}>
        <p className="bonni-user-settings__intro">Das Passwort gilt zentral für Bonni Core und alle angebundenen Apps.</p>
        <SettingsNotice error={error} />
        <div className="bonni-user-settings__fields">
          <label className="is-wide"><span>Aktuelles Passwort</span><input type="password" value={values.currentPassword} onChange={(event) => setValues((current) => ({ ...current, currentPassword: event.target.value }))} autoComplete="current-password" required disabled={busy} /></label>
          <label><span>Neues Passwort</span><input type="password" value={values.newPassword} onChange={(event) => setValues((current) => ({ ...current, newPassword: event.target.value }))} autoComplete="new-password" required minLength={6} disabled={busy} /></label>
          <label><span>Passwort wiederholen</span><input type="password" value={values.newPasswordConfirmation} onChange={(event) => setValues((current) => ({ ...current, newPasswordConfirmation: event.target.value }))} autoComplete="new-password" required minLength={6} disabled={busy} /></label>
        </div>
        <div className="bonni-user-settings__actions"><button className="is-primary" type="submit" disabled={busy}>{busy ? "Wird geändert …" : "Passwort ändern"}</button></div>
      </form>
      {recoveryPanel}
    </div>
  );
}

export default function UserSettingsSection({
  activeKey,
  token,
  user,
  shell,
  brandingPanel,
  recoveryPanel,
  twoFactorPanel,
  onSessionRevoked,
  onSessionInvalidated,
  onProfileUpdated,
}) {
  const [section, tab] = String(activeKey || "profile:data").split(":");
  const view = useMemo(() => {
    if (section === "profile" && tab === "data") return <ProfileDataPanel token={token} user={user} shell={shell} onProfileUpdated={onProfileUpdated} />;
    if (section === "profile" && tab === "image") return <ProfileImagePanel user={user} shell={shell} brandingPanel={brandingPanel} />;
    if (section === "profile" && tab === "rights") return <RightsPanel user={user} shell={shell} />;
    if (section === "profile" && tab === "logs") return <HistoryPanel token={token} />;
    if (section === "bank") return <LockedBankPanel kind={tab === "paypal" ? "paypal" : "bank"} />;
    if (section === "privacy" && tab === "erasure") {
      const type = String(user?.type || shell?.identity?.type || "").toUpperCase();
      if (isBootstrapAdminLoginName(user?.loginName || shell?.identity?.loginName)) return <p>Der feste Systembenutzer admin ist von der Kontolöschung ausgenommen.</p>;
      if (!["MEMBER", "ADMIN"].includes(type)) return <p>Der Löschantrag ist für persönliche Benutzerkonten vorgesehen.</p>;
      return <SystemErasurePanel token={token} actorAccountId={user?.accountId || shell?.identity?.accountId || user?.id}/>;
    }
    if (section === "privacy") return <PrivacyPanel tab={tab} user={user} shell={shell} />;
    if (section === "security" && tab === "password") {
      return <PasswordPanel token={token} recoveryPanel={recoveryPanel} onSessionRevoked={onSessionRevoked} onSessionInvalidated={onSessionInvalidated} />;
    }
    if (section === "security" && tab === "two-factor") return twoFactorPanel;
    if (section === "security" && tab === "logs") return <HistoryPanel token={token} securityOnly />;
    return null;
  }, [
    activeKey,
    token,
    user,
    shell,
    brandingPanel,
    recoveryPanel,
    twoFactorPanel,
    onSessionRevoked,
    onSessionInvalidated,
    onProfileUpdated,
  ]);

  return view;
}
