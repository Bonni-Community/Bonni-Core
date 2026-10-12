# Security

Kanonischer Bonni-Core-Owner für 2FA/TOTP, native Kontowiederherstellung, Sicherheitsnachweise, Credential-Revisionen, Schutzfreigaben und sicherheitsrelevante Kryptografie. TOTP und die quorumgeschützte Passwortwiederherstellung sind Bestandteile von Core; externe Anbieter sind ausschließlich optionale, fail-closed Adapter.

Bei der Kontowiederherstellung sind aktive persönliche Admin-Konten kraft Core-Rolle prüfberechtigt. Die Policy-Liste `reviewerAccountIds` bezeichnet bis zu sechs **zusätzliche** ausdrücklich benannte Notfallberechtigte; sie ersetzt die Admin-Berechtigung nicht. Jeder Antrag friert die zu diesem Zeitpunkt tatsächlich 2FA-fähige Gesamtmenge und die Policy-Revision ein.

Frische Testdatenbanken erhalten das Schema weiterhin über den isolierten `database:bootstrap`-/`prisma:push`-Pfad. Bestehende Datenbanken werden ab 0.1.20c dagegen ausschließlich durch die versionierte, expand-only Ops-Migration `20260829-security-recovery-two-factor.sql` erweitert. Der Update-Supervisor prüft ihren unveränderlichen Hash, führt sie zuerst auf der Candidate-Kopie aus und akzeptiert den Stand nur nach vollständiger Vertrags- und Gesundheitsprüfung. Der Runtime-Start führt absichtlich kein `prisma db push` aus.
