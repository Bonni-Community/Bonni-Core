import UserPanel from "./UserPanel.jsx";
import "./MemberArea.css";

export default function MemberArea({
  user, shell, navigation, selected, onSelect, onOpenIndex, onOpenMySettings, onOpenMyDocuments, onLogout, children,
}) {
  const name = user?.displayName || shell?.identity?.displayName || user?.loginName;
  return (
    <div className="bonni-member-area">
      <aside className="bonni-member-area__sidebar">
        <strong>Mitglieder</strong>
        <nav aria-label="Mitgliederbereich">
          <button type="button" aria-current={selected ? undefined : "page"} onClick={() => onSelect(null)}>
            Mein Dashboard
          </button>
          {navigation.map((item) => (
            <button type="button" key={item.key} aria-current={selected?.key === item.key ? "page" : undefined}
              onClick={() => onSelect(item.key)}>
              {item.label}
            </button>
          ))}
        </nav>
        <footer className="bonni-member-area__account">
          <UserPanel user={user} shell={shell} onOpenIndex={onOpenIndex} onOpenMySettings={onOpenMySettings}
            onOpenMyDocuments={onOpenMyDocuments} onLogout={onLogout} />
        </footer>
      </aside>
      {selected ? (
        <main className="bonni-member-area__app" aria-label={selected.label}>{children}</main>
      ) : (
        <main className="bonni-member-area__dashboard">
          <h1>Mein Dashboard</h1>
          {name ? <p>{name}</p> : null}
          {navigation.length ? (
            <div className="bonni-member-area__shortcuts">
              {navigation.map((item) => (
                <button type="button" key={item.key} onClick={() => onSelect(item.key)}>
                  <strong>{item.label}</strong>
                  <span>{item.appLabel}</span>
                </button>
              ))}
            </div>
          ) : <p>Für deinen Mitgliederbereich sind noch keine App-Funktionen freigeschaltet.</p>}
        </main>
      )}
    </div>
  );
}
