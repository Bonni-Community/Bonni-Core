# Access Jobs

Crontab Beispiel:

0 0 * * * cd /app/backend && npm run jobs:run -- access:oidc-sync

Der OIDC Sync läuft geplant.
Nicht sofort beim Login.

Wichtig:
- OIDC Offline = keine Änderungen
- nur source=OIDC wird aktualisiert
- LOCAL und SANDBOX bleiben unverändert
