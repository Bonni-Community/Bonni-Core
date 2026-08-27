import { formatBonniCoreVersion } from "./localUpdatePresentation.js";

const FALLBACK_SOURCE = Object.freeze({
  provider: "github",
  repository: "Bonni-Community/bonni-core",
  repositoryUrl: "https://github.com/Bonni-Community/bonni-core",
  releasesUrl: "https://github.com/Bonni-Community/bonni-core/releases",
  latestManifestUrl: "https://github.com/Bonni-Community/bonni-core/releases/latest/download/manifest.json",
  destination: "UPDATE",
  signedCatalogConnected: false,
  batchInstallationSupported: false,
});

function packageStateLabel(state) {
  const normalized = String(state || "pending").trim().toLowerCase();
  if (["verified", "ready"].includes(normalized)) return "Geprüft";
  if (["downloading", "running"].includes(normalized)) return "Wird geladen";
  if (normalized === "installing") return "Wird installiert";
  if (["rolling-back", "rolled-back"].includes(normalized)) return "Rückkehr zur Vorversion";
  if (["installed", "completed"].includes(normalized)) return "Installiert";
  if (normalized === "failed") return "Fehler";
  return "Vorgemerkt";
}

export default function CoreReleaseOverview({ status }) {
  const source = { ...FALLBACK_SOURCE, ...(status?.releaseSource || {}) };
  const plan = status?.releasePlan && typeof status.releasePlan === "object"
    ? status.releasePlan
    : null;
  const packages = Array.isArray(plan?.packages) ? plan.packages : [];
  const currentVersion = formatBonniCoreVersion(plan?.currentVersion || status?.currentVersion);
  const targetVersion = formatBonniCoreVersion(plan?.targetVersion || status?.targetVersion);
  const availableVersion = targetVersion === "—" || targetVersion === currentVersion
    ? "Noch nicht gemeldet"
    : targetVersion;
  const connected = source.signedCatalogConnected === true;

  return (
    <section className="cc-update-page-card cc-core-release-source" aria-labelledby="cc-core-release-source-title">
      <div className="cc-update-page-section-title">
        <div>
          <span>Updatequelle</span>
          <h2 id="cc-core-release-source-title">GitHub-Pakete für Bonni Core</h2>
        </div>
        <b className={connected ? "is-connected" : "is-prepared"}>
          {connected ? "Signiertes Release verbunden" : "Quelle hinterlegt"}
        </b>
      </div>

      <p className="cc-core-release-source__summary">
        Bonni Core ruft veröffentlichte Aktualisierungspakete ausschließlich serverseitig aus dem festgelegten Repository ab.
      </p>

      <dl className="cc-core-release-source__facts">
        <div><dt>Installiert</dt><dd>{currentVersion}</dd></div>
        <div><dt>GitHub verfügbar</dt><dd>{availableVersion}</dd></div>
        <div><dt>Updatepakete</dt><dd>{packages.length || "—"}</dd></div>
        <div><dt>Ablage nach Prüfung</dt><dd>{source.destination || "UPDATE"}</dd></div>
      </dl>

      {packages.length ? (
        <ol className="cc-core-release-source__chain" aria-label="Erkannte Updatepakete">
          {packages.map((entry, index) => (
            <li key={entry.packageId || entry.releaseId || `${entry.fromVersion}-${entry.toVersion}-${index}`}>
              <span>{index + 1}</span>
              <div>
                <strong>{formatBonniCoreVersion(entry.fromVersion)} → {formatBonniCoreVersion(entry.toVersion)}</strong>
                <small>{packageStateLabel(entry.status)}</small>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="cc-core-release-source__notice" role="status">
          <strong>Die GitHub-Quelle ist eingetragen.</strong>
          <p>Ein Update erscheint hier, sobald das signierte Manifest veröffentlicht und der öffentliche Core-Schlüssel einmalig geprüft wurde.</p>
        </div>
      )}

      <a href={source.repositoryUrl} target="_blank" rel="noreferrer">
        {source.repository} auf GitHub öffnen
      </a>
    </section>
  );
}
