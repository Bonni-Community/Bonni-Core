import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createArchiveFolder,
  createArchiveWorkspaceFolder,
  approveArchiveAccountLink,
  closeArchiveAccountLink,
  fetchArchiveAccountLinks,
  fetchArchiveDirectory,
  fetchArchiveFolderGrants,
  fetchArchiveWorkspace,
  fetchArchiveWorkspaceFolder,
  revokeArchiveFolderShare,
  requestArchiveAccountLink,
  shareArchiveFolder,
} from "../../../system/api/controlCenterExplorerApi.js";

const EMPTY_STATS = {
  total: 0,
  apps: 0,
  addons: 0,
  plugins: 0,
  sources: 0,
  directories: 0,
  files: 0,
  bytes: 0,
};

const EMPTY_WORKSPACE = { roots: [], shared: [], shareTargets: [] };

const STAT_DEFINITIONS = [
  { key: "total", icon: "▦", label: "Einträge gesamt", helper: "Gesamt", tone: "orange" },
  { key: "apps", icon: "◫", label: "Apps", helper: "im Archiv", tone: "green" },
  { key: "addons", icon: "◇", label: "Add-ons", helper: "im Archiv", tone: "purple" },
  { key: "plugins", icon: "⬡", label: "Plug-ins", helper: "im Archiv", tone: "blue" },
  { key: "sources", icon: "⌁", label: "Quellen", helper: "im Archiv", tone: "amber" },
];

