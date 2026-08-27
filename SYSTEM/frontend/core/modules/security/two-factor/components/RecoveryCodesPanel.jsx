import { useState } from "react";

export default function RecoveryCodesPanel({ codes, onDismiss, dismissLabel = "Sicher gespeichert und ausblenden" }) {
  const [copied, setCopied] = useState(false);
  if (!Array.isArray(codes) || !codes.length) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="bonni-2fa-recovery" aria-labelledby="bonni-recovery-title">
      <div>
        <p className="bonni-2fa-eyebrow">Nur jetzt sichtbar</p>
        <h3 id="bonni-recovery-title">Wiederherstellungscodes sicher ablegen</h3>
        <p>Jeder Code kann genau einmal verwendet werden. Bewahre sie getrennt vom Authenticator-Geraet auf.</p>
      </div>
      <ol>
        {codes.map((code, index) => <li key={`${index}:${code}`}><code>{code}</code></li>)}
      </ol>
      <div className="bonni-2fa-actions">
        <button type="button" onClick={copy}>{copied ? "Kopiert" : "Codes kopieren"}</button>
        <button type="button" className="is-primary" onClick={onDismiss}>{dismissLabel}</button>
      </div>
    </section>
  );
}
