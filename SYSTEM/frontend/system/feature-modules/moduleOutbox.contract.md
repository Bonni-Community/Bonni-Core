# Lokale Bestellablage – Modulvertrag v1

Core meldet `payload.localOutbox.version = 1` im verifizierten Modulkontext.
Die Ergänzung gilt für `app.stueberlapp` und erteilt keinen API- oder Finanzzugriff.

Anfragen verwenden `bonni:module-outbox-request` mit der bestehenden
`moduleId`, `rpcSessionId`, `requestId` sowie `accountId` des Modulkontexts.
Core prüft das absendende opaque Fenster und die Sitzung vor der Verarbeitung.
Das Konto wird zusätzlich mit dem aktuell angemeldeten Core-Konto verglichen.
Antworten verwenden den bestehenden `bonni:module-rpc-response`-Umschlag.

Operationen: `list`, `enqueue`, `sent`, `failed`, `retry`, `remove`.
`enqueue` benötigt `id` und `payload`; dessen `idempotencyKey` muss `id`
entsprechen. Nutzlast maximal 32.768 Zeichen; maximal 1.000 offene Einträge
pro Konto/Modul. `orderOperation` unterscheidet `BAR_ORDER_CREATE` (Standard)
und `MEMBER_ORDER_CREATE`. Auflisten und Statusänderungen sind an diese
Bestellart gebunden, damit Mitgliederbestellungen ausschließlich über den
Mitglieder-Endpunkt erneut gesendet werden. Gleiche ID mit abweichender
Nutzlast oder Bestellart wird abgelehnt.

Jede Operation läuft in einer IndexedDB-Transaktion mit strikter
Dauerhaftigkeit. Eine Antwort folgt erst nach Commit. Verschiedene Fenster
überschreiben keine gemeinsame JSON-Liste. Späte Fehlermeldungen dürfen einen
bereits entfernten, bestätigten Eintrag nicht wieder anlegen.

Die übrige RPC-Vertragsprüfung, Core-Authentifizierung und serverseitige
Berechtigungsprüfung bleiben für das eigentliche Buchen erforderlich.

## Optionale Auftragsdiagnose ab Core DEV.12

Core meldet zusätzlich `localOutbox.diagnosticsVersion = 1`. Die bestehenden
Bestelloperationen und die Datenbank `bonni-module-outbox-v1` bleiben unverändert.
Diagnose ist kein Finanzjournal und keine zusätzliche Berechtigung zum Buchen.

`diagnostics-record` benötigt `id` (Order-ID) und `event` mit einer eindeutigen
`eventId` und einem erlaubten `type`. Erlaubte Ereignisse: `INTAKE_STARTED`,
`INTAKE_STORED`, `INTAKE_FAILED`, `STORAGE_UNCERTAIN`, `SEND_STARTED`,
`SEND_SUCCEEDED`, `SEND_FAILED`, `SEND_ABORTED`, `LOCAL_ACK_FAILED`, `COMPLETED`,
`ORDER_REVIEW`, `RETRY_REQUESTED`, `ORDER_REMOVED`.

Optionale Felder: `occurredAt`, `durationMs`, `queueAgeMs`, `totalElapsedMs`,
`errorCode`, `httpStatus`, `replayed`, `droppedEventsBefore`. Core validiert diese
Felder und ergänzt `accountId`, `moduleId`, `recordedAt` und eine fortlaufende
`sequence`. Unbekannte Felder werden nicht gespeichert. Keine Rohfehlermeldungen,
Anfragenutzlasten, Namen, NFC-Tags, Passwörter oder Tokens im Diagnoseereignis.
Gleiche Ereignis-ID desselben Kontos/Moduls wird nur einmal gespeichert; spätere
Anfragen können ein vorhandenes Ereignis nicht überschreiben.

`diagnostics-list` liest standardmäßig nur das angemeldete Konto. `scope: device`
ist ausschließlich mit einem vom Core-Kontext bestätigten Stüberl-Managerprofil
zulässig (`access:app:app-stueberlapp:manager` bzw. `module.app-stueberlapp.manager`).
Rollen in der Anfragenutzlast zählen nicht. Kontofremde Aufträge der finanziellen
Bestellablage bleiben auch für diesen Diagnosezugriff unzugänglich.

Pagination: `after` (letzte Sequenz, initial 0), `limit` (höchstens 500), `snapshot`
(obere Sequenzgrenze aus der ersten Antwort). Antwort: `events`, `nextCursor`
(null am Ende), `snapshot`, `retentionDays: 30`, `maxEvents: 50000`. Ein Export
behält die erste Snapshot-Grenze und enthält dadurch keine nachträglich
hinzukommenden Ereignisse oder doppelten Zeilen.

Die getrennte IndexedDB-Datenbank `bonni-module-order-diagnostics-v1` verwendet
eigene Transaktionen. Sie verändert niemals Auftrag oder Verbuchung. Sie behält
bis zu 30 Tage und maximal 50.000 Ereignisse auf diesem Gerät/Browser/Core-Ursprung.
Alte Einträge werden beim Schreiben entfernt; abgelaufene Einträge werden auch
beim Lesen ausgefiltert. Das Entfernen eines Auftrags aus der Bestellablage
entfernt seine Diagnose nicht. Das Löschen der Browserdaten entfernt beides.

Die App wartet für Annahme und Verbuchung nicht auf Diagnoseschreibvorgänge.
Ein Diagnose-RPC läuft gleichzeitig; höchstens 200 Ereignisse warten in der App.
Nicht gespeicherte Ereignisse werden beim nächsten erfolgreichen Schreibvorgang
als `droppedEventsBefore` kenntlich gemacht. Bei abruptem Schließen, vollem
Gerätespeicher oder Ausfall des Core-Kanals können letzte Ereignisse fehlen.
Diese technische Diagnose ist daher kein lückenloses buchhalterisches Journal.

## Core DEV.13 – Diagnose des Modulstarts

Der opaque Modulkontext enthält zusätzlich `coreVersion`, die Version des sendenden
Core-Frontends. Dies ist eine Diagnoseangabe, kein Berechtigungsnachweis oder Ersatz
für `localOutbox.version === 1`. Die Fähigkeit wird aus `MODULE_OUTBOX_CAPABILITY`
im Speicherhandler-Modul übernommen. Ein fehlendes Versionsfeld in älteren Hosts
macht einen ansonsten gültigen v1-Vertrag nicht ungültig. Die sichere Sandbox und
die bestehende Bindung an Modul, Konto und RPC-Sitzung bleiben unverändert.
