export default function LoginView({
  loginName,
  password,
  twoFactorChallenge,
  twoFactorCode,
  twoFactorPassword,
  message,
  onLoginNameChange,
  onPasswordChange,
  onTwoFactorCodeChange,
  onTwoFactorPasswordChange,
  onCancelTwoFactor,
  onSubmit
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#f6f2ee"
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          width: 360,
          background: "#fffdfa",
          border: "1px solid #e3d9d2",
          borderRadius: 14,
          padding: 22,
          display: "flex",
          flexDirection: "column",
          gap: 12
        }}
      >
        <h2 style={{ margin: 0 }}>{twoFactorChallenge ? "Zwei-Faktor-Authentifizierung (2FA)" : "Login"}</h2>

        {twoFactorChallenge ? (
          <p style={{ margin: 0, color: "#5b514b", lineHeight: 1.45 }}>
            Schließe die Zwei-Faktor-Authentifizierung über {twoFactorChallenge.providerLabel || "Bonni"} ab. Die Eingaben werden nicht gespeichert.
          </p>
        ) : null}

        {!twoFactorChallenge ? <input
          value={loginName}
          onChange={(e) => onLoginNameChange(e.target.value)}
          placeholder="Benutzername"
          autoComplete="username"
          style={{ padding: 10, borderRadius: 10, border: "1px solid #d9d0ca" }}
        /> : null}

        {!twoFactorChallenge ? <input
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          placeholder="Passwort"
          type="password"
          autoComplete="current-password"
          style={{ padding: 10, borderRadius: 10, border: "1px solid #d9d0ca" }}
        /> : null}

        {twoFactorChallenge ? (twoFactorChallenge.proofFields || [{ name: "code", label: "Authenticator-Code", type: "password", autocomplete: "one-time-code" }]).map((field, index) => (
          <label key={field.name} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={{ color: "#5b514b", fontSize: 13 }}>{field.label}</span>
            <input
              value={field.name === "password" ? twoFactorPassword : twoFactorCode}
              onChange={(event) => field.name === "password"
                ? onTwoFactorPasswordChange(event.target.value)
                : onTwoFactorCodeChange(event.target.value)}
              placeholder={field.label}
              type={field.type || "password"}
              autoComplete={field.autocomplete || "off"}
              autoFocus={index === 0}
              required
              style={{ padding: 10, borderRadius: 10, border: "1px solid #d9d0ca" }}
            />
            {field.help ? <small style={{ color: "#746962" }}>{field.help}</small> : null}
          </label>
        )) : null}

        <button
          type="submit"
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #d9d0ca",
            background: "#EF7A00",
            color: "#fff",
            cursor: "pointer"
          }}
        >
          {twoFactorChallenge ? "2FA bestätigen" : "Einloggen"}
        </button>

        {twoFactorChallenge ? (
          <button
            type="button"
            onClick={onCancelTwoFactor}
            style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #d9d0ca", background: "transparent", cursor: "pointer" }}
          >
            Zurück
          </button>
        ) : null}

        {message ? <div style={{ color: "#b00020" }}>{message}</div> : null}
      </form>
    </div>
  );
}
