# Security

Kanonischer Bonni-Core-Owner für die verpflichtende 2FA-Engine und TOTP, native Kontowiederherstellung, Sicherheitsnachweise, Credential-Revisionen, Schutzfreigaben und sicherheitsrelevante Kryptografie. Enrollment, Login-Challenges, Recovery-Codes, Lockout und Fail-Closed-Regeln bleiben immer in Core. Externe Anbieter wie privacyIDEA sind ausschließlich optionale Provider-Adapter und dürfen keine Core-Datenbank oder Core-2FA ersetzen.

Bei der Kontowiederherstellung sind aktive persönliche Admin-Konten kraft Core-Rolle prüfberechtigt. Die Policy-Liste `reviewerAccountIds` bezeichnet bis zu sechs **zusätzliche** ausdrücklich benannte Notfallberechtigte; sie ersetzt die Admin-Berechtigung nicht. Jeder Antrag friert die zu diesem Zeitpunkt tatsächlich 2FA-fähige Gesamtmenge und die Policy-Revision ein.

Frische Testdatenbanken erhalten das Schema weiterhin über den isolierten `database:bootstrap`-/`prisma:push`-Pfad. Bestehende Datenbanken werden ab 0.1.20c dagegen ausschließlich durch die versionierte, expand-only Ops-Migration `20260829-security-recovery-two-factor.sql` erweitert. Der Update-Supervisor prüft ihren unveränderlichen Hash, führt sie zuerst auf der Candidate-Kopie aus und akzeptiert den Stand nur nach vollständiger Vertrags- und Gesundheitsprüfung. Der Runtime-Start führt absichtlich kein `prisma db push` aus.
