import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../api/apiClient.js";

export default function MemberPrivacyGate({ token, entry, onUnavailable, children }) {
  const path = `/api/auth/me/member-area/${encodeURIComponent(entry.app)}/${encodeURIComponent(entry.section)}`;
  const [privacy, setPrivacy] = useState(null);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState(false);
  const [language, setLanguage] = useState("de");
  const [submitting, setSubmitting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;

  function fail(failure) {
    setPrivacy(null);
    setChecked(false);
    if (failure?.status === 404) {
      unavailableRef.current?.();
      setError("Dieser Menüpunkt ist gerade nicht verfügbar.");
    } else {
      setError("Der Datenschutzhinweis konnte nicht geprüft werden.");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    apiRequest(path, { token, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setPrivacy(result.privacy);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) fail(failure);
      });
    return () => controller.abort();
  }, [token, path, refresh]);

  function retry() {
    setPrivacy(null);
    setError("");
    setChecked(false);
    setRefresh((value) => value + 1);
    setLanguage("de");
  }

  async function confirm(event) {
    event.preventDefault();
    if (!checked || submitting || !privacy) return;
    setError("");
    setSubmitting(true);
    try {
      const result = await apiRequest(path, {
        token, method: "POST", allowFailover: false, body: { acknowledged: true, version: privacy.version, language },
      });
      setPrivacy(result.privacy);
      if (result.privacy?.acknowledged !== true) {
        setChecked(false);
        setError("Die Bestätigung wurde noch nicht gespeichert.");
      }
    } catch (failure) {
      if (failure?.status === 409) {
        retry();
        setError("Der Datenschutzhinweis wurde aktualisiert. Lies bitte die neue Fassung.");
      } else {
        fail(failure);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (privacy?.acknowledged === true) return children;
  return (
    <section className="bonni-member-privacy" aria-label="Datenschutzhinweis">
      <h1>Datenschutzhinweis · {entry.appLabel}</h1>
      {privacy ? (
        <form onSubmit={confirm}>
          {privacy.translations?.en ? (
            <label>Sprache
              <select value={language} disabled={submitting} onChange={(event) => {
                setLanguage(event.target.value);
                setChecked(false);
              }}>
                <option value="de">Deutsch</option>
                <option value="en">English</option>
              </select>
            </label>
          ) : null}
          <div className="bonni-member-privacy__notice" lang={language} tabIndex={0}>
            {language === "en" ? privacy.translations?.en : privacy.text}
          </div>
          <label>
            <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} disabled={submitting} />
            Ich habe den Datenschutzhinweis gelesen.
          </label>
          <button type="submit" disabled={!checked || submitting}>
            {submitting ? "Bestätigung wird gespeichert …" : "Bestätigen"}
          </button>
        </form>
      ) : (!error ? <p role="status">Datenschutzhinweis wird geladen …</p> : null)}
      {error ? <p role="alert">{error}</p> : null}
      {error && !privacy ? <button type="button" onClick={retry}>Erneut prüfen</button> : null}
    </section>
  );
}
