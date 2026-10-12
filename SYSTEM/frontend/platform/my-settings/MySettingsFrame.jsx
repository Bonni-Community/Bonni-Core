import { useEffect, useId, useMemo, useRef } from "react";

import BrandLogo from "../../system/brand/BrandLogo.jsx";
import "./MySettingsFrame.css";

function ProfileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.5 20c.45-4.05 2.7-6.2 6.5-6.2s6.05 2.15 6.5 6.2" />
    </svg>
  );
}

function BankIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m3.5 9 8.5-5 8.5 5" />
      <path d="M5 10.5h14M6.5 10.5V18m3.7-7.5V18m3.6-7.5V18m3.7-7.5V18M4 20h16" />
    </svg>
  );
}

function PrivacyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3.5h8l4 4V20H6z" />
      <path d="M14 3.5V8h4" />
      <rect x="9" y="13" width="6" height="5" rx="1.3" />
      <path d="M10.5 13v-1.1a1.5 1.5 0 0 1 3 0V13" />
    </svg>
  );
}

function SecurityIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5 19 6v5.1c0 4.35-2.45 7.65-7 9.4-4.55-1.75-7-5.05-7-9.4V6z" />
      <path d="m9.2 12 1.8 1.8 3.9-4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function FallbackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 2.5" />
    </svg>
  );
}

const SECTION_ICONS = Object.freeze({
  profile: ProfileIcon,
  profil: ProfileIcon,
  bank: BankIcon,
  bankverbindung: BankIcon,
  privacy: PrivacyIcon,
  datenschutz: PrivacyIcon,
  security: SecurityIcon,
  sicherheit: SecurityIcon,
});

export const DEFAULT_SETTINGS_SECTIONS = Object.freeze([
  {
    id: "profile",
    label: "Profil",
    subsections: [
      { id: "data", label: "Daten" },
      { id: "image", label: "Bild" },
      { id: "rights", label: "Rechte" },
      { id: "logs", label: "Protokolle" },
    ],
  },
  {
    id: "bank",
    label: "Bankverbindung",
    subsections: [
      { id: "bank-account", label: "Bankkonto" },
      { id: "paypal", label: "PayPal-Konto" },
    ],
  },
  {
    id: "privacy",
    label: "Datenschutz",
    subsections: [
      { id: "bonni-core", label: "Bonni Core" },
      { id: "stueberl-app", label: "StüberlApp" },
      { id: "kontor-app", label: "KontorApp" },
      { id: "meet-app", label: "MeetApp" },
      { id: "confirmation", label: "Bestätigung" },
    ],
  },
  {
    id: "security",
    label: "Sicherheit",
    subsections: [
      { id: "password", label: "Passwort" },
      { id: "two-factor", label: "2FA" },
      { id: "logs", label: "Protokolle" },
    ],
  },
]);

function displayName(user, shell) {
  return user?.displayName
    || user?.name
    || shell?.identity?.displayName
    || user?.loginName
    || shell?.identity?.loginName
    || "Benutzer";
}

function profileImageUrl(user, shell) {
  return user?.profileImageUrl
    || user?.avatarUrl
    || user?.photoUrl
    || shell?.identity?.profileImageUrl
    || shell?.identity?.avatarUrl
    || "";
}

function initials(value) {
  return String(value || "B")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function safeSections(value) {
  return Array.isArray(value) && value.length ? value : DEFAULT_SETTINGS_SECTIONS;
}

function safeAppLogoUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate || typeof window === "undefined") return "";
  try {
    const parsed = new URL(candidate, window.location.origin);
    return parsed.origin === window.location.origin ? parsed.href : "";
  } catch {
    return "";
  }
}

