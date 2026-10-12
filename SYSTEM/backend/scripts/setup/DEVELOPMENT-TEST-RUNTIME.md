# Isolierter DEVELOPMENT-Test-Runtime-Adapter

Der Adapter startet einen durch `TEST-READY.json` belegten Entwicklungsstand,
ohne `SYSTEM`, die produktive PostgreSQL-Datenbank, den produktiven Storage,
den öffentlichen Port oder den Active-Proxy umzuschalten.

## Sicherheitsvertrag

- Eingaben sind immer `productRoot`, `candidateId` und der vollständige
  `packageSha256`.
- `DEVELOPMENT/TESTS/<candidateId>--<packageSha256>/TEST-READY.json` wird mit
  `development-package-store.mjs` authentisiert und der komplette `SYSTEM`-Baum
  erneut geprüft.
- Eine archivierte Freigabe ohne den noch vorhandenen `TESTS/.../SYSTEM`-Baum
  ist nicht startbar.
- Der Test verwendet eine eigene Runcontainer-Wurzel unter
  `RUN_SYSTEM/development-tests/<candidateId>--<packageSha256>/program-slots`.
  Die normalen Active-/Candidate-Zeiger bleiben unberührt.
- Die laufzeitnotwendigen Backend-Abhängigkeiten werden wie beim vorhandenen
  Local-Run-Vertrag mitkopiert; npm-Kommandoshims unter `node_modules/.bin`
  bleiben ausgeschlossen.
- Das Runtime-READY bindet `TEST-READY`, dessen tatsächlichen Dateihash, den
  Entwicklungsbaum, den versiegelten Candidate-Programmslot und den Beleg der
  Datenkopie.
- `candidate-data-clone.mjs` erstellt eine neue PostgreSQL-Datenbank sowie eine
  eigenständige Laufzeit-/Storage-Kopie. Dieselbe Datenbank-URL für Active und
  Candidate wird abgelehnt.
- Der Candidate bindet ausschließlich an Loopback und verwendet standardmäßig
  `4300` (HTTP), `4301` (Local Auth) und `4302` (Module Manager).
- `start` meldet erst `ready`, nachdem der Candidate dreimal Version, Rolle,
  isolierte Datenbank und fehlerfreie Module über seinen Update-Probe bestätigt
  hat.
- Es gibt keinen Aufruf der Proxy-, Promotion- oder Cutover-Funktionen.
- Fehlen `DATABASE_URL`, die produktiven Runtime-Verzeichnisse oder PostgreSQL-
  Werkzeuge (`pg_dump`, `pg_restore`, `createdb`, `dropdb`, `psql`), bricht
  `start` vor dem Candidate-Start geschlossen ab. `prepare` bleibt trotzdem
  verfügbar.

## CLI

```text
node SYSTEM/backend/scripts/setup/development-test-runtime-cli.mjs <Aktion> \
  --product-root "C:\Bonni Core" \
  --candidate-id "0.1.20e-dev.5" \
  --package-sha256 "<64 hex>"
```

Öffentliche Aktionen:

| Aktion | Wirkung |
|---|---|
| `prepare` | `TEST-READY` prüfen und isolierte Active-/Candidate-Programmkopien versiegeln; kein Prozess- oder Datenbankstart |
| `start` | sichere Datenkopie erstellen und Candidate ohne Proxy-Umschaltung starten |
| `status` | signierte Stage-/Runtime-Belege erneut prüfen und einen pfadfreien Status liefern |
| `stop` | authentisierten Stopauftrag an den Candidate-Worker senden und das bestätigte Ende abwarten |
| `cleanup` | Candidate stoppen, ausschließlich dessen DB/Storage bereinigen und die gebundene Testsandbox entfernen |

Optionale Parameter:

```text
--key-file <Datei>                    # sonst SIGNATUR/LOCAL/development-review.key
--source-run-system-root <Ordner>     # sonst BONNI_RUNTIME_STATE_ROOT,
                                      # RUN_SYSTEM_ROOT oder RUN_SYSTEM/runtime
--source-storage-root <Ordner>        # sonst BONNI_STORAGE_ROOT oder <runtime>/storage
--server-port <Port>                  # Standard 4300
--local-auth-port <Port>              # Standard 4301
--module-manager-port <Port>          # Standard 4302
--start-timeout-ms <Millisekunden>
--stop-timeout-ms <Millisekunden>
```

Für `start` und `cleanup` verwendet die CLI den bereits autoritativen
`loadStableBackendEnvironment()`-Loader aus `scripts/runtime/start-backend.mjs`.
Er prüft `SYSTEM/backend/.env` als einzelne reguläre, begrenzte und nicht
verknüpfte Datei und ergänzt daraus unter anderem `DATABASE_URL`; eine bereits
vom vertrauenswürdigen Starter gesetzte Prozessvariable behält Vorrang. Das
Windows-Center darf `.env` daher nicht selbst parsen. Die produktive Verbindung
wird nur im Child-Environment weitergereicht und gehört niemals in Argumente,
JSON-Ausgaben oder Belege, weil Kommandozeilenargumente für andere lokale
Prozesse sichtbar sein können.

Beispiel für `prepare`:

```json
{
  "candidateId": "0.1.20e-dev.5",
  "packageSha256": "...",
  "testReadySha256": "...",
  "finalTreeSha256": "...",
  "targetVersion": "0.1.20e",
  "ports": {
    "server": 4300,
    "localAuth": 4301,
    "moduleManager": 4302
  },
  "stageSha256": "...",
  "idempotent": false
}
```

Beispiel für ein erfolgreiches `start`:

```json
{
  "candidateId": "0.1.20e-dev.5",
  "packageSha256": "...",
  "targetVersion": "0.1.20e",
  "testReadySha256": "...",
  "finalTreeSha256": "...",
  "readySha256": "...",
  "ports": {
    "server": 4300,
    "localAuth": 4301,
    "moduleManager": 4302
  },
  "status": "ready",
  "workerPid": 1234,
  "childPid": 5678,
  "endpoint": "http://127.0.0.1:4300",
  "proxyCutover": false,
  "idempotent": false
}
```

Die technische Ausgabe des Candidate steht dauerhaft in
`RUN_SYSTEM/development-tests/<candidateId>--<packageSha256>/terminal.log`.
Das Windows-Center kann verständliche Schritte aus der JSON-Ausgabe anzeigen
und diese Logdatei separat in seinem scrollbaren Terminalbereich verfolgen.
Der Browser darf erst nach `status: "ready"` direkt mit dem Candidate-Endpunkt
`http://127.0.0.1:4300` geöffnet werden. Er darf dabei nicht auf Bonni-Port
`4000` oder den normalen Active-Endpunkt umgeleitet werden.

## Exportvertrag

`development-test-runtime.mjs` exportiert:

- `prepareDevelopmentTestRuntime(options, dependencies?)`
- `startDevelopmentTestRuntime(options, dependencies?)`
- `getDevelopmentTestRuntimeStatus(options, dependencies?)`
- `stopDevelopmentTestRuntime(options, dependencies?)`
- `cleanupDevelopmentTestRuntime(options, dependencies?)`
- `runDevelopmentTestRuntimeWorker(options, dependencies?)` (nur interne CLI)
- `resolveDevelopmentTestRuntimePaths(options)`
- `assertDevelopmentTestRuntimePortsAvailable(ports?)`

Der optionale `dependencies`-Parameter ist ausschließlich eine Testnaht. Das
Windows-Center verwendet nur die CLI und niemals `__worker` direkt.
