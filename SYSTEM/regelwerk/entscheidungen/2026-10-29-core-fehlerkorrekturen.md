# C075 – geprüfte Core-Fehlerkorrekturen

Datum: 29.10.2026. Auftraggeber: Mario Scheller. Technischer Bearbeiter: ChatGPT.
Auftrag: Die bestätigten Funde aus dem DEV74-Prüfbericht umsetzen und die
zusätzliche `fehler.txt` an den vollständigen Dateien prüfen.

## Entscheidung und Grund

Core bindet Benachrichtigungen an die verifizierte Request-Identität. Eine
Kontoauswahl darf nur das eigene Konto nennen. Konto- und Rollenbedingung gelten
gemeinsam; Listen und Einzeländerungen setzen dieselbe Grenze durch. Öffentlich
erreichbare Erstellung verlangt die genaue Berechtigung `SYSTEM_ADMIN`.

`NotificationRecipientState` ergänzt pro Nachricht/Konto den Gelesen-/Archivzustand.
Eine gemeinsame Nachricht wird damit nur für den jeweiligen Empfänger archiviert.
Die bisherigen Nachrichtentabellen, IDs und Zeitstempel bleiben erhalten. Bestehende
globale Legacy-Archivierungen werden nicht stillschweigend rückgängig gemacht.
Die neue Tabelle gehört ausschließlich Core. Der reguläre Schemaabgleich und die
additive Ops-Migration bereiten sie vor; Laufzeitrollen bekommen keine DDL-Rechte.

Der gemeinsame HTTP-Validator übergibt Zods geparste Bereiche an die Handler:
Standardwerte, Transformationen und Feldbegrenzungen werden wirksam. Die Query
wird wegen Express 5 als eigene Request-Eigenschaft bereitgestellt. Nicht im
Schema beschriebene Request-Bereiche bleiben erhalten. Exakte Passwörter und
2FA-Nachweise erhalten ihre bisherigen Regeln. Leere Terminal-Layouts werden
abgewiesen; die frei deklarierbaren Terminaltypen bleiben zulässig.

Öffentliche 404-Antworten spiegeln keine URL-/Query-Daten. Veraltete SYSTEM-
Quellpfadmetadaten werden auf das existierende Verzeichnis berichtigt.
Das vorgebaute Frontend wird atomar neu veröffentlicht und vor dem Paketieren
gegen seinen vollständigen Dateibaum geprüft. Release-Tests verwenden die aktuelle
Core-Bindung statt einer stehengebliebenen DEV73-Konstante.

## Alternativen und Grenzen

- Ein bloßes Ausblenden fremder Meldungen im Frontend schützt die API nicht.
- Gemeinsame Meldungen weiterhin global zu archivieren würde andere Empfänger
  beeinflussen. Zustände in Auditlogs oder flüchtigen Dateien hätten keine klare
  Daten-/Sicherungsgrenze. Daher erhält Core ein eigenes Empfängermodell.
- Kein Löschen bestehender Konten, Nachrichten oder Fachdaten; kein Datenbankreset.
- Keine Aufweichung der Versionssperren: Core DEV75, Capture DEV7, Stüberl DEV63
  und Gourmet DEV35 werden getrennt geliefert und exakt aneinander gebunden.
- Die zusätzliche TXT beruht bei den drei Syntaxmeldungen auf unvollständigen
  Ausschnitten. Die vorhandene Administratorprüfung wird nicht durch den darin
  vorgeschlagenen, schwächeren Code ersetzt.

Die Verantwortungsregeln A02/A05/A06 sowie C071/C072/C074 bleiben maßgeblich.
Capture-Wissensimport bleibt ausgeschlossen. Änderungen an Bonni Windows oder
an den Fachverträgen sind nicht Teil dieser Korrektur. Ein späterer Wechsel des
Nachrichten-Empfängermodells muss die bisherige Legacy-Fallbackregel ausdrücklich
berücksichtigen. Ausgeführte Prüfungen und offene Grenzen stehen in
`verification/core-dev75/results/checks.json` des Core-Pakets.
