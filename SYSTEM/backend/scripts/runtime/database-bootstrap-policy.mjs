export function resolveDatabaseBootstrapAction({
  accountTableExists,
  accountCount,
  adminExists,
  repairRequested = false,
}) {
  if (!accountTableExists) {
    throw new Error(
      "Datenbank-Bootstrap abgebrochen: Die Account-Tabelle fehlt nach der Schema-Prüfung.",
    );
  }

  if (repairRequested) {
    return "seed";
  }

  if (adminExists) {
    return "skip";
  }

  if (accountCount === 0) {
    return "seed";
  }

  throw new Error(
    "Datenbank-Bootstrap abgebrochen: Es bestehen Benutzerkonten, aber kein `admin`. "
    + "Eine automatische Neuerstellung wäre unsicher. Bitte bewusst "
    + "`BONNI_BOOTSTRAP_ADMIN_PASSWORD` setzen oder `npm run admin:repair` ausführen.",
  );
}
