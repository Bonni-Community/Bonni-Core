# Security

Kanonischer Bonni-Core-Owner für 2FA/TOTP, native Kontowiederherstellung, Sicherheitsnachweise, Credential-Revisionen, Schutzfreigaben und sicherheitsrelevante Kryptografie. TOTP und die quorumgeschützte Passwortwiederherstellung sind Bestandteile von Core; externe Anbieter sind ausschließlich optionale, fail-closed Adapter.

Bei der Kontowiederherstellung sind aktive persönliche Admin-Konten kraft Core-Rolle prüfberechtigt. Die Policy-Liste `reviewerAccountIds` bezeichnet bis zu sechs **zusätzliche** ausdrücklich benannte Notfallberechtigte; sie ersetzt die Admin-Berechtigung nicht. Jeder Antrag friert die zu diesem Zeitpunkt tatsächlich 2FA-fähige Gesamtmenge und die Policy-Revision ein.

Diese unveröffentlichte Source-Testversion assembliert das neue Recovery-Schema über den vorhandenen isolierten `database:bootstrap`-/`prisma:push`-Pfad. Das ist ausschließlich für eine frische oder gesicherte Testdatenbank zulässig. Eine spätere Veröffentlichung gegen bestehende Produktivdaten bleibt gesperrt, bis die Recovery-Tabellen und Account-Spalten über eine versionierte, vom Update-Runner geprüfte Migration eingeführt werden; der Runtime-Start führt absichtlich kein `prisma db push` aus.
