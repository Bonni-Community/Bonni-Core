# Bonni Core Diagnostics

Diagnostics sammelt die Diagnose- und Bewertungsfunktionen von Bonni Core.

- `checks/`: technische Einzelchecks
- `health/`: Health-Auswertung und Status
- `crash/`: Crash-/Fehlerdaten
- `reports/`: Diagnoseberichte

Der einfache Live-/Ready-Endpunkt bleibt bewusst unter `backend/src/system/routes/health.routes.ts`, weil er direkt zum Serverstart gehoert.
