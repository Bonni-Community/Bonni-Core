# Signierte Releases

> Die folgenden klassischen PEM-/Policy-Schritte bis zum Abschnitt
> **Zertifiziertes lokales GitHub-Update** gehören zum älteren OCI-/Container-
> Releasepfad. Das Windows-Aktionscenter verwendet ab dort den verschlüsselten
> `BONNI-KEYSTORE.bonni`, ein einzelnes `UPDATE-MANIFEST.json` und den Public
> Trust unter `RUN_INSTALL/trust`. Vertrauensdateien der beiden Wege sind nicht
> austauschbar.

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

## Zertifiziertes lokales GitHub-Update

Das Windows-Aktionscenter startet fuer das neue `bonni.update/v2`-Format:

```text
node scripts/signature-release/create-certified-github-release.mjs \
  --request <absoluter Auftragspfad> \
  --product-root <absoluter Bonni-Hauptordner> \
  --master-key-stdin
```

Der JSON-Auftrag enthaelt niemals das Masterpasswort. Es wird ausschliesslich als
eine umgeleitete Standardeingabezeile angenommen. Die CLI entsperrt lokal
`BONNI-KEYSTORE.bonni`, setzt einen ausgewaehlten SYSTEM-Stand aus der bestaetigten
Entwicklungskette neu zusammen und signiert `RELEASE` sowie jeden enthaltenen
PAYLOAD-Bereich mit getrennten Ed25519-Schluesseln. Reine WINDOWS-, LINUX- oder
CONTAINER-Releases benoetigen keine SYSTEM-Entwicklungskette.

Der Standard-Keystore besitzt zusaetzlich getrennte App-Schluessel fuer
`STUEBERLAPP`, `KONTORAPP`, `HOCKETAPP` und `KASSENAPP`. Sobald eine App in
`includedApps` steht, ist neben `RELEASE` und `SYSTEM` auch ihre eigene
`APP:<APPNAME>`-Signatur zwingend. Eine fehlende, falsche oder fuer eine andere
App freigegebene Signatur wird abgewiesen.

SYSTEM-Releases werden niemals aus dem laufenden `SYSTEM`-Ordner gebaut. Die CLI
liest die HMAC-verifizierte Approved Chain, waehlt deren unveraenderliche Basis
unter `DEVELOPMENT/BASES/<technische Basisversion>/SYSTEM`, prueft `BASE.json`
und den vollstaendigen Basisbaum und setzt darauf ausschliesslich die bestaetigte
Kette zusammen. Laufzeitdateien wie `.env`, Uploads oder Secrets aus dem aktiven
System gelangen dadurch nicht in das Release.

Beschreibung und ausgewaehlte Apps stehen im kanonisch signierten Manifest als
`releaseNotes` und `includedApps`. Das fertige ZIP wird vor der Freigabe mit dem
eigenen strengen Entpacker erneut gelesen und im Produktionsmodus verifiziert.
Es wird nur lokal unter `GITHUB/READY` abgelegt; es findet keine Netzwerk- oder
GitHub-Uebertragung statt.

Jeder signierte Payload traegt eine Plattform: `SYSTEM` verwendet `any`, die
aktuellen architekturunabhaengigen Windows-Werkzeuge `windows-any`. LINUX und
CONTAINER muessen ihre tatsaechlich freigegebene Plattform (`linux-x86`,
`linux-x64`, `linux-armv7` oder `linux-arm64`) in einer streng geprueften
`VERSION.json` angeben. Ohne diese Angabe wird kein Release erzeugt.

Der Publisher-Zaehlstand liegt getrennt vom Client-Akzeptanzstand unter
`SIGNATUR/RELEASE/SEQUENCE.json` und wird erst nach der erfolgreichen
ZIP-Selbstpruefung atomar fortgeschrieben. Der oeffentliche Vertrauensanker wird
einmalig unter `RUN_INSTALL/trust/UPDATE-PUBLIC-TRUST.json` angelegt. Eine
vorhandene abweichende Datei wird niemals ersetzt.

## Public Trust explizit auf einer Installation einrichten

Eine andere Installation uebernimmt ihren Vertrauensanker niemals aus einem
Update-ZIP. Zuerst wird mit `keystore:public` eine reine
`bonni.public-trust/v1`-Datei exportiert. Die dabei ausgegebene Datei-SHA-256 muss
ueber einen getrennten, bereits vertrauten Weg zur Zielinstallation gelangen.
Der Export liest das Keystore-Masterpasswort wie die anderen Keystore-Befehle
ausschliesslich aus umgeleiteter Standardeingabe:

```bat
npm run keystore:public -- ^
  --file "E:\BONNI-SIGNATUR\BONNI-KEYSTORE.bonni" ^
  --output "E:\BONNI-TRUST\UPDATE-PUBLIC-TRUST.json"
```

Die JSON-Erfolgsausgabe nennt unter `sha256` die exakte Datei-SHA-256 des
Exports. Diese Pruefsumme wird getrennt transportiert und vor dem Enrollment
verglichen.
Danach wird der Export lokal und einmalig eingerichtet:

```bat
npm run trust:enroll -- ^
  --product-root "C:\Bonni Core" ^
  --source "E:\BONNI-TRUST\UPDATE-PUBLIC-TRUST.json" ^
  --expected-sha256 "<64-stellige separat gepruefte Datei-SHA-256>"
```

`--product-root` und `--source` muessen absolute Pfade sein. Die Quelle darf
ausserhalb des Produktordners oder dort ausschliesslich unter `SIGNATUR` liegen;
insbesondere `UPDATE`, `GITHUB`, `RUN_INSTALL` und installierbare Payload-Bereiche
werden als Quelle abgewiesen. Symlinks, Hardlinks, unsichere Dateirechte,
ungueltiges JSON, unbekannte Felder, falsche Fingerabdruecke und jeder
Private-Key-Marker fuehren zum Abbruch.

Die Enrollment-CLI liest keine Standardeingabe und akzeptiert weder Passwort-
noch Private-Key-Argumente. Sie legt ausschliesslich
`RUN_INSTALL/trust/UPDATE-PUBLIC-TRUST.json` neu an. Existiert die Datei bereits,
wird nur bytegleicher oder semantisch identischer Public Trust akzeptiert und
niemals neu geschrieben. Ein anderer Store, andere Schluessel oder andere
Fingerabdruecke brechen als Konflikt ab; eine stille Rotation ist unmoeglich.
`RUN_INSTALL/trust/UPDATE-SEQUENCE.json` wird durch das Enrollment nicht erzeugt
oder veraendert.
