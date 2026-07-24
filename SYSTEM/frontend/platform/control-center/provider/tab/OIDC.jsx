const EMPTY_OIDC = {
  enabled: false,
  issuerUrl: "",
  clientId: "",
  clientSecret: "",
  redirectUri: "",
  postLogoutRedirectUri: "",
};

function normalizeOidc(settings) {
  return {
    ...EMPTY_OIDC,
    ...(settings?.oidc || {}),
    clientSecret: "",
  };
}

function Field({ label, value, onChange, placeholder, type = "text", help }) {
  return (
    <label className="cc-system-field">
      <span>{label}</span>
      <input
        type={type}
        value={value || ""}
        placeholder={placeholder || ""}
        onChange={(event) => onChange(event.target.value)}
      />
      {help ? <small>{help}</small> : null}
    </label>
  );
}

export { EMPTY_OIDC, normalizeOidc };

export default function OidcTab({ oidc, settings, onPatch }) {
  const runtime = settings?.runtime || {};

  return (
    <div className="cc-system-tab-panel">
      <div className="cc-system-card">
        <div className="cc-system-card__header">
          <div>
            <h2>Anmeldung</h2>
            <p>Hier legst du fest, ob Bonni lokal oder über einen externen Provider laufen soll.</p>
          </div>
          <span className={`cc-system-status ${oidc.enabled ? "cc-system-status--green" : "cc-system-status--gray"}`}>
            {oidc.enabled ? "OIDC aktiv" : "Lokal aktiv"}
          </span>
        </div>

        <div className="cc-system-choice-grid">
          <button
            type="button"
            className={!oidc.enabled ? "cc-system-choice cc-system-choice--active" : "cc-system-choice"}
            onClick={() => onPatch({ enabled: false })}
          >
            <strong>Lokal</strong>
            <span>Login über lokale Bonni-Benutzer.</span>
          </button>
          <button
            type="button"
            className={oidc.enabled ? "cc-system-choice cc-system-choice--active" : "cc-system-choice"}
            onClick={() => onPatch({ enabled: true })}
          >
            <strong>OIDC</strong>
            <span>Login über externen Identity Provider. Lokale Benutzer bleiben getrennt.</span>
          </button>
        </div>
      </div>

      <div className="cc-system-card">
        <h2>OIDC Zugangsdaten</h2>
        <p>Diese Werte werden in der Datenbank gespeichert. Das Client Secret wird nur neu gesetzt, wenn du hier einen Wert einträgst.</p>
        <div className="cc-system-form-grid">
          <Field
            label="Issuer URL"
            value={oidc.issuerUrl}
            placeholder="https://login.example.de/realms/bonni"
            onChange={(issuerUrl) => onPatch({ issuerUrl })}
          />
          <Field
            label="Client ID"
            value={oidc.clientId}
            placeholder="bonni_core"
            onChange={(clientId) => onPatch({ clientId })}
          />
          <Field
            label="Client Secret"
            type="password"
            value={oidc.clientSecret}
            placeholder={settings?.oidc?.clientSecretConfigured ? "Bereits in der DB gesetzt – leer lassen zum Behalten" : "Neues Client Secret"}
            onChange={(clientSecret) => onPatch({ clientSecret })}
            help="Das vorhandene Secret wird nicht im Browser angezeigt. Leer lassen behält den DB-Wert."
          />
          <Field
            label="Redirect URI"
            value={oidc.redirectUri}
            placeholder={`http://localhost:${runtime.platformPort || 4000}/api/oidc/callback`}
            onChange={(redirectUri) => onPatch({ redirectUri })}
          />
          <Field
            label="Post Logout Redirect URI"
            value={oidc.postLogoutRedirectUri}
            placeholder="http://localhost:5173"
            onChange={(postLogoutRedirectUri) => onPatch({ postLogoutRedirectUri })}
          />
        </div>
      </div>
    </div>
  );
}
