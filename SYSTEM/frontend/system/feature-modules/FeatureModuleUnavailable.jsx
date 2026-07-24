import { featureModuleDisplayName } from "./featureModuleApi.js";

export default function FeatureModuleUnavailable({
  module,
  moduleId,
  reason = "not-installed",
  error,
  onBack,
  onOpenControlCenter,
}) {
  const title = module ? featureModuleDisplayName(module) : moduleId || "Fachmodul";

  const messages = {
    "not-found": "Dieses Fachmodul ist im System nicht registriert.",
    "not-installed": "Dieses Fachmodul ist nicht installiert oder nicht aktiviert.",
    "missing-entry": "Das Manifest enthält keinen ladbaren Frontend-Einstieg.",
    "load-failed": "Das Fachmodul konnte nicht geladen werden.",
  };

  return (
    <main style={{ minHeight: "100vh", padding: 24, background: "#111827", color: "#f9fafb" }}>
      <section
        style={{
          maxWidth: 760,
          margin: "64px auto",
          padding: 28,
          borderRadius: 24,
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.14)",
          boxShadow: "0 24px 70px rgba(0,0,0,0.35)",
        }}
      >
        <p style={{ margin: 0, opacity: 0.72, letterSpacing: 1.4, textTransform: "uppercase" }}>
          Fachmodul
        </p>
        <h1 style={{ marginTop: 8, marginBottom: 12 }}>{title}</h1>
        <p style={{ fontSize: 17, lineHeight: 1.6, opacity: 0.86 }}>
          {messages[reason] || messages["not-installed"]}
        </p>
        {error ? (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              marginTop: 16,
              padding: 14,
              borderRadius: 12,
              background: "rgba(0,0,0,0.28)",
              color: "#fecaca",
              fontSize: 13,
            }}
          >
            {error instanceof Error ? error.message : String(error)}
          </pre>
        ) : null}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 24 }}>
          {onBack ? (
            <button type="button" onClick={onBack} style={buttonStyle}>
              Zurück
            </button>
          ) : null}
          {onOpenControlCenter ? (
            <button type="button" onClick={onOpenControlCenter} style={buttonStyle}>
              Control Center öffnen
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}

const buttonStyle = {
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 999,
  background: "rgba(255,255,255,0.1)",
  color: "inherit",
  padding: "10px 16px",
  cursor: "pointer",
};