export default function MySettingsFrame({
  user,
  shell,
  activeSection,
  activeSubsection,
  sections,
  onSelectSection,
  onSelectSubsection,
  onClose,
  appLogoUrl,
  appLogoAlt = "",
  closeOnBackdrop = false,
  children,
}) {
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const rawId = useId();
  const instanceId = rawId.replace(/:/g, "");
  const sectionList = useMemo(() => safeSections(sections), [sections]);
  const currentSection = sectionList.find((section) => section.id === activeSection) || sectionList[0];
  const subsectionList = Array.isArray(currentSection?.subsections) ? currentSection.subsections : [];
  const currentSubsection = subsectionList.find((subsection) => subsection.id === activeSubsection)
    || subsectionList[0]
    || null;
  const userName = displayName(user, shell);
  const imageUrl = profileImageUrl(user, shell);
  const currentAppLogoUrl = safeAppLogoUrl(appLogoUrl);
  const titleId = `bonni-settings-title-${instanceId}`;
  const contentId = `bonni-settings-content-${instanceId}`;
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current?.();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hasAttribute("hidden") && element.getClientRects().length > 0);

      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  function handleBackdrop(event) {
    if (closeOnBackdrop && event.target === event.currentTarget) onClose?.();
  }

  function selectSection(section) {
    onSelectSection?.(section.id, section);
  }

  function selectSubsection(subsection) {
    onSelectSubsection?.(subsection.id, subsection, currentSection);
  }

  return (
    <div className="bonni-settings-frame" onMouseDown={handleBackdrop}>
      <section
        ref={dialogRef}
        className="bonni-settings-frame__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <aside className="bonni-settings-frame__identity" aria-label="Benutzerprofil">
          <div className="bonni-settings-frame__avatar">
            {imageUrl ? <img src={imageUrl} alt={`Profilbild von ${userName}`} /> : <span>{initials(userName)}</span>}
            <span className="bonni-settings-frame__brand-badge">
              {currentAppLogoUrl
                ? <img src={currentAppLogoUrl} alt={appLogoAlt ? `${appLogoAlt} Logo` : "App-Logo"} />
                : <BrandLogo decorative />}
            </span>
          </div>
          <strong>{userName}</strong>
          <small>Benutzerakte</small>
        </aside>

        <header className="bonni-settings-frame__header">
          <div className="bonni-settings-frame__title">
            <p>Benutzerakte</p>
            <h1 id={titleId}>{currentSection?.label || "Einstellungen"}</h1>
          </div>
          <button
            ref={closeButtonRef}
            className="bonni-settings-frame__close"
            type="button"
            aria-label="Benutzerakte schließen"
            onClick={onClose}
          >
            <CloseIcon />
          </button>

          {subsectionList.length ? (
            <nav className="bonni-settings-frame__subnav" aria-label={`${currentSection.label}: Bereiche`}>
              {subsectionList.map((subsection) => {
                const selected = subsection.id === currentSubsection?.id;
                return (
                  <button
                    key={subsection.id}
                    id={`bonni-settings-subtab-${instanceId}-${subsection.id}`}
                    type="button"
                    aria-current={selected ? "page" : undefined}
                    className={selected ? "is-active" : ""}
                    onClick={() => selectSubsection(subsection)}
                  >
                    {subsection.label}
                  </button>
                );
              })}
            </nav>
          ) : null}
        </header>

        <nav className="bonni-settings-frame__sidebar" aria-label="Bereiche der Benutzerakte">
          {sectionList.map((section) => {
            const selected = section.id === currentSection?.id;
            const Icon = section.icon || SECTION_ICONS[section.id] || FallbackIcon;
            return (
              <button
                key={section.id}
                type="button"
                aria-current={selected ? "page" : undefined}
                className={selected ? "is-active" : ""}
                title={section.label}
                onClick={() => selectSection(section)}
              >
                <span className="bonni-settings-frame__sidebar-icon"><Icon /></span>
                <span className="bonni-settings-frame__sidebar-label">{section.label}</span>
              </button>
            );
          })}
        </nav>

        <main
          id={contentId}
          className="bonni-settings-frame__content"
          aria-labelledby={titleId}
        >
          {children}
        </main>
      </section>
    </div>
  );
}
