# Signierte Releases

Der Release-CLI liest private Schluessel ausschliesslich aus einem explizit angegebenen
`SIGNATUR`-Root, typischerweise von einem USB-Stick. Alternativ zu
`--signature-root` kann `BONNI_SIGNATURE_ROOT` gesetzt werden.

```text
BONNI_SIGNATUR/
  root/
    policy.json
    keys/release-private.pem
    keys/release-public.pem
  core/
    policy.json
    keys/release-private.pem
    keys/release-public.pem
  apps/
    kontor/policy.json
    stueberl/policy.json
    hocket/policy.json
```

Beispiel fuer `core/policy.json`:

```json
{
  "schemaVersion": 1,
  "productId": "bonni-core",
  "keyScope": "core",
  "keyId": "bonni-core-release-2026-01",
  "privateKeyRelativePath": "keys/release-private.pem"
}
```

Jeder Zielbereich benoetigt seine eigene Richtlinie und seinen eigenen Ed25519-Schluessel.
Symlinks, Hardlinks, Pfadwechsel aus dem Zielbereich und ein falscher Produktscope werden
abgewiesen. Private Schluessel oder deren Inhalt werden nicht ausgegeben.

Der Speicher kann einmalig direkt auf dem USB-Stick angelegt werden. Vorhandene
Bereiche werden niemals ueberschrieben:

```bat
npm run signature:init -- --signature-root E:\BONNI_SIGNATUR root core kontor stueberl hocket
```

Der Core-Trockenlauf prueft Richtlinie, Schluessel und aktuelle Version, ohne ein Paket zu
erzeugen:

```bat
npm run release -- core --signature-root E:\BONNI_SIGNATUR --dry-run
```

Die eigentliche Core-Erstellung baut mit Docker das geschlossene OCI-Systemimage,
verwendet intern einen Docker-kompatiblen Tag (`0.1.19+d` wird `0.1.19-d`) und
signiert ein GitHub-faehiges Manifest:

```bat
npm run release -- core --signature-root E:\BONNI_SIGNATUR
```

Das signierte Manifest ist standardmaessig 90 Tage gueltig. Es kann innerhalb
dieses Zeitraums unveraendert von anderen Installationen geprueft werden. Ist
das neueste Release danach weiterhin aktuell, wird es mit demselben geprueften
Quellstand neu signiert und als aktuelles GitHub-Release veroeffentlicht.

Die Ausgabe liegt unter `GITHUB/RELEASES/core/<Version>`; der zugehoerige
oeffentliche Schluessel und sein Fingerabdruck werden getrennt unter
`GITHUB/TRUST` exportiert. Dieser Public Key muss auf einer Installation einmalig
als Vertrauensanker eingerichtet werden. Ein im Release selbst mitgelieferter Key
darf niemals automatisch vertraut werden.

Der Export nach `GITHUB/TRUST` ist wiederholbar, aber absichtlich nicht
ueberschreibend: Ist `<keyId>.pem` beziehungsweise `<keyId>.json` bereits mit
identischem Inhalt vorhanden, bleibt die Datei unveraendert. Weicht der Inhalt bei
derselben `keyId` ab, bricht die Release-Erstellung mit
`PUBLIC_TRUST_KEY_ID_CONFLICT` ab. Fuer einen Schluesselwechsel ist deshalb immer
eine neue `keyId` erforderlich.

## Einmaliger manueller Trust-Bootstrap

Eine neue Bonni-Installation vertraut dem exportierten Public Key nicht
automatisch. Vor der ersten Installation eines signierten Updates muss eine
berechtigte Person den Fingerabdruck ueber einen getrennten, bereits vertrauten
Weg vergleichen, zum Beispiel direkt mit dem Public Key auf dem Signatur-USB-Stick
oder mit der dort bei der Schluesselerzeugung notierten Pruefsumme.

Der in `GITHUB/TRUST/<keyId>.json` angegebene Wert ist SHA-256 ueber den
SPKI-DER-Schluessel. Er kann unter Windows mit Node.js unabhaengig aus der PEM-Datei
berechnet werden:

```bat
node -e "const c=require('node:crypto'),f=require('node:fs');const k=c.createPublicKey(f.readFileSync(process.argv[1]));console.log(c.createHash('sha256').update(k.export({type:'spki',format:'der'})).digest('hex'))" "GITHUB\TRUST\<keyId>.pem"
```

Nur wenn dieser Wert exakt mit dem getrennt geprueften Fingerabdruck uebereinstimmt,
wird der Schluessel einmalig und manuell in den Trust-Speicher der Installation
kopiert:

```bat
mkdir "runtime\secrets\update\trusted-keys"
copy /-Y "GITHUB\TRUST\<keyId>.pem" "runtime\secrets\update\trusted-keys\<keyId>.pem"
```

`<keyId>` muss dabei exakt der Kennung aus `policy.json` entsprechen. Eine bereits
vorhandene Trust-Datei wird nicht ersetzt. Bei einer Abweichung oder Unsicherheit
wird nicht kopiert und kein Update gestartet. Weder der Release-CLI noch Bonni Core
darf einen Schluessel allein deshalb automatisch vertrauen, weil er zusammen mit
einem Release heruntergeladen wurde.

Ein bereits geprueftes OCI-Archiv kann alternativ mit `--archive` und `--image`
uebergeben werden. Installierbare App-Pakete sind bis zur Einfuehrung eines
eigenen App-Releaseformats absichtlich gesperrt; vorhandene App-Schluessel werden
bereits strikt ihrem jeweiligen Produktscope zugeordnet.
