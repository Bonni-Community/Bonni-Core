# Two-factor authentication

Kanonische, immer vorhandene Core-Security-Implementation für accountgebundene 2FA/TOTP-Einrichtung, Admin-Freigabeauftrag, QR-Ausgabe nur an den Zielaccount, Recovery-Codes, Challenges und Lockout. Der Provider-Vertrag ist Teil von Core; lokale TOTP-Nutzung ist unabhängig von optionalen Adaptern wie privacyIDEA.

`platform/security/two-factor` ist nur eine befristete Import-Kompatibilität und enthält keine Fachlogik.
