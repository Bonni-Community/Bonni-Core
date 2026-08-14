# Release-Werkzeuge

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

Migrationsangaben können für ein späteres, manuelles Wartungsverfahren signiert
werden. Der automatische Runner dieser Version installiert jedoch bewusst nur
`--migration none`, bis Bonni Core eine vollständige versionierte
Prisma-Migrationskette besitzt.
