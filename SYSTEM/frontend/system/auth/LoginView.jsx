export default function LoginView({
  email,
  password,
  message,
  onEmailChange,
  onPasswordChange,
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
        <h2 style={{ margin: 0 }}>Login</h2>

        <input
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          placeholder="E-Mail"
          style={{ padding: 10, borderRadius: 10, border: "1px solid #d9d0ca" }}
        />

        <input
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          placeholder="Passwort"
          type="password"
          style={{ padding: 10, borderRadius: 10, border: "1px solid #d9d0ca" }}
        />

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
          Einloggen
        </button>

        {message ? <div style={{ color: "#b00020" }}>{message}</div> : null}
      </form>
    </div>
  );
}
