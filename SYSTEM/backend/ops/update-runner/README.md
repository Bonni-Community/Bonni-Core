# Externer Bonni-Core-Update-Runner

Der Runner ist ein vom Web-Backend getrennter Hostprozess. Nur er erhält Zugriff
auf die Docker-API. Er veröffentlicht keinen Port und akzeptiert keine
Docker-Namen, Image-Tags, Compose-Pfade oder Befehle aus einem Update-Request.

## Feste Dateischnittstelle

Die gemeinsame IPC-Fläche (`BONNI_UPDATE_RUNNER_STATE_ROOT`) enthält nur:

```text
system/update-runner/
├── requests/<requestId>.json
├── progress/<requestId>.json
├── results/<requestId>.json
└── heartbeat.json
```

Claim, Nonce-Ledger, Lock, Staging, Active-Stand und das für einen Wiederanlauf
maßgebliche Journal liegen getrennt unter
`BONNI_UPDATE_RUNNER_PRIVATE_STATE_ROOT`. Der Runner vertraut niemals dem vom
Backend lesbaren Progress als Recovery-Quelle.

Der schreibende Dienst muss einen Request zunächst unter einem temporären Namen
vollständig schreiben und anschließend atomar nach `requests/<requestId>.json`
umbenennen. Dateien mit der Endung `.tmp` werden ignoriert.

Das Request-Schema hat Version 1. `release` ist unverändert das gemeinsame,
vollständig signierte Bonni-Release-Manifest mit Schema-Version 2 aus
`src/system/update-release`. Das unterstützte Installationsartefakt ist
`oci-image-archive`. `bonni-release-bundle` wird so lange sicher abgelehnt, bis
für dieses Format ein eigener, pfadsicherer Entpacker spezifiziert ist.

Jeder Request benötigt zusätzlich:

```json
{"auth":{"algorithm":"HMAC-SHA256","value":"<64 lowercase hex>"}}
```

Der MAC wird über
`BONNI_CORE_UPDATE_REQUEST_V1\n` + kanonisches JSON des normalisierten Requests
ohne `auth` + `\n` gebildet. Dafür exportiert
`src/system/update-runner/request-auth.mjs` die gemeinsame Funktion
`signUpdateRunnerRequest(unsignedRequest, secret)`. Das mindestens 32 Byte
lange Secret muss über `BONNI_UPDATE_REQUEST_SECRET_FILE` aus einer Datei mit
Modus `0600` kommen. Die Datei darf weder im gemeinsamen Storage noch im
privaten Runner-State liegen und muss separat in Backend und Runner gemountet
werden.

## Sicherheitsablauf

1. Request, Ablaufzeit und einmalige Nonce prüfen.
2. Release-Signatur, Paketgröße und SHA-256 erneut prüfen.
3. Vollständigen Backup-Dateisatz erneut prüfen.
4. OCI-Image laden und Repository, Digest und Plattform abgleichen.
5. `db-candidate`, Candidate-Kopie und Candidate-Storage isoliert starten, die
   Zielmigration dort ausführen und den Candidate dreimal auf `ready`,
   Datenbank, Rolle und Zielversion prüfen.
6. Proxy, Active, Emergency und alle produktiven Hilfsdienste stoppen. Der
   private Transaktions-Fence hält den Schreibstopp auch nach einem Absturz.
7. Einen konsistenten Cutover-Snapshot aus PostgreSQL, `storage` und
   `run_system` erstellen und vor jeder Produktionsmutation prüfen.
8. Updates mit Datenbankmigration weiterhin fail-closed ablehnen, bis eine
   echte versionierte, rückwärtskompatible Prisma-Migrationskette freigegeben
   ist. Der kontrollierte Produktions-Migrator ist bereits vorbereitet.
9. Kanonischen Active ersetzen, direkt prüfen und die Commit-Entscheidung
   dauerhaft in Fence und privatem Journal sichern.
10. Erst nach dieser Entscheidung Emergency und Proxy wieder freigeben; danach
    Candidate-Container und nur eindeutig gelabelte, projektgescopte
    Candidate-Volumes entfernen.

Vor `docker image load` wird die bisherige Active-Image-ID zusätzlich unter
dem zwingend konfigurierten, projektgescopten
`BONNI_ROLLBACK_IMAGE_TAG=<COMPOSE_PROJECT_NAME>-system:rollback` fixiert. Das
Archiv wird ohne Extraktion über seine Docker-`manifest.json` geprüft: erlaubt
ist höchstens der an signiertes Repository und Release-Version gebundene Tag;
Active-, Rollback- und sonstige Tags werden abgelehnt. Unmittelbar nach jedem
Load setzt der Runner den kanonischen Active-Tag wieder auf den Rollback-Pin.
Erst das vollständig erfolgreiche Candidate-Gate darf ihn auf das neue Image
setzen.

Der Rollback-Pin wird nach erfolgreichem Abschluss bewusst nicht gelöscht. Er
bleibt als Rückkehrpunkt bis zum Beginn des nächsten Updates erhalten; dort
wird derselbe projektgescopte Tag erst nach Prüfung des laufenden Active auf
dessen aktuelle Image-ID weitergesetzt. Dadurch gibt es keine gefährliche,
unkontrollierte Image-Löschung und mehrere Bonni-Instanzen kollidieren nicht.

Bei einem Fehler vor der dauerhaft gespeicherten Commit-Entscheidung werden die
vorherige Image-ID sowie PostgreSQL, `storage` und `run_system` gemeinsam aus
dem Cutover-Snapshot zurückgesetzt. PostgreSQL wird dabei vollständig neu
angelegt; neue, nur durch den fehlgeschlagenen Stand erzeugte Objekte bleiben
nicht zurück. Der Snapshot ist beim Restore nur lesbar und die quittierte
Restore-Attempt-ID liegt in einem getrennten Volume.

Nach einer dauerhaft gespeicherten Commit-Entscheidung ist ein Rücksprung auf
alte Daten ausdrücklich verboten. Ein unterbrochener Lauf setzt dann nur den
bereits entschiedenen Zielstand fort. Fortschritt, Fence und Active-Overlay
werden atomar bzw. in crash-sicherer Reihenfolge geschrieben. Während des
kurzen Cutovers ist die Anwendung bewusst nicht erreichbar; dadurch kann weder
Active noch Emergency nach dem Snapshot neue Schreibvorgänge annehmen.

## Vertrauensanker

Bevorzugt wird `config/update/trusted-keys.json` als Zuordnung von Key-ID zu
PEM-Datei oder PEM-Inhalt. Alternativ kann genau ein Schlüssel mit
`BONNI_UPDATE_PUBLIC_KEY_PATH` und `BONNI_UPDATE_KEY_ID` konfiguriert werden.

`COMPOSE_PROJECT_NAME` wird bevorzugt. Fehlt es, liest der Runner das
Compose-Projektlabel seines eigenen Containers über `HOSTNAME`. Projektwurzel,
Compose-Datei und kanonischer Active-Tag kommen ausschließlich aus der
Runner-Umgebung, niemals aus dem Request.
