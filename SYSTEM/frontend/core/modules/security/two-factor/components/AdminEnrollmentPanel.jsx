import { useEffect, useMemo, useRef, useState } from "react";

import {
  createAdminEnrollmentRequest,
  fetchAdminEnrollmentStatus,
  fetchCurrentTwoFactorStatus,
  rotateAdminEnrollmentRequest,
} from "../api/twoFactorApi.js";
import ProviderProofForm from "./ProviderProofForm.jsx";
import "./AdminEnrollmentPanel.css";

const ADMIN_PASSWORD_BOOTSTRAP_FIELDS = Object.freeze([Object.freeze({
  name: "password",
  label: "Dein aktuelles Administrator-Passwort",
  type: "password",
  autocomplete: "current-password",
  help: "Solange dein Administratorkonto selbst noch keine 2FA besitzt, bestaetigst du den Auftrag mit deinem exakten aktuellen Passwort.",
})]);

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function accountRows(member) {
  const source = asList(member?.accounts).length ? member.accounts : [member];
  return source.map((account) => ({
    accountId: account?.accountId || account?.id || "",
    loginName: account?.loginName || member?.loginName || member?.name || "Unbenanntes Konto",
    active: account?.isActive !== false,
    provider: account?.providerLabel || account?.providerType || account?.providerKey || "Lokal",
  })).filter((account) => typeof account.accountId === "string" && account.accountId.length > 0).slice(0, 20);
}

