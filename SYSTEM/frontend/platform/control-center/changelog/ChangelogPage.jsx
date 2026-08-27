import { useEffect, useState } from "react";

import { fetchCoreUpdateStatus } from "../../../system/api/coreUpdateApi.js";
import { BONNI_CORE_VERSION } from "../../../system/version.js";
import { formatBonniCoreVersion } from "../update/localUpdatePresentation.js";

const CURRENT_HIGHLIGHTS = [
  "Systemüberwachung mit echtem Systemstatus, Ressourcen und aktuellen Störungen.",
  "Gemeinsame Versionsnummer für Bonni-Core-Frontend und -Backend.",
  "Updatefenster mit Download-, Prüf-, Backup-, Candidate- und Rollback-Checkliste.",
  "Prüfbare Backups von PostgreSQL, Einstellungen und persistenten Dateien.",
  "Store-Kompatibilität wird verbindlich aus den Paketmanifesten ausgewertet.",
];

export default function ChangelogPage({ token, onBack }) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!token) return;
    fetchCoreUpdateStatus(token).then(setStatus).catch(() => setStatus(null));
  }, [token]);

  const manifest = status?.manifest;
  const releaseNotes = manifest?.releaseNotes;
  const version = manifest?.version || status?.currentVersion || BONNI_CORE_VERSION;
  const versionLabel = formatBonniCoreVersion(version);
  const highlights = releaseNotes?.highlights?.length ? releaseNotes.highlights : CURRENT_HIGHLIGHTS;
  const description = releaseNotes?.descriptions?.de
    || releaseNotes?.descriptions?.en
    || "Diese Version fasst Systemüberwachung, Updatevorbereitung, Sicherungen und Store-Prüfungen in den vorgesehenen Bonni-Core-Bereichen zusammen.";

  return (
    <section className="cc-changelog-page" aria-label="Versionsbeschreibung">
      <div className="cc-changelog-card">
        <div className="cc-changelog-card__header">
          <div>
            <p className="cc-changelog-card__breadcrumb">Bonni Core › Versionsbeschreibung › {versionLabel}</p>
            <h1>Bonni Core {versionLabel}</h1>
          </div>
          <button type="button" onClick={onBack} aria-label="Versionsbeschreibung schließen">×</button>
        </div>

        <div className="cc-changelog-content">
          <section className="cc-changelog-section">
            <h2>{releaseNotes?.title || "Versionsbeschreibung"}</h2>
            <p>{description}</p>
          </section>

          <section className="cc-changelog-section">
            <h2>Änderungen</h2>
            <ul>{highlights.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>

          <section className="cc-changelog-section">
            <h2>Technische Hinweise</h2>
            <ul>
              <li>Frontend und Backend werden als ein gemeinsames Bonni-Core-Paket aktualisiert.</li>
              <li>Ein kontrollierter, automatisch überwachter Neustart ist erforderlich.</li>
              <li>{manifest?.migration?.required ? `Datenbankänderung: ${manifest.migration.strategy}.` : "Dieses Update benötigt keine Datenbankänderung."}</li>
              {manifest?.issuedAt ? <li>Veröffentlicht am {new Date(manifest.issuedAt).toLocaleDateString("de-DE")}.</li> : null}
            </ul>
          </section>
        </div>
      </div>
    </section>
  );
}
