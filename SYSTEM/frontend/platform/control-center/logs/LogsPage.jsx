export default function LogsPage() {
  return (
    <section className="cc-menu-layout-page cc-system-page">
      <div className="cc-user-page__header cc-menu-page-header">
        <div>
          <h1>Logs</h1>
          <p>Protokolle und Ereignisse anzeigen.</p>
        </div>
      </div>

      <div className="cc-menu-page-content">
        <div className="control-center-placeholder-list">
          <div>SystemLog</div>
          <div>SecurityLog</div>
          <div>ApiLog</div>
          <div>JobLog</div>
        </div>
      </div>
    </section>
  );
}
