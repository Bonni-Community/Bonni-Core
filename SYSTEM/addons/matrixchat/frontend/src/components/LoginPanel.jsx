import { useEffect, useState } from "react";

import MatrixMark from "./MatrixMark.jsx";

function bonniDisplayName(context) {
  return context?.user?.displayName
    || context?.user?.name
    || context?.shell?.identity?.displayName
    || context?.user?.loginName
    || "Bonni-Benutzer";
}

export default function LoginPanel({ config, context, busy, error, onLogin }) {
  const [homeserver, setHomeserver] = useState(config.defaultHomeserver || "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (config.defaultHomeserver) setHomeserver(config.defaultHomeserver);
  }, [config.defaultHomeserver]);

  async function submit(event) {
    event.preventDefault();
    const success = await onLogin({ homeserver, username, password, remember });
    if (success) setPassword("");
  }

  return (
    <main className="matrix-login">
      <section className="matrix-login__story" aria-label="MatrixChat Einführung">
        <div className="matrix-login__brand">
          <MatrixMark />
          <div>
            <span>Bonni Core</span>
            <strong>MatrixChat</strong>
          </div>
        </div>
        <div className="matrix-login__copy">
          <p className="eyebrow">Deine Gespräche. Dein Server.</p>
          <h1>Verbunden, ohne die Kontrolle abzugeben.</h1>
          <p>
            MatrixChat bringt deine Matrix-Räume direkt in Bonni Core – föderiert,
            verschlüsselt und unabhängig.
          </p>
        </div>
        <div className="matrix-login__privacy">
          <span className="matrix-login__privacy-dot" />
          Matrix-Zugangsdaten gehen direkt an deinen Homeserver.
        </div>
      </section>

      <section className="matrix-login__form-wrap">
        <form className="matrix-login__form" onSubmit={submit}>
          <div className="matrix-login__form-heading">
            <p className="eyebrow">Angemeldet in Bonni Core</p>
            <h2>Hallo {bonniDisplayName(context)}</h2>
            <p>Verbinde jetzt dein Matrix-Konto.</p>
          </div>

          <label>
            <span>Homeserver</span>
            <input
              type="url"
              inputMode="url"
              autoComplete="url"
              value={homeserver}
              onChange={(event) => setHomeserver(event.target.value)}
              placeholder="https://matrix.example.org"
              disabled={!config.allowHomeserverEdit || busy}
              required
            />
          </label>

          <label>
            <span>Matrix-Benutzername</span>
            <input
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="@name:example.org oder name"
              disabled={busy}
              required
            />
          </label>

          <label>
            <span>Matrix-Passwort</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••••••"
              disabled={busy}
              required
            />
          </label>

          <label className="matrix-login__remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              disabled={busy}
            />
            <span>Auf diesem Gerät angemeldet bleiben</span>
          </label>

          {error ? <div className="form-error" role="alert">{error}</div> : null}

          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {busy ? "Verbindung wird aufgebaut …" : "Mit Matrix verbinden"}
          </button>

          <p className="matrix-login__hint">
            Matrix-SSO ist in dieser Version noch nicht verfügbar. Bei einem
            SSO-only-Homeserver wird eine serverseitige Bonni-Brücke benötigt.
          </p>
        </form>
      </section>
    </main>
  );
}