function formatSize(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** unitIndex);
  return `${amount >= 10 || unitIndex === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

function entryIcon(type) {
  if (["directory", "ACCOUNT_ROOT", "PERSONAL", "DOCUMENTS", "CUSTOM", "APP"].includes(type)) return "📁";
  if (type === "link") return "🔗";
  if (type === "file") return "📄";
  return "◻";
}

function errorMessage(error) {
  return error?.data?.message || error?.message || "Das Archiv konnte nicht geladen werden.";
}

function permissionLabel(entry) {
  if (!entry?.shared) {
    if (entry?.readOnly) return "Lesen · geschützt";
    return "Eigentümer";
  }
  if (entry?.permissions?.write || entry?.permissions?.deposit) return "Datenaustausch";
  if (entry?.permissions?.copy) return "Lesen & kopieren";
  return "Lesen";
}

function folderKindLabel(kind) {
  if (kind === "PERSONAL") return "Persönlich";
  if (kind === "DOCUMENTS") return "Dokumente";
  if (kind === "APP") return "App-Ordner";
  return "Ordner";
}

export default function ExplorerPage({ token }) {
  const [view, setView] = useState("mine");
  const [systemListing, setSystemListing] = useState({
    path: "",
    parentPath: null,
    entries: [],
    stats: EMPTY_STATS,
  });
  const [workspace, setWorkspace] = useState(EMPTY_WORKSPACE);
  const [logicalListing, setLogicalListing] = useState(null);
  const [logicalTrail, setLogicalTrail] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [savingFolder, setSavingFolder] = useState(false);
  const [shareFolder, setShareFolder] = useState(null);
  const [shareGrants, setShareGrants] = useState([]);
  const [shareTargetId, setShareTargetId] = useState("");
  const [sharePreset, setSharePreset] = useState("read");
  const [shareExpiresAt, setShareExpiresAt] = useState("");
  const [sharing, setSharing] = useState(false);
  const [loadingShares, setLoadingShares] = useState(false);
  const [showAccountLinks, setShowAccountLinks] = useState(false);
  const [accountLinks, setAccountLinks] = useState({
    person: null,
    incoming: [],
    outgoing: [],
  });
  const [targetLoginName, setTargetLoginName] = useState("");
  const [savingAccountLink, setSavingAccountLink] = useState(false);

  const loadAccountLinks = useCallback(async ({ quiet = false } = {}) => {
    try {
      const result = await fetchArchiveAccountLinks(token);
      setAccountLinks({
        person: result?.person || null,
        incoming: Array.isArray(result?.incoming) ? result.incoming : [],
        outgoing: Array.isArray(result?.outgoing) ? result.outgoing : [],
      });
      return result;
    } catch (loadError) {
      if (!quiet) setError(errorMessage(loadError));
      return null;
    }
  }, [token]);

  const loadWorkspace = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const result = await fetchArchiveWorkspace(token);
      const next = {
        roots: Array.isArray(result?.roots) ? result.roots : [],
        shared: Array.isArray(result?.shared) ? result.shared : [],
        shareTargets: Array.isArray(result?.shareTargets) ? result.shareTargets : [],
      };
      setWorkspace(next);
      setShareTargetId((current) => current || next.shareTargets[0]?.accountId || "");
      return next;
    } catch (loadError) {
      setError(errorMessage(loadError));
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [token]);

  const loadSystemDirectory = useCallback(async (nextPath = "", { quiet = false } = {}) => {
    if (!quiet) {
      setLoading(true);
      setError("");
    }
    try {
      const result = await fetchArchiveDirectory(token, nextPath);
      setSystemListing({
        path: result?.path || "",
        parentPath: result?.parentPath ?? null,
        entries: Array.isArray(result?.entries) ? result.entries : [],
        stats: { ...EMPTY_STATS, ...(result?.stats || {}) },
      });
      setSelectedKeys(new Set());
      return result;
    } catch (loadError) {
      if (!quiet) setError(errorMessage(loadError));
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadWorkspace();
    loadSystemDirectory("", { quiet: true });
    loadAccountLinks({ quiet: true });
  }, [loadAccountLinks, loadSystemDirectory, loadWorkspace]);

  const loadLogicalFolder = useCallback(async (folder, nextTrail) => {
    if (!folder?.id) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const result = await fetchArchiveWorkspaceFolder(token, folder.id);
      setLogicalListing({
        folder: result?.folder || folder,
        parentId: result?.parentId || null,
        entries: Array.isArray(result?.entries) ? result.entries : [],
      });
      setLogicalTrail(nextTrail);
      setSelectedKeys(new Set());
      setCreatingFolder(false);
      setShareFolder(null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [token]);

  const changeView = (nextView) => {
    setView(nextView);
    setLogicalListing(null);
    setLogicalTrail([]);
    setSelectedKeys(new Set());
    setCreatingFolder(false);
    setShareFolder(null);
    setError("");
    setNotice("");
    if (nextView === "system") loadSystemDirectory(systemListing.path || "");
    else loadWorkspace();
  };

  const logicalEntries = logicalListing?.entries
    || (view === "shared" ? workspace.shared : workspace.roots);
  const entries = view === "system" ? systemListing.entries : logicalEntries;
  const keyFor = (entry) => (view === "system" ? entry.path : entry.id);

  const stats = useMemo(() => {
    const fallbackTotal = workspace.roots.length + workspace.shared.length;
    const values = {
      ...EMPTY_STATS,
      ...systemListing.stats,
      total: systemListing.stats.total || fallbackTotal,
    };
    return STAT_DEFINITIONS.map((definition) => ({
      ...definition,
      value: Number(values[definition.key] || 0),
    }));
  }, [systemListing.stats, workspace.roots.length, workspace.shared.length]);

  const systemBreadcrumbs = useMemo(() => {
    const segments = String(systemListing.path || "").split("/").filter(Boolean);
    return segments.map((label, index) => ({
      label,
      path: segments.slice(0, index + 1).join("/"),
    }));
  }, [systemListing.path]);

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedKeys.has(keyFor(entry))),
    [entries, selectedKeys, view],
  );
  const selectedDirectory = selectedEntries.length === 1 ? selectedEntries[0] : null;
  const logicalParent = logicalListing?.folder || null;
  const canCreateFolder = view === "system" || Boolean(logicalParent?.permissions?.write && !logicalParent?.readOnly);

  const toggleSelection = (entry) => {
    const key = keyFor(entry);
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedKeys((current) => (
      current.size === entries.length
        ? new Set()
        : new Set(entries.map(keyFor))
    ));
  };

  const openEntry = (entry) => {
    if (!entry) return;
    if (view === "system") {
      if (entry.navigable) loadSystemDirectory(entry.path);
      return;
    }
    loadLogicalFolder(entry, [...logicalTrail, { id: entry.id, name: entry.name }]);
  };

  const openLogicalTrail = (index) => {
    if (index < 0) {
      setLogicalListing(null);
      setLogicalTrail([]);
      setSelectedKeys(new Set());
      setShareFolder(null);
      return;
    }
    const target = logicalTrail[index];
    loadLogicalFolder(target, logicalTrail.slice(0, index + 1));
  };

  const refreshCurrent = async () => {
    if (view === "system") {
      await loadSystemDirectory(systemListing.path);
      return;
    }
    await loadWorkspace({ quiet: Boolean(logicalListing?.folder) });
    if (logicalListing?.folder) {
      await loadLogicalFolder(logicalListing.folder, logicalTrail);
    }
  };

  const cancelCreateFolder = () => {
    setCreatingFolder(false);
    setFolderName("");
    setError("");
  };

  const handleCreateFolder = async (event) => {
    event.preventDefault();
    if (!folderName.trim() || savingFolder || !canCreateFolder) return;
    setSavingFolder(true);
    setError("");
    setNotice("");

    try {
      if (view === "system") {
        const result = await createArchiveFolder(token, {
          path: systemListing.path,
          name: folderName.trim(),
        });
        setSystemListing({
          path: result?.path || systemListing.path,
          parentPath: result?.parentPath ?? systemListing.parentPath,
          entries: Array.isArray(result?.entries) ? result.entries : [],
          stats: { ...EMPTY_STATS, ...(result?.stats || {}) },
        });
      } else {
        await createArchiveWorkspaceFolder(token, {
          parentId: logicalParent.id,
          name: folderName.trim(),
        });
        await loadLogicalFolder(logicalParent, logicalTrail);
      }
      setNotice(`Ordner „${folderName.trim()}“ wurde erstellt.`);
      setCreatingFolder(false);
      setFolderName("");
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setSavingFolder(false);
    }
  };

  const openSharePanel = async (folder) => {
    setShareFolder(folder);
    setShareGrants([]);
    setSharePreset("read");
    setShareExpiresAt("");
    setShareTargetId(workspace.shareTargets[0]?.accountId || "");
    setLoadingShares(true);
    setError("");
    try {
      const result = await fetchArchiveFolderGrants(token, folder.id);
      setShareGrants(Array.isArray(result?.grants) ? result.grants : []);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoadingShares(false);
    }
  };

  const handleShare = async (event) => {
    event.preventDefault();
    if (!shareFolder || !shareTargetId || sharing) return;
    setSharing(true);
    setError("");
    setNotice("");
    try {
      await shareArchiveFolder(token, shareFolder.id, {
        granteeAccountId: shareTargetId,
        preset: sharePreset,
        expiresAt: shareExpiresAt || null,
      });
      const result = await fetchArchiveFolderGrants(token, shareFolder.id);
      setShareGrants(Array.isArray(result?.grants) ? result.grants : []);
      const target = workspace.shareTargets.find((item) => item.accountId === shareTargetId);
      setNotice(`„${shareFolder.name}“ wurde für ${target?.displayName || target?.loginName || "den Benutzer"} freigegeben.`);
    } catch (shareError) {
      setError(errorMessage(shareError));
    } finally {
      setSharing(false);
    }
  };

  const handleRevokeShare = async (grantId) => {
    if (!shareFolder) return;
    setError("");
    try {
      await revokeArchiveFolderShare(token, shareFolder.id, grantId);
      setShareGrants((current) => current.filter((grant) => grant.id !== grantId));
      setNotice("Die Freigabe wurde entzogen.");
    } catch (revokeError) {
      setError(errorMessage(revokeError));
    }
  };

  const handleRequestAccountLink = async (event) => {
    event.preventDefault();
    if (!targetLoginName.trim() || savingAccountLink) return;
    setSavingAccountLink(true);
    setError("");
    setNotice("");
    try {
      await requestArchiveAccountLink(token, targetLoginName.trim());
      setTargetLoginName("");
      await loadAccountLinks();
      setNotice("Die Anfrage wurde erstellt. Der zweite Account muss sich nun selbst anmelden und zustimmen.");
    } catch (linkError) {
      setError(errorMessage(linkError));
    } finally {
      setSavingAccountLink(false);
    }
  };

  const handleApproveAccountLink = async (requestId) => {
    if (savingAccountLink) return;
    setSavingAccountLink(true);
    setError("");
    setNotice("");
    try {
      await approveArchiveAccountLink(token, requestId);
      await Promise.all([loadAccountLinks(), loadWorkspace()]);
      setLogicalListing(null);
      setLogicalTrail([]);
      setNotice("Die Verknüpfung ist bestätigt. Dieser Login ist jetzt ein Sub-Account desselben Benutzers.");
    } catch (linkError) {
      setError(errorMessage(linkError));
    } finally {
      setSavingAccountLink(false);
    }
  };

  const handleCloseAccountLink = async (requestId) => {
    if (savingAccountLink) return;
    setSavingAccountLink(true);
    setError("");
    try {
      await closeArchiveAccountLink(token, requestId);
      await loadAccountLinks();
      setNotice("Die Verknüpfungsanfrage wurde geschlossen.");
    } catch (linkError) {
      setError(errorMessage(linkError));
    } finally {
      setSavingAccountLink(false);
    }
  };

  return (
    <section className="cc-user-page cc-explorer-page">
      <div className="cc-user-page__header cc-user-page__header--with-action">
        <div>
          <h1>Explorer</h1>
          <p>Persönliche Ordner, geschützte Dokumente und Freigaben im Archiv verwalten.</p>
        </div>
        <div className="cc-explorer-header-actions">
          <button type="button" onClick={() => setShowAccountLinks((current) => !current)}>
            Verknüpfte Accounts
            {accountLinks.incoming.length ? ` (${accountLinks.incoming.length})` : ""}
          </button>
          <button
            type="button"
            className="cc-user-primary-button"
            disabled={!canCreateFolder}
            title={canCreateFolder ? "Ordner erstellen" : "Öffne zuerst einen beschreibbaren persönlichen Ordner."}
            onClick={() => {
              setCreatingFolder(true);
              setError("");
              setNotice("");
            }}
          >
            + Neuer Ordner
          </button>
        </div>
      </div>

      <div className="cc-user-stats" aria-label="Explorer Status">
        {stats.map((stat) => (
          <article key={stat.key} className={`cc-user-stat cc-user-stat--${stat.tone}`}>
            <div className="cc-user-stat__icon" aria-hidden="true">{stat.icon}</div>
            <div>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
              <small>{stat.helper}</small>
            </div>
          </article>
        ))}
      </div>

      {showAccountLinks ? (
        <section className="cc-explorer-account-links" aria-label="Verknüpfte Accounts">
          <div className="cc-explorer-account-links__header">
            <div>
              <span>Ein Benutzer · mehrere Logins</span>
              <strong>{accountLinks.person?.displayName || "Verknüpfte Accounts"}</strong>
            </div>
            <button type="button" onClick={() => setShowAccountLinks(false)}>Schließen</button>
          </div>

          <div className="cc-explorer-account-links__accounts">
            {(accountLinks.person?.accounts || []).map((account) => (
              <div key={account.accountId}>
                <span>{account.loginName}</span>
                <small>{account.role === "PRIMARY" ? "Hauptaccount" : "Sub-Account"}</small>
              </div>
            ))}
          </div>

          {accountLinks.person?.canInvite ? (
            <form onSubmit={handleRequestAccountLink}>
              <label>
                <span>Zweiten Account per Loginname einladen</span>
                <input
                  value={targetLoginName}
                  onChange={(event) => setTargetLoginName(event.target.value)}
                  placeholder="z. B. max.zweiter.login"
                  autoComplete="off"
                />
              </label>
              <button type="submit" disabled={!targetLoginName.trim() || savingAccountLink}>Anfrage senden</button>
            </form>
          ) : (
            <p>Neue Sub-Accounts können nur vom Hauptaccount eingeladen werden.</p>
          )}

          {accountLinks.incoming.length ? (
            <div className="cc-explorer-account-links__requests">
              <strong>Meine Bestätigung erforderlich</strong>
              <p>Du bist mit diesem Account angemeldet. Erst deine ausdrückliche Zustimmung verbindet beide Logins.</p>
              {accountLinks.incoming.map((request) => (
                <article key={request.id}>
                  <span>
                    <b>{request.requester.displayName}</b> ({request.requester.loginName}) möchte diesen Account als Sub-Account verknüpfen.
                  </span>
                  <div>
                    <button type="button" className="is-confirm" onClick={() => handleApproveAccountLink(request.id)} disabled={savingAccountLink}>
                      Zustimmen & verknüpfen
                    </button>
                    <button type="button" onClick={() => handleCloseAccountLink(request.id)} disabled={savingAccountLink}>Ablehnen</button>
                  </div>
                </article>
              ))}
            </div>
          ) : null}

          {accountLinks.outgoing.length ? (
            <div className="cc-explorer-account-links__requests">
              <strong>Wartet auf den zweiten Account</strong>
              {accountLinks.outgoing.map((request) => (
                <article key={request.id}>
                  <span>{request.target.displayName} ({request.target.loginName}) · gültig bis {formatDate(request.expiresAt)}</span>
                  <button type="button" onClick={() => handleCloseAccountLink(request.id)} disabled={savingAccountLink}>Anfrage zurückziehen</button>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="cc-explorer-view-tabs" role="tablist" aria-label="Explorer Bereich">
        <button type="button" className={view === "mine" ? "is-active" : ""} onClick={() => changeView("mine")}>Meine Ordner</button>
        <button type="button" className={view === "shared" ? "is-active" : ""} onClick={() => changeView("shared")}>Mit mir geteilt</button>
        <button type="button" className={view === "system" ? "is-active" : ""} onClick={() => changeView("system")}>Systemarchiv</button>
      </div>

      <section className="cc-explorer-browser" aria-label="Archiv Explorer">
        <div className="cc-explorer-browser__topbar">
          <nav className="cc-explorer-breadcrumbs" aria-label="Archivpfad">
            {view === "system" ? (
              <>
                <button type="button" onClick={() => loadSystemDirectory("")} title="Archiv öffnen">⌂</button>
                <span aria-hidden="true">›</span>
                <button type="button" onClick={() => loadSystemDirectory("")}>Archiv</button>
                {systemBreadcrumbs.map((segment) => (
                  <span key={segment.path} className="cc-explorer-breadcrumbs__segment">
                    <span aria-hidden="true">›</span>
                    <button type="button" onClick={() => loadSystemDirectory(segment.path)}>{segment.label}</button>
                  </span>
                ))}
              </>
            ) : (
              <>
                <button type="button" onClick={() => openLogicalTrail(-1)} title="Start öffnen">⌂</button>
                <span aria-hidden="true">›</span>
                <button type="button" onClick={() => openLogicalTrail(-1)}>
                  {view === "shared" ? "Mit mir geteilt" : "Meine Ordner"}
                </button>
                {logicalTrail.map((segment, index) => (
                  <span key={segment.id} className="cc-explorer-breadcrumbs__segment">
                    <span aria-hidden="true">›</span>
                    <button type="button" onClick={() => openLogicalTrail(index)}>{segment.name}</button>
                  </span>
                ))}
              </>
            )}
          </nav>

          <button type="button" className="cc-explorer-refresh" onClick={refreshCurrent} disabled={loading}>
            {loading ? "Lädt..." : "↻ Aktualisieren"}
          </button>
        </div>

        {creatingFolder ? (
          <form className="cc-explorer-create-folder" onSubmit={handleCreateFolder}>
            <label>
              <span>Neuer Ordner im aktuellen Verzeichnis</span>
              <input
                autoFocus
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
                placeholder="Ordnername"
                maxLength="128"
              />
            </label>
            <button type="submit" className="cc-explorer-action--primary" disabled={!folderName.trim() || savingFolder}>
              {savingFolder ? "Erstelle..." : "Erstellen"}
            </button>
            <button type="button" onClick={cancelCreateFolder} disabled={savingFolder}>Abbrechen</button>
          </form>
        ) : null}

        {error ? <div className="cc-explorer-message cc-explorer-message--error" role="alert">{error}</div> : null}
        {notice ? <div className="cc-explorer-message cc-explorer-message--success" role="status">{notice}</div> : null}

        {shareFolder ? (
          <section className="cc-explorer-share-panel" aria-label="Ordnerfreigabe">
            <div className="cc-explorer-share-panel__header">
              <div>
                <span>Ordner freigeben</span>
                <strong>{shareFolder.name}</strong>
              </div>
              <button type="button" onClick={() => setShareFolder(null)} aria-label="Freigabe schließen">×</button>
            </div>
            <form onSubmit={handleShare}>
              <label>
                <span>Benutzer</span>
                <select value={shareTargetId} onChange={(event) => setShareTargetId(event.target.value)} required>
                  {workspace.shareTargets.length === 0 ? <option value="">Kein weiterer Benutzer</option> : null}
                  {workspace.shareTargets.map((target) => (
                    <option key={target.accountId} value={target.accountId}>
                      {target.displayName} ({target.loginName})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Freigabe</span>
                <select value={sharePreset} onChange={(event) => setSharePreset(event.target.value)}>
                  <option value="read">Lesen und kopieren</option>
                  <option value="exchange">Datenaustausch (lesen und ablegen)</option>
                </select>
              </label>
              <label>
                <span>Ablauf (optional)</span>
                <input type="date" value={shareExpiresAt} onChange={(event) => setShareExpiresAt(event.target.value)} />
              </label>
              <button type="submit" className="cc-explorer-action--primary" disabled={!shareTargetId || sharing}>
                {sharing ? "Speichert..." : "Freigeben"}
              </button>
            </form>
            <div className="cc-explorer-share-list">
              <strong>Aktive Freigaben</strong>
              {loadingShares ? <span>Lädt...</span> : null}
              {!loadingShares && shareGrants.length === 0 ? <span>Noch keine Freigabe.</span> : null}
              {shareGrants.map((grant) => (
                <div key={grant.id}>
                  <span>
                    <b>{grant.grantee?.displayName || grant.grantee?.loginName}</b>
                    {grant.permissions?.write ? " · Datenaustausch" : " · Lesen und kopieren"}
                    {grant.expiresAt ? ` · bis ${formatDate(grant.expiresAt)}` : ""}
                  </span>
                  <button type="button" onClick={() => handleRevokeShare(grant.id)}>Entziehen</button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <div className="cc-explorer-table-wrap">
          <table className="cc-explorer-table">
            <thead>
              <tr>
                <th className="cc-explorer-table__check">
                  <input
                    type="checkbox"
                    aria-label="Alle Einträge auswählen"
                    checked={entries.length > 0 && selectedKeys.size === entries.length}
                    onChange={toggleAll}
                  />
                </th>
                <th>Typ</th>
                <th>Name</th>
                <th>Eigentümer</th>
                <th>Berechtigung</th>
                <th>Geändert</th>
                <th>Größe</th>
                <th>Aktion</th>
              </tr>
            </thead>
            <tbody>
              {view === "system" && systemListing.parentPath !== null ? (
                <tr className="cc-explorer-table__parent" onDoubleClick={() => loadSystemDirectory(systemListing.parentPath || "")}>
                  <td />
                  <td aria-hidden="true">↩</td>
                  <td><button type="button" onClick={() => loadSystemDirectory(systemListing.parentPath || "")}>Übergeordnetes Verzeichnis</button></td>
                  <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
                </tr>
              ) : null}
              {view !== "system" && logicalTrail.length > 0 ? (
                <tr className="cc-explorer-table__parent" onDoubleClick={() => openLogicalTrail(logicalTrail.length - 2)}>
                  <td />
                  <td aria-hidden="true">↩</td>
                  <td><button type="button" onClick={() => openLogicalTrail(logicalTrail.length - 2)}>Übergeordnetes Verzeichnis</button></td>
                  <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
                </tr>
              ) : null}

              {entries.map((entry) => {
                const key = keyFor(entry);
                const logical = view !== "system";
                return (
                  <tr key={key} className={selectedKeys.has(key) ? "cc-explorer-table__selected" : ""} onDoubleClick={() => openEntry(entry)}>
                    <td className="cc-explorer-table__check">
                      <input type="checkbox" aria-label={`${entry.name} auswählen`} checked={selectedKeys.has(key)} onChange={() => toggleSelection(entry)} />
                    </td>
                    <td className="cc-explorer-table__type" title={logical ? entry.kind : entry.type}>{entryIcon(logical ? entry.kind : entry.type)}</td>
                    <td>
                      {(logical || entry.navigable) ? (
                        <button type="button" className="cc-explorer-table__name" onClick={() => openEntry(entry)}>{entry.name}</button>
                      ) : <span className="cc-explorer-table__file-name">{entry.name}</span>}
                      {logical ? <small className="cc-explorer-table__kind">{folderKindLabel(entry.kind)}</small> : null}
                    </td>
                    <td>{logical ? (entry.shared ? entry.owner?.displayName : "Ich") : (entry.owner || "System")}</td>
                    <td>{logical ? permissionLabel(entry) : <code>{entry.permissions || "—"}</code>}</td>
                    <td>{formatDate(logical ? entry.updatedAt : entry.modifiedAt)}</td>
                    <td>{logical || entry.type === "directory" ? "<ORDNER>" : formatSize(entry.size)}</td>
                    <td>
                      {logical && entry.permissions?.share ? (
                        <button type="button" className="cc-explorer-table__share" onClick={() => openSharePanel(entry)}>Freigeben</button>
                      ) : "—"}
                    </td>
                  </tr>
                );
              })}

              {!loading && entries.length === 0 ? (
                <tr><td colSpan="8" className="cc-explorer-table__empty">Dieser Bereich ist leer.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="cc-explorer-summary">
          <span>{entries.length} Objekte</span>
          {view === "system" ? (
            <>
              <span>{systemListing.stats.directories} Verzeichnisse</span>
              <span>{systemListing.stats.files} Dateien</span>
              <span>{formatSize(systemListing.stats.bytes)} Gesamt</span>
            </>
          ) : (
            <>
              <span>{workspace.shared.length} Freigaben für mich</span>
              <span>Dokumente sind schreibgeschützt</span>
            </>
          )}
        </div>

        <div className="cc-explorer-actions" aria-label="Explorer Aktionen">
          <button type="button" onClick={() => openEntry(selectedDirectory)} disabled={!selectedDirectory}>Öffnen</button>
          <button type="button" onClick={refreshCurrent} disabled={loading}>Aktualisieren</button>
          <button type="button" onClick={() => setSelectedKeys(new Set())} disabled={selectedKeys.size === 0}>Auswahl aufheben</button>
          <button type="button" className="cc-explorer-action--primary" onClick={() => setCreatingFolder(true)} disabled={!canCreateFolder}>Neuer Ordner</button>
        </div>
      </section>
    </section>
  );
}
