# PAYLOAD-Consumer

`consume-prepared-update-package.mjs` ist die sichere Grenze zwischen dem
ZIP-Eingang und einem späteren privilegierten Installer oder Bootstrapper.
Das Modul **installiert nichts** und verändert insbesondere weder `SYSTEM`,
`WINDOWS`, `RUN_SYSTEM`, `BACKUP` noch das ursprüngliche ZIP in `UPDATE`.

## Ablauf

1. `prepareUpdatePackage()` beansprucht und entpackt das lokale ZIP, prüft das
   Manifest und veröffentlicht einen `PREPARED-RECEIPT.json` unter
   `RUN_INSTALL/update-package-intake`.
2. `consumePreparedUpdatePackage()` liest diesen Beleg erneut, prüft die
   beanspruchte ZIP-Datei, den entpackten Paketbaum, das Manifest und dessen
   Vertrauensrichtlinie noch einmal.
3. Nur die im Manifest deklarierten Komponenten werden Datei für Datei in einen
   privaten Arbeitsordner kopiert und erneut gegen Größe und SHA-256 geprüft.
4. Erst nach vollständiger Prüfung wird der ganze Transaktionsordner durch ein
   Verzeichnis-Rename veröffentlicht. `READY.json` wird darin zuletzt erzeugt.
5. Ein späterer Installer muss unmittelbar vor einem Live-Austausch
   `verifyReadyUpdateTransaction()` aufrufen. `READY.json` allein ist kein
   Vertrauensanker.

Für v2-Produktionspakete laden `prepareUpdatePackage()` und der Consumer ohne
explizit übergebene Sonderrichtlinie automatisch den lokalen öffentlichen
Vertrauensspeicher aus `RUN_INSTALL/trust`. Weder das Vorbereiten noch das
Erzeugen einer READY-Transaktion verändert dabei `UPDATE-SEQUENCE.json`.
Die Rollback-Sequenz darf erst nach dem tatsächlich erfolgreichen Live-Commit
über `recordAcceptedUpdateSequence()` fortgeschrieben werden.

Der veröffentlichte Aufbau lautet:

```text
RUN_INSTALL/
└─ update-package-ready/
   └─ transactions/
      └─ <transactionId>/
         ├─ COMPONENTS/
         │  ├─ SYSTEM/       nur wenn deklariert
         │  └─ WINDOWS/      nur wenn deklariert
         └─ READY.json
```

`SYSTEM` und `WINDOWS` besitzen unabhängige Versionen. Ein Paket darf nur eine
der beiden Komponenten enthalten. Der Consumer erfindet keine fehlende
Komponente und mischt keine Dateien aus einem anderen Paket hinzu. Deklarierte
`LINUX`- oder `CONTAINER`-Payloads werden derzeit sicher abgelehnt, bis ein
eigener plattformspezifischer Consumer dafür existiert.

## Exportvertrag

Das Modul exportiert:

- `consumePreparedUpdatePackage(options)` – veröffentlicht oder verwendet eine
  bereits identische READY-Transaktion. Rückgabestatus: `ready` oder
  `already-ready`.
- `verifyReadyUpdateTransaction(options)` – prüft PREPARED-Beleg, Paket,
  Manifest, READY-Beleg und alle bereitgestellten Dateien erneut.
- `READY_UPDATE_TRANSACTION_SCHEMA` – derzeit `bonni.update-ready/v1`.
- `PreparedUpdateConsumerError` – Fehler mit stabilem `code` und optionalem
  `detail`.

Wichtige Optionen beider Funktionen:

```js
{
  productRoot,              // Bonni-Core-Hauptordner
  preparedReceiptFile,      // empfohlen; sonst muss genau ein Beleg existieren
  verifyManifest,           // optionaler vertrauensgebundener Verifier
  verificationPolicy       // optional; standardmäßig lokaler Production-Trust
}
```

`consumePreparedUpdatePackage()` akzeptiert zusätzlich `now`, `onPhase` und
interne Test-Hooks. Das Ergebnis enthält mindestens `transactionId`,
`transactionRoot`, `readyFile`, `receipt` und das erneut geprüfte Manifest.

Die `transactionId` ist ein SHA-256 über den exakten PREPARED-Beleg, das ZIP,
das Manifest und die Identitäten aller deklarierten Payloads. Ein anderer
Paketinhalt kann deshalb nicht denselben Transaktionsordner wiederverwenden.

## Integrationspunkt

Der Aufrufer soll den von `prepareUpdatePackage()` zurückgegebenen
`receiptFile` ohne erneute Suche direkt weiterreichen:

```js
const prepared = await prepareUpdatePackage({ productRoot, verifyManifest });
if (prepared.receiptFile) {
  const ready = await consumePreparedUpdatePackage({
    productRoot,
    preparedReceiptFile: prepared.receiptFile,
    verifyManifest,
    verificationPolicy,
  });
  // Hier noch kein Live-Swap.
  // ready.readyFile wird an den privilegierten Bootstrapper übergeben.
}
```

Der spätere Bootstrapper muss:

1. denselben Vertrauensspeicher und die aktuelle Rollback-Sequenz verwenden;
2. `verifyReadyUpdateTransaction()` direkt vor jeder Änderung aufrufen;
3. ausschließlich die in `receipt.components` genannten Komponenten tauschen;
4. für `SYSTEM` und `WINDOWS` getrennte Sicherungs- und Rollback-Schritte
   verwenden;
5. den erfolgreichen Live-Austausch in einem eigenen Commit-Beleg festhalten.

## CLI

Die CLI ist für die lokale einmalige Vorbereitung vorhanden:

```text
node scripts/setup/consume-prepared-update-package.mjs \
  --product-root "C:\Bonni Core" \
  --prepared-receipt "C:\Bonni Core\RUN_INSTALL\...\PREPARED-RECEIPT.json"
```

Für die einmalige lokale v1-Vertrauensbrücke von `0.1.20d` zu `0.1.20e` muss
zusätzlich ausdrücklich `--manual-bootstrap-v1` angegeben werden. Ohne diese
Option wird ein altes unsigniertes v1-Manifest nicht akzeptiert.

Die CLI gibt lediglich die `transactionId` und den Pfad zu `READY.json` aus.
Sie führt keinen Live-Austausch durch.
