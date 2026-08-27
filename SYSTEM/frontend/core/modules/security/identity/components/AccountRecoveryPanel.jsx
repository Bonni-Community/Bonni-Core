import React, { useCallback, useEffect, useRef, useState } from "react";

import { accountRecoveryApi } from "../api/accountRecoveryApi.js";
import ProviderProofForm from "../../two-factor/components/ProviderProofForm.jsx";
import "./AccountRecoveryPanel.css";
import "./AccountRecoverySearch.css";

const EMPTY_POLICY_DRAFT = Object.freeze({ reviewerAccountIds: "", threshold: "3" });

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function decisionAllowed(request) {
  return Boolean(
    request
    && request.canDecide === true
    && request.targetIsCurrentAccount === false
    && request.status === "PENDING"
  );
}

function requestStatusLabel(status) {
  if (status === "APPROVED") return "Freigegeben";
  if (status === "REJECTED") return "Abgelehnt";
  if (status === "EXPIRED") return "Abgelaufen";
  return "Wird geprüft";
}

function blockedDecisionMessage(request) {
  if (request.targetIsCurrentAccount) return "Das Zielkonto kann seinen eigenen Antrag nicht bestaetigen oder ablehnen.";
  if (request.status === "APPROVED") return "Die erforderliche Schwelle ist erreicht. Eine weitere Entscheidung ist nicht moeglich.";
  if (request.status === "REJECTED") return "Der Ablehnungs-Quorum ist erreicht. Eine einzelne Ablehnung entsperrt kein Konto.";
  if (request.status === "EXPIRED") return "Der Antrag ist abgelaufen und kann nicht mehr entschieden werden.";
  return "Du hast bereits entschieden oder bist fuer diesen Antrag nicht entscheidungsberechtigt.";
}

function policyProposalFromDraft(draft) {
  const reviewerAccountIds = String(draft?.reviewerAccountIds || "")
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const thresholdText = String(draft?.threshold || "");
  const threshold = /^[3-6]$/u.test(thresholdText) ? Number(thresholdText) : 0;
  if (
    reviewerAccountIds.length < 3
    || reviewerAccountIds.length > 6
    || new Set(reviewerAccountIds).size !== reviewerAccountIds.length
    || reviewerAccountIds.some((entry) => !/^[A-Za-z0-9:_-]{1,180}$/u.test(entry))
    || threshold < 3
    || threshold > reviewerAccountIds.length
  ) {
    throw new Error("Die Richtlinie braucht 3 bis 6 eindeutige Konto-IDs und eine Schwelle von mindestens 3.");
  }
  return { reviewerAccountIds, threshold };
}

/**
 * Authenticated Core-only view. All transport DTOs are normalized by the
 * strict native adapter; the view never derives request identity.
 */
