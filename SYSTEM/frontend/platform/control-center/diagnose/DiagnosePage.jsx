export default function DiagnosePage() {
  return (
    <section className="cc-menu-layout-page cc-system-page">
      <div className="cc-user-page__header cc-menu-page-header">
        <div>
          <h1>Diagnose</h1>
          <p>Health, Logs, Events, Metrics und Diagnosewerkzeuge.</p>
        </div>
      </div>

      <div className="cc-menu-page-content">
        <div className="control-center-placeholder-list">
          <div>Health</div>
          <div>Logs</div>
          <div>Events</div>
          <div>Metrics</div>
        </div>
      </div>
    </section>
  );
}
