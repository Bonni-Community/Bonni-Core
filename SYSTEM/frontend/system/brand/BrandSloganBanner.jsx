import BrandName from "./BrandName.jsx";
import { useBranding } from "./BrandContext.jsx";
import "./BrandSloganBanner.css";

function GithubIcon() {
  return <img src="/system/brand/github-octocat.png" alt="" aria-hidden="true" />;
}

function DocumentationIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 18h6M10 21h4" />
      <path d="M8.5 15.5c-1.3-1-2.1-2.6-2.1-4.4a5.6 5.6 0 1 1 11.2 0c0 1.8-.8 3.4-2.1 4.4-.6.5-.9 1.1-.9 1.7H9.4c0-.6-.3-1.2-.9-1.7Z" />
    </svg>
  );
}

function TermsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m8.5 12.5 2.2-2.2a1.9 1.9 0 0 1 2.7 0l4.1 4.1" />
      <path d="m3 10 3.5-3.5L10 10l-4.5 4.5Z" />
      <path d="m21 10-3.5-3.5L14 10l4.5 4.5Z" />
      <path d="m7.5 13.5 4.1 4.1a1.3 1.3 0 0 0 1.8 0l4.1-4.1M9.5 15.5l-1 1a1.3 1.3 0 0 1-1.8 0l-1.2-1.2" />
    </svg>
  );
}

function ViewModeIcon({ mode }) {
  if (mode === "mobile") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="7" y="2.5" width="10" height="19" rx="2.2" />
        <path d="M10.5 5h3M11.2 18.5h1.6" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M9 21h6M12 17v4" />
    </svg>
  );
}

export default function BrandSloganBanner({
  className = "",
  compact = false,
  githubUrl = "",
  documentationUrl = "",
  termsUrl = "",
  viewMode = "",
  onToggleViewMode,
}) {
  const { branding } = useBranding();
  const classes = ["bonni-brand-slogan", compact ? "bonni-brand-slogan--compact" : "", className].filter(Boolean).join(" ");
  const activeViewName = viewMode === "mobile" ? "Mobil" : "Desktop";
  const nextViewName = viewMode === "mobile" ? "Desktop" : "Mobil";

  return (
    <aside className={classes} aria-label={branding.displayName}>
      {compact ? null : <p>Organisationen sollen genau die Werkzeuge nutzen können, die sie benötigen – nicht mehr und nicht weniger.</p>}
      <div className="bonni-brand-slogan__meta">
        <p className="bonni-brand-slogan__copyright"><BrandName /> © 2025</p>
      </div>
      {documentationUrl || githubUrl || termsUrl || onToggleViewMode ? (
        <nav className="bonni-brand-slogan__links" aria-label="Bonni Core Links">
          {documentationUrl ? (
            <a
              className="bonni-brand-slogan__documentation"
              href={documentationUrl}
              aria-label="Bonni Core Dokumentation und Anleitungen öffnen"
              title="Dokumentation und Anleitungen"
            >
              <DocumentationIcon />
            </a>
          ) : null}
          {githubUrl ? (
            <a
              className="bonni-brand-slogan__github"
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Bonni Community auf GitHub öffnen"
              title="Bonni Community auf GitHub"
            >
              <GithubIcon />
            </a>
          ) : null}
          {termsUrl ? (
            <a
              className="bonni-brand-slogan__terms"
              href={termsUrl}
              aria-label="Nutzungsbedingungen öffnen"
              title="Nutzungsbedingungen"
            >
              <TermsIcon />
            </a>
          ) : null}
          {onToggleViewMode ? (
            <button
              className="bonni-brand-slogan__view-mode"
              type="button"
              data-active-view={viewMode}
              onClick={onToggleViewMode}
              aria-label={`${activeViewName} aktiv. Zu ${nextViewName} wechseln`}
              title={`Ansicht: ${activeViewName} – zu ${nextViewName} wechseln`}
            >
              <ViewModeIcon mode={viewMode} />
            </button>
          ) : null}
        </nav>
      ) : null}
    </aside>
  );
}
