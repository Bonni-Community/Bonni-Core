# privacyIDEA-Provider für Bonni Core

Dieses separat installierbare Bonni-Plugin bindet einen privacyIDEA-Server als
zusätzlichen Zwei-Faktor-Provider an. Die verpflichtende 2FA-Funktion —
Enrollment, Login-Challenge, Recovery, Sperrlogik, Audit und
modulgebundene Freigaben — bleibt vollständig unabhängig in Bonni Core.
KontorApp erhält weder privacyIDEA-Konfiguration noch Kennwörter.

Standardmäßig ist das Plugin nach der Installation deaktiviert. Nach dem Eintragen der HTTPS-Serveradresse kann es im Control Center unter **Provider → Zwei-Faktor-Authentifizierung (2FA)** aktiviert werden. Eine Challenge gilt standardmäßig 60 Sekunden und erlaubt 8 Versuche. Gültigkeit und Versuchszahl sind einstellbar.

privacyIDEA ist nur einer von mehreren möglichen Anbietern. Bonni Core kann mehrere Anbieter-Plugins aufnehmen; in der Systemkonfiguration wird genau ein Verfahren aktiviert. Alternativ funktioniert das eingebaute TOTP-Verfahren mit üblichen Authenticator-Apps.

Die Reihenfolge kann auf **Token + Passwort** oder **Passwort + Token** gestellt werden. Als Passwortquelle ist entweder das erneut eingegebene Bonni-Passwort oder ein separates privacyIDEA-Passwort möglich. Kennwörter werden nicht gespeichert.

## Einrichtung im Store

Ab Version 0.2.1 enthält das Detailfenster des Plugins vier getrennte Reiter:

- **Beschreibung** zeigt Version, Kompatibilität, Abhängigkeiten und Lifecycle.
- **Einrichtung** verwaltet Anbieter, Serveradresse, Challenge-Gültigkeit, Fehlversuche sowie Token-/Passwortreihenfolge. Für das lokale TOTP-Verfahren kann der angemeldete Benutzer hier einen persönlichen QR-Code erzeugen und mit einer üblichen Authenticator-App bestätigen.
- **Installationshilfe** erklärt die Einrichtung mit fünf datenschutzneutralen Abbildungen. Die Anleitung kann über eine kleine Auswahl automatisch, auf Deutsch oder auf Englisch angezeigt werden.
- **Feedback & Vorschläge** speichert Eingaben zunächst nur lokal im Browser. Bei bestehender Internetverbindung kann daraus eine vorausgefüllte GitHub-Meldung geöffnet werden. Zugangsdaten, Token und Wiederherstellungscodes gehören niemals in einen Verbesserungsvorschlag.

Der QR-Code für einen privacyIDEA-Token wird ausschließlich bei der Tokenausgabe durch privacyIDEA erzeugt. Bonni erzeugt dafür bewusst keinen Ersatzschlüssel. QR-Code und manueller TOTP-Schlüssel des lokalen Verfahrens werden nur während der persönlichen Einrichtung angezeigt.

## Datenbankzugriff

Der Provider besitzt absichtlich kein eigenes Prisma-Modell und erhält keinen
direkten Datenbankzugriff. Das Manifest verwendet `metadata.database.mode:
"none"`. Die Konfiguration wird ausschließlich über den geschützten
Core-Port `moduleSettings` im Namespace `plugin.privacyidea` verwaltet.

Damit bleibt privacyIDEA optional: Ohne dieses Plugin arbeitet Bonni Core mit
dem eingebauten lokalen TOTP-Verfahren. Wird privacyIDEA aktiviert, bleibt die
Prüfung bei Nichterreichbarkeit oder fehlerhafter Konfiguration fail-closed.