function requestStatusLabel(status) {
  if (status === "PENDING") return "Bereit";
  if (status === "IN_PROGRESS") return "Freigabepasswort verbraucht";
  if (status === "EXPIRED") return "Abgelaufen";
  return "Kein Auftrag";
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function adminEnrollmentErrorMessage(error, fallback) {
  const code = String(error?.code || error?.data?.code || error?.data?.error || "").toUpperCase();

  if (code === "PERMISSION_DENIED" || code === "FORBIDDEN") {
    return "Dein Konto darf keine 2FA-Auftraege fuer andere Benutzer verwalten.";
  }
  if (code === "TWO_FACTOR_TECHNICAL_ACCOUNT_FORBIDDEN") {
    return "Technische Konten koennen keine persoenliche 2FA erhalten.";
  }
  if (code === "TWO_FACTOR_ACCOUNT_NOT_ELIGIBLE") {
    return "Dieses Zielkonto ist fuer die persoenliche 2FA nicht freigegeben.";
  }

  return error?.message || fallback;
}

export default function AdminEnrollmentPanel({ token, member }) {
  const accounts = useMemo(() => accountRows(member), [member]);
  const [accountId, setAccountId] = useState(accounts[0]?.accountId || "");
  const [adminStatus, setAdminStatus] = useState(null);
  const [targetStatus, setTargetStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState("");
  const [expiresInMinutes, setExpiresInMinutes] = useState(15);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [oneShotPassword, setOneShotPassword] = useState("");
  const oneShotRef = useRef({ password: "", scope: "" });
  const controllerRef = useRef(null);
  const selectedAccount = accounts.find((account) => account.accountId === accountId) || null;
  const currentScope = `${token}:${accountId}:${targetStatus?.request?.id || "none"}`;
  const visibleOneShotPassword = oneShotRef.current.scope === currentScope
    ? oneShotPassword
    : "";

  function purgeOneShot() {
    oneShotRef.current = { password: "", scope: "" };
    setOneShotPassword("");
  }

  function nextController() {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller;
  }

  async function load(nextAccountId = accountId) {
    if (!nextAccountId) return;
    purgeOneShot();
    setAction("");
    setError("");
    setNotice("");
    setLoading(true);
    const controller = nextController();
    try {
      const [nextAdminStatus, nextTargetStatus] = await Promise.all([
        fetchCurrentTwoFactorStatus(token, { signal: controller.signal }),
        fetchAdminEnrollmentStatus(token, nextAccountId, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      if (nextTargetStatus.accountId !== nextAccountId) {
        throw new Error("Der 2FA-Status gehoert nicht zum ausgewaehlten Zielkonto.");
      }
      setAdminStatus(nextAdminStatus);
      setTargetStatus(nextTargetStatus);
    } catch (loadError) {
      purgeOneShot();
      if (loadError?.name !== "AbortError" && !controller.signal.aborted) {
        setAdminStatus(null);
        setTargetStatus(null);
        setError(adminEnrollmentErrorMessage(
          loadError,
          "Der kontogenaue 2FA-Status konnte nicht geladen werden.",
        ));
      }
    } finally {
      if (controllerRef.current === controller) setLoading(false);
    }
  }

  useEffect(() => {
    const firstAccount = accounts[0]?.accountId || "";
    if (!accounts.some((account) => account.accountId === accountId)) setAccountId(firstAccount);
  }, [accounts, accountId]);

  useEffect(() => {
    load(accountId);
    function purgeOnPageHide() {
      controllerRef.current?.abort();
      purgeOneShot();
    }
    function purgeOnScreenshotKey(event) {
      if (event.key === "PrintScreen") purgeOnPageHide();
    }
    window.addEventListener("pagehide", purgeOnPageHide);
    window.addEventListener("keydown", purgeOnScreenshotKey);
    return () => {
      window.removeEventListener("pagehide", purgeOnPageHide);
      window.removeEventListener("keydown", purgeOnScreenshotKey);
      controllerRef.current?.abort();
      oneShotRef.current = { password: "", scope: "" };
    };
  }, [token, accountId]);

  useEffect(() => {
    const expiresAt = Date.parse(targetStatus?.request?.expiresAt || "");
    if (!Number.isFinite(expiresAt)) return undefined;
    const delay = expiresAt - Date.now();
    if (delay <= 0) {
      purgeOneShot();
      return undefined;
    }
    const timeout = window.setTimeout(purgeOneShot, Math.min(delay, 2_147_000_000));
    return () => window.clearTimeout(timeout);
  }, [targetStatus?.request?.id, targetStatus?.request?.expiresAt]);

  function selectAccount(nextAccountId) {
    controllerRef.current?.abort();
    purgeOneShot();
    setTargetStatus(null);
    setAdminStatus(null);
    setAction("");
    setError("");
    setNotice("");
    setAccountId(nextAccountId);
  }

  async function execute(proof) {
    if (!selectedAccount || !action) throw new Error("Bitte ein genaues Zielkonto und eine Aktion auswaehlen.");
    purgeOneShot();
    setBusy(true);
    setError("");
    setNotice("");
    const controller = nextController();
    try {
      const result = action === "rotate"
        ? await rotateAdminEnrollmentRequest(token, targetStatus?.request?.id, {
            expiresInMinutes,
            proof,
          }, { signal: controller.signal })
        : await createAdminEnrollmentRequest(token, {
            accountId: selectedAccount.accountId,
            expiresInMinutes,
            proof,
          }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.accountId !== selectedAccount.accountId) {
        throw new Error("Die Administrator-Antwort gehoert nicht zum ausgewaehlten Zielkonto.");
      }
      setTargetStatus({
        ...result,
        enrollmentPassword: null,
        enrollmentPasswordShownOnce: false,
      });
      setAction("");
      if (result.enrollmentPasswordShownOnce && result.enrollmentPassword) {
        const scope = `${token}:${result.accountId}:${result.request?.id || "none"}`;
        oneShotRef.current = { password: result.enrollmentPassword, scope };
        setOneShotPassword(result.enrollmentPassword);
        setNotice("Das Freigabepasswort ist nur jetzt sichtbar. Uebermittle es ueber einen getrennten Weg.");
      } else if (result.requiresRotation) {
        setNotice("Dieser Auftrag wurde bereits beantwortet. Das alte Freigabepasswort wird nicht erneut angezeigt; bitte ausdruecklich rotieren.");
      } else {
        throw new Error("Der Server hat kein einmalig sichtbares Freigabepasswort geliefert.");
      }
    } catch (actionError) {
      purgeOneShot();
      setAction("");
      if (actionError?.name !== "AbortError" && !controller.signal.aborted) {
        setError(adminEnrollmentErrorMessage(
          actionError,
          "Der 2FA-Auftrag konnte nicht ausgefuehrt werden.",
        ));
      }
      throw actionError;
    } finally {
      if (controllerRef.current === controller) setBusy(false);
    }
  }

  async function copyAndDismiss() {
    const secret = oneShotRef.current.password;
    if (!secret || oneShotRef.current.scope !== currentScope) {
      purgeOneShot();
      return;
    }
    try {
      await navigator.clipboard.writeText(secret);
      purgeOneShot();
      setNotice("Freigabepasswort kopiert und aus Bonni ausgeblendet. Uebermittle es jetzt ueber einen anderen Weg.");
    } catch {
      setError("Das Freigabepasswort konnte nicht kopiert werden. Es bleibt bis zum bewussten Ausblenden sichtbar.");
    }
  }

  if (!accounts.length) {
    return <div className="cc-member-error">Dieser Benutzer besitzt kein eindeutig adressierbares Konto.</div>;
  }

  const request = targetStatus?.request;
  const canRotate = Boolean(request?.id);
  const adminProofFields = adminStatus?.enabled
    ? adminStatus.provider.proofFields
    : ADMIN_PASSWORD_BOOTSTRAP_FIELDS;

  return (
    <section className="cc-two-factor-admin" aria-label="2FA fuer Zielkonto verwalten">
      <header>
        <div><p>Bonni Core Security</p><h3>2FA kontogenau anstossen</h3><span>Der Administrator erhaelt niemals QR-Code, TOTP-Schluessel oder Wiederherstellungscodes.</span></div>
        <b className={targetStatus?.twoFactorActive ? "is-active" : ""}>{targetStatus?.twoFactorActive ? "2FA aktiv" : "2FA nicht aktiv"}</b>
      </header>

      <label className="cc-two-factor-admin__account">
        <span>Exaktes Zielkonto</span>
        <select value={accountId} onChange={(event) => selectAccount(event.target.value)} disabled={busy || loading}>
          {accounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.loginName} · {account.provider}{account.active ? "" : " · deaktiviert"}</option>)}
        </select>
        <small>Konto-ID: <code>{selectedAccount?.accountId}</code></small>
      </label>

      {loading ? <p>Kontostatus wird sicher geladen …</p> : null}
      {error ? <p className="cc-two-factor-admin__alert is-error" role="alert">{error}</p> : null}
      {notice ? <p className="cc-two-factor-admin__alert is-success" role="status">{notice}</p> : null}

      {!loading && targetStatus ? (
        <div className="cc-two-factor-admin__status">
          <div><span>Auftragsstatus</span><strong>{requestStatusLabel(request?.status)}</strong></div>
          <div><span>Erstellt</span><strong>{formatDateTime(request?.requestedAt)}</strong></div>
          <div><span>Gueltig bis</span><strong>{formatDateTime(request?.expiresAt)}</strong></div>
        </div>
      ) : null}

      {visibleOneShotPassword ? (
        <section className="cc-two-factor-admin__one-shot">
          <p>Einmalig sichtbar</p>
          <h4>Freigabepasswort fuer {selectedAccount?.loginName}</h4>
          <code>{visibleOneShotPassword}</code>
          <strong>Nicht im selben Kanal wie das Benutzerpasswort senden. Der Benutzer benoetigt zusaetzlich sein eigenes aktuelles Passwort.</strong>
          <div><button type="button" onClick={() => purgeOneShot()}>Ohne Kopieren ausblenden</button><button type="button" className="is-primary" onClick={copyAndDismiss}>Kopieren und ausblenden</button></div>
        </section>
      ) : null}

      {!loading && targetStatus && !visibleOneShotPassword && !targetStatus.twoFactorActive && !action ? (
        <div className="cc-two-factor-admin__actions">
          <label><span>Gueltigkeit</span><select value={expiresInMinutes} onChange={(event) => setExpiresInMinutes(Number(event.target.value))}><option value={15}>15 Minuten</option><option value={30}>30 Minuten</option><option value={60}>60 Minuten</option></select></label>
          {canRotate ? <button type="button" className="is-primary" onClick={() => setAction("rotate")}>Neues Freigabepasswort erzeugen</button> : <button type="button" className="is-primary" onClick={() => setAction("create")}>2FA-Auftrag erzeugen</button>}
        </div>
      ) : null}

      {action && adminStatus ? (
        <div className="cc-two-factor-admin__proof">
          <h4>{action === "rotate" ? "Rotation frisch bestaetigen" : "Auftrag frisch bestaetigen"}</h4>
          <ProviderProofForm
            provider={adminStatus.provider}
            proofFields={adminProofFields}
            recoveryAllowed={adminStatus.enabled && adminStatus.provider.id === "local"}
            busy={busy}
            submitLabel={action === "rotate" ? "Rotieren und einmalig anzeigen" : "Erzeugen und einmalig anzeigen"}
            onVerify={execute}
            onCancel={() => setAction("")}
          />
        </div>
      ) : null}

      {!loading && targetStatus?.twoFactorActive ? <p className="cc-two-factor-admin__hint">Fuer dieses exakte Konto ist 2FA bereits aktiv. Persoenliche Verwaltung und Recoverycodes bleiben allein beim Benutzer.</p> : null}
      <button type="button" className="cc-two-factor-admin__reload" onClick={() => load(accountId)} disabled={busy || loading}>Status neu laden</button>
    </section>
  );
}