export default function AccountRecoveryPanel({
  token,
  canManagePolicy = false,
  api = accountRecoveryApi,
}) {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [targetAccountId, setTargetAccountId] = useState("");
  const [referenceFilter, setReferenceFilter] = useState("");
  const [proofAction, setProofAction] = useState(null);
  const [issuedSupportCode, setIssuedSupportCode] = useState(null);
  const [policyDraft, setPolicyDraft] = useState(EMPTY_POLICY_DRAFT);
  const controllerRef = useRef(null);
  const mountedRef = useRef(true);
  const actionLatchRef = useRef(false);
  const supportCodeRef = useRef(null);
  const supportCodeNodeRef = useRef(null);
  const activeReferenceRef = useRef("");

  const purgeProofAction = useCallback(() => {
    actionLatchRef.current = false;
    if (mountedRef.current) setProofAction(null);
  }, []);

  const purgeSupportCode = useCallback(() => {
    if (supportCodeNodeRef.current) supportCodeNodeRef.current.textContent = "";
    if (supportCodeRef.current) supportCodeRef.current.supportCode = undefined;
    supportCodeRef.current = null;
    if (mountedRef.current) setIssuedSupportCode(null);
  }, []);

  const abortAndPurge = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    purgeProofAction();
    purgeSupportCode();
  }, [purgeProofAction, purgeSupportCode]);

  function nextController() {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller;
  }

  async function load({ quiet = false, reference = activeReferenceRef.current } = {}) {
    const controller = nextController();
    if (!quiet) setLoading(true);
    setError("");
    try {
      const result = await api.getOverview(token, {
        signal: controller.signal,
        ...(reference ? { reference } : {}),
      });
      if (controller.signal.aborted || !mountedRef.current) return null;
      setOverview(result);
      if (result.policy && !actionLatchRef.current) {
        setPolicyDraft({
          reviewerAccountIds: result.policy.reviewerAccountIds.join("\n"),
          threshold: String(result.policy.threshold),
        });
      }
      return result;
    } catch (loadError) {
      if (loadError?.name !== "AbortError" && !controller.signal.aborted && mountedRef.current) {
        setOverview(null);
        setError("Die neutrale Wiederherstellungsuebersicht konnte nicht geladen werden.");
      }
      return null;
    } finally {
      if (!quiet && mountedRef.current && controllerRef.current === controller) setLoading(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    load();
    const handlePageHide = () => abortAndPurge();
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("pagehide", handlePageHide);
      controllerRef.current?.abort();
      controllerRef.current = null;
      actionLatchRef.current = false;
      if (supportCodeNodeRef.current) supportCodeNodeRef.current.textContent = "";
      if (supportCodeRef.current) supportCodeRef.current.supportCode = undefined;
      supportCodeRef.current = null;
      activeReferenceRef.current = "";
    };
  }, [api, token, abortAndPurge]);

  useEffect(() => {
    if (!proofAction?.challenge?.expiresAt) return undefined;
    const delay = Date.parse(proofAction.challenge.expiresAt) - Date.now();
    if (delay <= 0) {
      purgeProofAction();
      return undefined;
    }
    const timeout = window.setTimeout(purgeProofAction, Math.min(delay, 2_147_000_000));
    return () => window.clearTimeout(timeout);
  }, [proofAction?.challenge?.id, proofAction?.challenge?.expiresAt, purgeProofAction]);

  useEffect(() => {
    if (!issuedSupportCode?.expiresAt) return undefined;
    const delay = Date.parse(issuedSupportCode.expiresAt) - Date.now();
    if (delay <= 0) {
      purgeSupportCode();
      return undefined;
    }
    const timeout = window.setTimeout(purgeSupportCode, Math.min(delay, 2_147_000_000));
    return () => window.clearTimeout(timeout);
  }, [issuedSupportCode?.expiresAt, purgeSupportCode]);

  async function initiateRecovery(event) {
    event.preventDefault();
    if (busy || overview?.canInitiate !== true) return;
    setBusy(true);
    setError("");
    setNotice("");
    const controller = nextController();
    try {
      const result = await api.initiate(token, { targetAccountId }, { signal: controller.signal });
      if (controller.signal.aborted || !mountedRef.current) return;
      setTargetAccountId("");
      setReferenceFilter("");
      activeReferenceRef.current = "";
      setNotice(`Der Vorgang ${result.request.reference} wurde neutral angelegt oder bereits gefunden.`);
      setBusy(false);
      await load({ quiet: true });
    } catch (initiateError) {
      if (initiateError?.name !== "AbortError" && !controller.signal.aborted && mountedRef.current) {
        setError(initiateError?.message || "Der Support-Vorgang konnte nicht angelegt werden.");
      }
    } finally {
      if (mountedRef.current && controllerRef.current === controller) setBusy(false);
    }
  }

  async function beginDecision(request, decision) {
    if (busy || actionLatchRef.current || !decisionAllowed(request)) return;
    if (decision !== "APPROVE" && decision !== "REJECT") return;
    actionLatchRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const controller = nextController();
    try {
      const result = await api.createDecisionChallenge(token, request.id, decision, { signal: controller.signal });
      if (controller.signal.aborted || !mountedRef.current) return;
      setProofAction({ kind: "decision", requestId: request.id, decision, challenge: result.challenge });
    } catch (challengeError) {
      actionLatchRef.current = false;
      if (challengeError?.name !== "AbortError" && !controller.signal.aborted && mountedRef.current) {
        setError("Die frische Sicherheitsabfrage konnte nicht erstellt werden.");
      }
    } finally {
      if (mountedRef.current && controllerRef.current === controller) setBusy(false);
    }
  }

  async function searchReference(event) {
    event.preventDefault();
    if (busy) return;
    if (referenceFilter && !/^PR-[A-Z2-9]{5}-[A-Z2-9]{5}$/u.test(referenceFilter)) {
      setError("Bitte die vollstaendige Vorgangsnummer im Format PR-XXXXX-XXXXX eingeben.");
      return;
    }
    setError("");
    activeReferenceRef.current = referenceFilter;
    await load({ reference: referenceFilter });
  }

  async function clearReferenceSearch() {
    if (busy) return;
    setReferenceFilter("");
    activeReferenceRef.current = "";
    await load({ reference: "" });
  }

  async function beginSupportCode(request) {
    if (busy || actionLatchRef.current || request?.status !== "APPROVED" || request?.targetIsCurrentAccount) return;
    purgeSupportCode();
    actionLatchRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const controller = nextController();
    try {
      const result = await api.createSupportCodeChallenge(token, request.id, { signal: controller.signal });
      if (controller.signal.aborted || !mountedRef.current) return;
      setProofAction({ kind: "support", requestId: request.id, challenge: result.challenge });
    } catch (challengeError) {
      actionLatchRef.current = false;
      if (challengeError?.name !== "AbortError" && !controller.signal.aborted && mountedRef.current) {
        setError(challengeError?.message || "Der einmalige Support-Code ist nicht verfuegbar.");
      }
    } finally {
      if (mountedRef.current && controllerRef.current === controller) setBusy(false);
    }
  }

  async function beginPolicyUpdate() {
    if (busy || actionLatchRef.current || !canManagePolicy) return;
    let proposal;
    try {
      proposal = policyProposalFromDraft(policyDraft);
    } catch (policyError) {
      setError(policyError.message);
      return;
    }
    actionLatchRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const controller = nextController();
    try {
      const result = await api.createPolicyChallenge(token, proposal, { signal: controller.signal });
      if (controller.signal.aborted || !mountedRef.current) return;
      setProofAction({ kind: "policy", proposal, challenge: result.challenge });
    } catch (challengeError) {
      actionLatchRef.current = false;
      if (challengeError?.name !== "AbortError" && !controller.signal.aborted && mountedRef.current) {
        setError(challengeError?.message || "Die Richtlinienabfrage konnte nicht erstellt werden.");
      }
    } finally {
      if (mountedRef.current && controllerRef.current === controller) setBusy(false);
    }
  }

  async function submitProof(proof) {
    const current = proofAction;
    if (!current || Date.parse(current.challenge.expiresAt) <= Date.now()) {
      purgeProofAction();
      throw new Error("Die Sicherheitsabfrage ist nicht mehr frisch.");
    }
    const request = current.requestId
      ? overview?.requests?.find((entry) => entry.id === current.requestId)
      : null;
    if (current.kind === "decision" && !decisionAllowed(request)) {
      purgeProofAction();
      throw new Error("Die Sicherheitsabfrage gehoert nicht mehr zu einem entscheidbaren Antrag.");
    }
    if (current.kind === "support" && (request?.status !== "APPROVED" || request?.targetIsCurrentAccount)) {
      purgeProofAction();
      throw new Error("Der Support-Code gehoert nicht mehr zu einem freigegebenen Antrag.");
    }
    setBusy(true);
    setError("");
    setNotice("");
    const controller = nextController();
    try {
      if (current.kind === "decision") {
        await api.submitDecision(token, current.requestId, {
          decision: current.decision, challengeId: current.challenge.id, proof,
        }, { signal: controller.signal });
        if (controller.signal.aborted || !mountedRef.current) return;
        purgeProofAction();
        setNotice(current.decision === "APPROVE"
          ? "Deine Bestaetigung wurde gezaehlt. Der Antrag bleibt bis zur erforderlichen Schwelle gesperrt."
          : "Deine Ablehnung wurde gezaehlt. Eine einzelne Entscheidung entsperrt das Konto nicht.");
        setBusy(false);
        await load({ quiet: true });
        return;
      }
      if (current.kind === "support") {
        const result = await api.issueSupportCode(token, current.requestId, {
          challengeId: current.challenge.id, proof,
        }, { signal: controller.signal });
        if (controller.signal.aborted || !mountedRef.current) {
          result.supportCode = undefined;
          return;
        }
        const oneShot = { supportCode: result.supportCode, expiresAt: result.expiresAt };
        result.supportCode = undefined;
        purgeProofAction();
        supportCodeRef.current = oneShot;
        setIssuedSupportCode(oneShot);
        setNotice("Der Support-Code wird genau einmal angezeigt und muss getrennt uebermittelt werden.");
        return;
      }
      if (current.kind === "policy") {
        await api.updatePolicy(token, {
          ...current.proposal, challengeId: current.challenge.id, proof,
        }, { signal: controller.signal });
        if (controller.signal.aborted || !mountedRef.current) return;
        purgeProofAction();
        setNotice("Die Wiederherstellungsrichtlinie wurde gespeichert.");
        setBusy(false);
        await load({ quiet: true });
      }
    } catch (proofError) {
      purgeProofAction();
      if (proofError?.name !== "AbortError" && !controller.signal.aborted && mountedRef.current) {
        setError(proofError?.message || "Die Sicherheitsaktion konnte nicht gespeichert werden.");
      }
      throw proofError;
    } finally {
      if (mountedRef.current && controllerRef.current === controller) setBusy(false);
    }
  }

  async function copyAndHideSupportCode() {
    const code = supportCodeRef.current?.supportCode;
    if (!code) return;
    let pendingCopy;
    try {
      pendingCopy = typeof navigator.clipboard?.writeText === "function"
        ? navigator.clipboard.writeText(code)
        : Promise.reject(new Error("CLIPBOARD_UNAVAILABLE"));
    } catch {
      pendingCopy = Promise.reject(new Error("CLIPBOARD_UNAVAILABLE"));
    }
    purgeSupportCode();
    try {
      await pendingCopy;
      if (mountedRef.current) setNotice("Der Support-Code wurde kopiert und in Bonni ausgeblendet.");
    } catch {
      if (mountedRef.current) setError("Der Support-Code wurde sicher ausgeblendet; die Zwischenablage war nicht verfuegbar.");
    }
  }

  const requests = Array.isArray(overview?.requests) ? overview.requests : [];
  const canInitiate = overview?.canInitiate === true;
  const activeRequest = proofAction?.requestId
    ? requests.find((request) => request.id === proofAction.requestId)
    : null;
  const challenge = proofAction?.challenge;

  return (
    <div className="bonni-account-recovery">
      <div className="bonni-my-settings__heading">
        <div><p className="bonni-2fa-eyebrow">Kontowiederherstellung</p><h2>Notfall</h2><p>Hier siehst du nur Informationen und Entscheidungen, fuer die dein Konto ausdruecklich berechtigt ist.</p></div>
        <span className="bonni-2fa-status">{loading ? "Wird geprüft" : "Bereit"}</span>
      </div>
      {error ? <p className="bonni-2fa-alert is-error" role="alert">{error}</p> : null}
      {notice ? <p className="bonni-2fa-alert is-success" role="status">{notice}</p> : null}
      {loading ? <section className="bonni-2fa-card">Uebersicht wird geladen …</section> : null}

      {!loading && overview ? (
        <>
          <section className="bonni-2fa-card bonni-account-recovery__overview">
            <div><p className="bonni-2fa-eyebrow">Eigener Status</p><h3>Neutrale Sicherheitsuebersicht</h3></div>
            <p>{overview.canReview
              ? "Dein Konto darf offene Wiederherstellungsantraege pruefen. Jede Entscheidung benoetigt eine frische Core-2FA-Bestaetigung."
              : "Fuer dein Konto liegen keine internen Pruefaufgaben vor."}</p>
          </section>

          {canInitiate ? (
            <form className="bonni-2fa-card bonni-account-recovery__initiate" onSubmit={initiateRecovery}>
              <div><p className="bonni-2fa-eyebrow">Support-Vorgang</p><h3>Wiederherstellung fuer ein Zielkonto anstossen</h3><p>Verwende die eindeutige Bonni-Konto-ID. Die Berechtigung wird serverseitig erneut geprueft.</p></div>
              <label className="bonni-2fa-field"><span>Zielkonto-ID</span><input value={targetAccountId} onChange={(event) => setTargetAccountId(event.target.value)} autoComplete="off" required disabled={busy} /></label>
              <div className="bonni-2fa-actions"><button type="submit" className="is-primary" disabled={busy || !targetAccountId}>Vorgang anlegen</button></div>
            </form>
          ) : null}

          {overview.policy || canManagePolicy ? (
            <section className="bonni-2fa-card bonni-account-recovery__policy">
              <div><p className="bonni-2fa-eyebrow">Richtlinie</p><h3>Wiederherstellungsrichtlinie</h3></div>
              {overview.policy ? <dl><div><dt>Zusaetzliche Notfallberechtigte</dt><dd>{overview.policy.reviewerAccountIds.length}</dd></div><div><dt>Erforderliche Schwelle</dt><dd>{overview.policy.threshold}</dd></div></dl> : <p>Noch keine gespeicherte Richtlinie.</p>}
              {canManagePolicy ? (
                <div className="bonni-account-recovery__policy-form">
                  <label className="bonni-2fa-field"><span>3 bis 6 zusaetzliche Notfallberechtigte, jeweils eine Konto-ID pro Zeile</span><textarea value={policyDraft.reviewerAccountIds} onChange={(event) => setPolicyDraft((current) => ({ ...current, reviewerAccountIds: event.target.value }))} rows={5} disabled={busy || proofAction?.kind === "policy"} /></label>
                  <label className="bonni-2fa-field"><span>Erforderliche Schwelle</span><input type="number" min="3" max="6" step="1" value={policyDraft.threshold} onChange={(event) => setPolicyDraft((current) => ({ ...current, threshold: event.target.value }))} disabled={busy || proofAction?.kind === "policy"} /></label>
                  <div className="bonni-2fa-actions"><button type="button" className="is-primary" onClick={beginPolicyUpdate} disabled={busy || Boolean(proofAction)}>Mit Core-2FA pruefen</button></div>
                </div>
              ) : null}
              <p>Aktive persoenliche Administratoren bleiben kraft Core-Rolle berechtigt. Zusaetzlich sind nur 3 bis 6 eindeutige Konten mit einer Schwelle von mindestens 3 und einer vorschlagsgebundenen frischen Core-2FA-Abfrage zulaessig.</p>
            </section>
          ) : null}

          {overview.canReview ? (
            <section className="bonni-2fa-card bonni-account-recovery__requests">
              <div><p className="bonni-2fa-eyebrow">Interne Pruefung</p><h3>Offene Antraege</h3></div>
              <form className="bonni-account-recovery__reference-search" onSubmit={searchReference}><label className="bonni-2fa-field"><span>Vorgangsnummer aus Foto oder Support-Anfrage suchen</span><input value={referenceFilter} onChange={(event) => { const value = event.target.value.toUpperCase(); if (/^[A-Z2-9-]{0,14}$/u.test(value)) setReferenceFilter(value); }} placeholder="PR-XXXXX-XXXXX" autoComplete="off" maxLength={14} /></label><div className="bonni-2fa-actions"><button type="button" onClick={clearReferenceSearch} disabled={busy || !activeReferenceRef.current}>Alle anzeigen</button><button type="submit" className="is-primary" disabled={busy}>Vorgang suchen</button></div></form>
              <small className="bonni-account-recovery__search-note">Die vollstaendige Vorgangsnummer wird sicher serverseitig zugeordnet.</small>
              {!requests.length ? <p>{activeReferenceRef.current ? "Unter dieser Vorgangsnummer ist kein sichtbarer Antrag vorhanden." : "Derzeit gibt es keine offenen Antraege."}</p> : (
                <ul>{requests.map((request) => {
                  const allowed = decisionAllowed(request);
                  return <li key={request.id}>
                    <div className="bonni-account-recovery__request-head"><div><strong>{request.targetLabel}</strong><small>Vorgangsnummer {request.reference}</small></div><b>{request.approvals} von {request.threshold} bestaetigt</b></div>
                    <dl><div><dt>Ablauf</dt><dd>{formatDateTime(request.expiresAt)}</dd></div><div><dt>Status</dt><dd>{requestStatusLabel(request.status)}</dd></div></dl>
                    {allowed ? <div className="bonni-2fa-actions"><button type="button" className="is-danger" onClick={() => beginDecision(request, "REJECT")} disabled={busy || Boolean(proofAction)}>Ablehnen</button><button type="button" className="is-primary" onClick={() => beginDecision(request, "APPROVE")} disabled={busy || Boolean(proofAction)}>Bestaetigen</button></div> : <p className="bonni-account-recovery__locked">{blockedDecisionMessage(request)}</p>}
                    {request.status === "APPROVED" && !request.targetIsCurrentAccount ? <div className="bonni-2fa-actions"><button type="button" onClick={() => beginSupportCode(request)} disabled={busy || Boolean(proofAction) || Boolean(issuedSupportCode)}>Einmaligen Support-Code ausgeben</button></div> : null}
                  </li>;
                })}</ul>
              )}
            </section>
          ) : null}

          {issuedSupportCode ? (
            <section className="bonni-2fa-card bonni-account-recovery__one-shot" aria-label="Einmaliger Support-Code">
              <p className="bonni-2fa-eyebrow">Nur einmal sichtbar</p><h3>Support-Code getrennt uebermitteln</h3>
              <code ref={supportCodeNodeRef}>{issuedSupportCode.supportCode}</code>
              <p>Gueltig bis {formatDateTime(issuedSupportCode.expiresAt)}. Der Code wird beim Kopieren, Ausblenden, Seitenwechsel oder Schliessen aus Bonni entfernt.</p>
              <div className="bonni-2fa-actions"><button type="button" onClick={purgeSupportCode}>Sicher ausblenden</button><button type="button" className="is-primary" onClick={copyAndHideSupportCode}>Kopieren und ausblenden</button></div>
            </section>
          ) : null}

          {proofAction && challenge && (proofAction.kind === "policy" || activeRequest) ? (
            <section className="bonni-2fa-card bonni-account-recovery__decision">
              <p className="bonni-2fa-eyebrow">Frische Core-2FA-Bestaetigung</p>
              <h3>{proofAction.kind === "policy"
                ? "Richtlinie bestaetigen"
                : proofAction.kind === "support"
                  ? "Einmaligen Support-Code ausgeben"
                  : proofAction.decision === "APPROVE" ? "Antrag bestaetigen" : "Antrag ablehnen"}</h3>
              {activeRequest ? <p>Ziel: {activeRequest.targetLabel} · Vorgangsnummer {activeRequest.reference}</p> : <p>Der Nachweis ist exakt an diesen Richtlinienvorschlag gebunden.</p>}
              <ProviderProofForm
                key={`${proofAction.kind}:${proofAction.requestId || "policy"}:${challenge.id}`}
                provider={{ id: challenge.provider, label: challenge.providerLabel }}
                proofFields={challenge.proofFields}
                recoveryAllowed={challenge.provider === "local"}
                busy={busy}
                submitLabel={proofAction.kind === "support" ? "Support-Code erzeugen" : proofAction.kind === "policy" ? "Richtlinie speichern" : proofAction.decision === "APPROVE" ? "Bestaetigung zaehlen" : "Ablehnung zaehlen"}
                onVerify={submitProof}
                onCancel={purgeProofAction}
              />
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export { blockedDecisionMessage, decisionAllowed, policyProposalFromDraft };
