# Bonni-Core-Updates

Bonni Core installiert ausschließlich ein vollständiges, signiertes Systemimage.
Frontend und Backend haben dabei dieselbe Version. Das Manifest verwendet
Schema 2 und bindet Paketgröße, SHA-256, OCI-Image-Identität, Plattform,
Migrationsart, Gültigkeitszeitraum und Mindestversion des Runners an eine
Ed25519-Signatur.

## Vertrauensschlüssel

Im Produktivbetrieb muss der öffentliche Ed25519-Schlüssel über
`BONNI_UPDATE_TRUSTED_KEYS_DIR/<keyId>.pem` oder
`BONNI_UPDATE_PUBLIC_KEY_PATH` bereitgestellt werden. Der private Schlüssel
gehört ausschließlich auf das getrennte Release-System und darf niemals in
Bonni Core, ein Docker-Image oder ein Update-ZIP kopiert werden.

Ohne eingerichteten öffentlichen Schlüssel bleibt der Runner erreichbar, lehnt
aber jede Installation sicher ab. Ein angeblicher Bonni-Standardschlüssel wird
nicht automatisch erzeugt; der Vertrauensanker muss bewusst vom Betreiber oder
vom späteren offiziellen Bonni-Release-System kommen.

Unsignierte Pakete sind gesperrt. `BONNI_ALLOW_UNSIGNED_UPDATES=true` gilt nur
bei `NODE_ENV=development` oder `test`, nur für lokale Dateien und darf im
Produktivbetrieb nicht gesetzt werden.

## Quellen

Lokale Releases liegen unter `updates/bonni-core/manifest.json`; der Paketpfad
im Manifest ist relativ dazu und darf den Ordner nicht verlassen. Entfernte
Manifeste werden nur über HTTPS geladen. Zulässige Ursprünge können zusätzlich
mit `BONNI_UPDATE_ALLOWED_ORIGINS` als kommaseparierte Liste festgelegt werden.
Weiterleitungen auf andere Ursprünge, lokale Netze, Zugangsdaten in URLs und
unsichere Ports werden verweigert.

Downloads sind standardmäßig auf 2 GiB begrenzt (`BONNI_UPDATE_MAX_BYTES`).
Größe und SHA-256 müssen exakt mit dem signierten Manifest übereinstimmen.

## Installationsablauf

1. Manifest, Version, Store-Kompatibilität und freier Speicher werden geprüft.
2. Das OCI-Archiv wird geladen und erneut gegen Signatur, Größe und SHA-256 geprüft.
3. PostgreSQL, Konfiguration und persistente Dateien werden vollständig gesichert.
4. Der getrennte Update-Runner prüft Sicherung und Signatur erneut.
5. Candidate-Datenbank und Candidate-Dateien werden isoliert kopiert.
6. Der Candidate wird dreifach einschließlich Module und Image-Version geprüft.
7. Der unveränderte Proxy hält Bonni Core über Notlauf erreichbar, während
   Active ersetzt wird; er wird niemals an das Candidate-Netz angeschlossen.
8. Schlägt eine Prüfung fehl, setzt der Runner das vorherige Image automatisch
   wieder ein und meldet den Rollback im Systemstatus.

Diese Version installiert automatisch ausschließlich Releases ohne
Datenbankänderung (`required: false`, `strategy: none`). Für die vorhandene,
bisher mit `db push` aufgebaute Datenbank existiert noch keine lückenlos
versionierte Migrationskette. Deshalb werden auch als `expand-contract`
markierte Releases bis zu dieser Umstellung sicherheitshalber abgelehnt.
