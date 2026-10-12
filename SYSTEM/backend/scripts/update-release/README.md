# Release-Werkzeuge

> **OCI-/Container-Release:** Diese PEM-/Archiv-Werkzeuge gehören zum externen
> Container-Runner. Sie erstellen kein natives Windows-v2-PAYLOAD-Paket. Für
> die lokale, zertifizierte GitHub-Version des Windows-Aktionscenters gelten
> `scripts/signature-release/README.md` ab **Zertifiziertes lokales
> GitHub-Update** sowie `scripts/setup/READY-UPDATE-INSTALLER.md`.

Der private Ed25519-Schlüssel bleibt auf einem getrennten Release-Rechner.
Einmalig erzeugen:

```bash
node scripts/update-release/generate-release-key.mjs \
  --private /sicher/bonni-core-release-private.pem \
  --public /sicher/bonni-core-release-public.pem
```

Nur der öffentliche Schlüssel wird anschließend als Vertrauensschlüssel in die
Bonni-Core-Installationen kopiert.

`create-release.mjs` erwartet ein bereits geprüftes, per Registry-Digest
adressierbares Docker/OCI-Image-Archiv. Es lädt dieses auf dem Release-Rechner,
gleicht Repository, Digest und Plattform ab, berechnet Größe und SHA-256 und
erstellt danach das signierte Schema-2-Manifest:

```bash
npm run build
node scripts/update-release/create-release.mjs \
  --archive /release/bonni-core.oci \
  --image registry.example.org/bonni/core@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --version 0.1.19 \
  --private-key /sicher/bonni-core-release-private.pem \
  --key-id bonni-core-release \
  --output-dir /release/0.1.19
```

Das Core-Image enthält eine append-only Ops-Migrationskette unter
`ops/migrations`. Deshalb signiert die Release-Erstellung standardmäßig
`--migration expand-contract`. Solange dieser paketierte Migrationssatz nicht
leer ist, werden `none` und `offline` fail-closed abgelehnt. Der automatische
Runner prüft die signierte Strategie, testet dieselbe Kette zuerst auf der
isolierten Candidate-Datenbank und führt sie anschließend über den
`database-migrator` auf der normalen sowie – falls vorhanden – auf der
kanonischen redundanten Produktionsdatenbank aus.

Die SQL-Dateien müssen rückwärtskompatible Expand-Schritte bleiben. Contract-
oder Löschschritte gehören nicht in diese Online-Kette und dürfen erst nach dem
abgelaufenen Rückfall-Hold in einem getrennt kontrollierten Verfahren erfolgen.
