# Identity

Kanonischer Bonni-Core-Owner für Konten, Identitäten, Anmeldung, Sitzungen, Recovery-Lock-Signale und lokale Passwortverträge. Fach-Apps konsumieren Identity-Ports und besitzen keine eigenen Zugangsdaten. `PASSWORD_RECOVERY_LOCKED` ist ein settlement-only Zustand und niemals mit `isActive=false` oder einem 2FA-Reset gleichzusetzen.

Der kanonische Members-Port veröffentlicht den Zustand sowohl je persönlichem `accessAccount.securityState` als auch aggregiert unter `passwordRecovery`. Fachmodule müssen bei `PASSWORD_RECOVERY_LOCKED` alle nicht zur Wiederherstellung gehörenden personen-/kontobezogenen Mutationen fail-closed ablehnen. Technische Konten werden nicht in dieses Signal eingerechnet. Für nicht im Source-Baum enthaltene POS-/Kassen-/Stüberl-Systeme ist dies eine verbindliche Integrationsregel, keine Behauptung einer bereits vorhandenen Durchsetzung.
