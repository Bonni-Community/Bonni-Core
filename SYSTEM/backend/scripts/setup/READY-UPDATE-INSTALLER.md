# READY-Update-Installer

`install-ready-update-package.mjs` ist die privilegierte Grenze zwischen einer
geprüften READY-Transaktion und den installierten Programmordnern. Der
Installer akzeptiert in Produktion ausschließlich ein signiertes
`bonni.update/v2`-Stable-Manifest aus dem lokalen öffentlichen Trust-Store.
Eine alte v1-Brücke ist hier ausdrücklich nicht erlaubt.

## Programmatischer Vertrag

Der normale Aktualisierungsdialog muss den exakten Beleg direkt weiterreichen:

```js
const prepared = await prepareUpdatePackage({ productRoot });
const result = await installReadyUpdatePackage({
  productRoot,
  preparedReceiptFile: prepared.receiptFile,
});
```

Der Pfad darf nicht aus Konsolentext gelesen und nicht durch eine mehrdeutige
Verzeichnissuche neu ermittelt werden. Der Installer konsumiert und verifiziert
den Beleg, die ZIP, das Manifest, READY und alle Komponenten erneut.

Das signierte Plattformfeld wird vor der Kandidatenkopie geprüft. `SYSTEM`
benötigt in v2 ausdrücklich `platform: "any"`. `WINDOWS` wird nur unter einer
Win32-Laufzeit angenommen und muss `windows-any` oder die exakt erkannte
Architektur `windows-x86`, `windows-x64` beziehungsweise `windows-arm64`
deklarieren. Eine falsche oder fehlende Plattform wird nicht stillschweigend
als kompatibel behandelt.

Enthält das Paket `WINDOWS`, lautet der erste Status `bootstrap-required`.
Bis dahin bleibt jeder Live-Programmordner unverändert. Nach dem Schließen des
Windows-Centers wird die zurückgegebene `bootstrapFile` gestartet oder die API
`applyReadyUpdateBootstrap({ productRoot, transactionRoot })` verwendet.

## CLI

```text
node SYSTEM/backend/scripts/setup/install-ready-update-package.mjs \
  --product-root <Bonni-Hauptordner> \
  --prepared-receipt <exakter PREPARED-RECEIPT.json-Pfad>
```

Windows-Bootstrap:

```text
node SYSTEM/backend/scripts/setup/install-ready-update-package.mjs \
  --apply-bootstrap \
  --product-root <Bonni-Hauptordner> \
  --transaction-root <exakter Transaktionsordner>
```

Die CLI verwendet kein stdin und gibt in e nur menschenlesbaren Konsolentext,
kein JSON, aus. Exitcode `0` bedeutet Erfolg beziehungsweise eine vollständig
veröffentlichte Bootstrap-Anforderung; ein sicherer Installer-Abbruch verwendet
Exitcode `23`.

## Saubere Developer-Basis

Bei jedem erfolgreichen `SYSTEM`-Update wird der unveränderte, erneut
hashgeprüfte SYSTEM-Payload atomar hier veröffentlicht:

```text
DEVELOPMENT/BASES/<technische-Systemversion>/
├─ BASE.json
└─ SYSTEM/
```

Diese Basis wird vor dem Übernehmen von `.env`, Uploads, Schlüsseln, Secrets,
Storage oder sonstigen Live-Daten separat kopiert. Auch Build-Ausgaben des
installierten Kandidaten werden nicht zurück in die Basis geschrieben. Eine
bereits vorhandene byteidentische Basis wird wiederverwendet; eine abweichende
Basis derselben Version wird niemals überschrieben und stoppt das Update vor
der ersten Live-Mutation. Veröffentlichung und Rücknahme sind an dasselbe
Installationsjournal gebunden.

## Offline-Build und Datenbankgrenze

Kandidatenabhängigkeiten werden ausschließlich mit
`npm ci --offline --no-audit --no-fund --include=dev` aufgebaut. Ein
Netzwerk-Fallback ist nicht vorgesehen.

Hat der read-only Migrations-Preflight keine ausstehenden Migrationen, kann der
Updateweg fortfahren. Hat er mindestens eine ausstehende Migration, ist diese
Updateklasse über die e-CLI bewusst **nicht installierbar**, weil die CLI noch
keinen sicheren lokalen Datenbank-Snapshotadapter besitzt. Der Installer bricht
vor jeder Live-Mutation mit
`READY_UPDATE_INSTALL_DATABASE_SNAPSHOT_REQUIRED` ab.

Ein privilegierter späterer Orchestrator darf einen lokalen
`databaseSnapshotController` bereitstellen. Dieser muss vor der Migration mit
`createAndVerify()` einen rückspielbaren, verifizierten Snapshot erzeugen und
mit `restore()` eine fehlgeschlagene oder unterbrochene Transaktion
deterministisch zurücksetzen. Ohne beide Funktionen bleibt der Weg fail-closed.

`LINUX` und `CONTAINER` sind in e ebenfalls nicht installierbar und werden
statt einer stillen Teilinstallation abgelehnt.
