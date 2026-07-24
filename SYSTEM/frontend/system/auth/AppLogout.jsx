export default function AppLayout({ sidebar, onLogout, children }) {
  return (
    <div style={{ display: "flex", gap: 16 }}>
      
      {/* Sidebar */}
      {sidebar}

      {/* Content */}
      <main
        style={{
          flex: 1,
          minHeight: "calc(100vh - 140px)",
          background: "#fffdfa",
          border: "1px solid #e3d9d2",
          borderRadius: 18,
          padding: 18,
          boxSizing: "border-box",
        }}
      >
        {children}
      </main>

      {/* Logout (optional global) */}
      <button
        onClick={onLogout}
        style={{
          position: "fixed",
          bottom: 20,
          right: 20,
          padding: "10px 14px",
          borderRadius: 10,
          border: "1px solid #d9d0ca",
          background: "#fffdfa",
          cursor: "pointer",
        }}
      >
        Logout
      </button>
    </div>
  );
}