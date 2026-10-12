#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly DEFAULT_REPOSITORY="ghcr.io/bonni-community/bonni-core"

usage() {
  cat <<'EOF'
Bonni Core als geprueftes Docker-save-Archiv auf Unraid bauen.

Verwendung:
  build-core-oci-unraid.sh --output-root <Verzeichnis> [Optionen]

Optionen:
  --output-root <Pfad>    Zielverzeichnis fuer OCI-Archiv, SHA-256 und artifact.json.
  --repository <Name>     Image-Repository (Standard: ghcr.io/bonni-community/bonni-core).
  --revision <Wert>       Quellrevision fuer das OCI-Label; sonst Git-HEAD oder source-package.
  -h, --help              Diese Hilfe anzeigen.

Das Skript liest die sichtbare Version aus SYSTEM/backend/package.json.
Ein SemVer-Buildsuffix wird fuer den Docker-Tag umgeschrieben, zum Beispiel:
  0.1.20+e -> 0.1.20-e

Private Signaturschluessel werden weder gelesen noch in das Image uebernommen.
EOF
}

die() {
  printf 'FEHLER: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Erforderlicher Befehl fehlt: $1"
}

OUTPUT_ROOT=""
REPOSITORY="${BONNI_CORE_REPOSITORY:-$DEFAULT_REPOSITORY}"
REVISION="${BONNI_CORE_REVISION:-}"

while (($# > 0)); do
  case "$1" in
    --output-root)
      (($# >= 2)) || die "--output-root benoetigt einen Pfad."
      OUTPUT_ROOT="$2"
      shift 2
      ;;
    --repository)
      (($# >= 2)) || die "--repository benoetigt einen Namen."
      REPOSITORY="$2"
      shift 2
      ;;
    --revision)
      (($# >= 2)) || die "--revision benoetigt einen Wert."
      REVISION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unbekannte Option: $1"
      ;;
  esac
done

[[ -n "$OUTPUT_ROOT" ]] || die "--output-root ist erforderlich."
[[ "$REPOSITORY" =~ ^[a-z0-9][a-z0-9._/-]*[a-z0-9]$ ]] \
  || die "Ungueltiges Docker-Repository: $REPOSITORY"
[[ "$REPOSITORY" != *".."* && "$REPOSITORY" != *"//"* ]] \
  || die "Ungueltiges Docker-Repository: $REPOSITORY"
[[ "$REVISION" != *$'\n'* && "$REVISION" != *$'\r'* ]] \
  || die "Die Revision darf keinen Zeilenumbruch enthalten."

require_command docker
require_command sed
require_command sha256sum
require_command tar
require_command mktemp
require_command date
require_command wc
require_command mv

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PRODUCT_ROOT="$(cd -- "$SCRIPT_DIR/../../../.." && pwd -P)"
BACKEND_PACKAGE="$PRODUCT_ROOT/SYSTEM/backend/package.json"
DOCKERFILE="$PRODUCT_ROOT/SYSTEM/backend/Dockerfile"
DOCKERIGNORE="$DOCKERFILE.dockerignore"
ARCHIVE_VERIFIER="$PRODUCT_ROOT/SYSTEM/backend/src/system/update-runner/archive-tags.mjs"

[[ -f "$BACKEND_PACKAGE" ]] || die "Backend-package.json fehlt: $BACKEND_PACKAGE"
[[ -f "$DOCKERFILE" ]] || die "Dockerfile fehlt: $DOCKERFILE"
[[ -f "$DOCKERIGNORE" ]] || die "Die zum Dockerfile gehoerende Ignore-Datei fehlt: $DOCKERIGNORE"
[[ -f "$ARCHIVE_VERIFIER" ]] || die "Offline-Archivpruefung fehlt: $ARCHIVE_VERIFIER"

mapfile -t VERSION_VALUES < <(
  sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)"[[:space:]]*,?[[:space:]]*$/\1/p' \
    "$BACKEND_PACKAGE"
)
(( ${#VERSION_VALUES[@]} == 1 )) \
  || die "package.json muss genau eine eindeutige version-Zeile enthalten."
VERSION="${VERSION_VALUES[0]}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]] \
  || die "Ungueltige Bonni-Core-Version in package.json: $VERSION"

DOCKER_TAG="${VERSION//+/-}"
[[ "$DOCKER_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] \
  || die "Aus der Version konnte kein sicherer Docker-Tag gebildet werden: $DOCKER_TAG"
IMAGE_REF="${REPOSITORY}:${DOCKER_TAG}"

if [[ -z "$REVISION" ]]; then
  if command -v git >/dev/null 2>&1 \
    && git -C "$PRODUCT_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    REVISION="$(git -C "$PRODUCT_ROOT" rev-parse --verify HEAD)"
  else
    REVISION="source-package"
  fi
fi
[[ -n "$REVISION" && ${#REVISION} -le 255 ]] || die "Die Revision ist leer oder zu lang."

mkdir -p -- "$OUTPUT_ROOT"
OUTPUT_ROOT="$(cd -- "$OUTPUT_ROOT" && pwd -P)"

ARCHIVE_NAME="bonni-core-${DOCKER_TAG}.oci"
ARCHIVE_PATH="$OUTPUT_ROOT/$ARCHIVE_NAME"
SHA_PATH="${ARCHIVE_PATH}.sha256"
ARTIFACT_PATH="$OUTPUT_ROOT/artifact.json"

for final_path in "$ARCHIVE_PATH" "$SHA_PATH" "$ARTIFACT_PATH"; do
  [[ ! -e "$final_path" ]] \
    || die "Zieldatei existiert bereits; es wird nichts ueberschrieben: $final_path"
done

ARCHIVE_TEMP=""
SHA_TEMP=""
ARTIFACT_TEMP=""
cleanup_temporary_files() {
  local status=$?
  [[ -z "$ARCHIVE_TEMP" ]] || rm -f -- "$ARCHIVE_TEMP"
  [[ -z "$SHA_TEMP" ]] || rm -f -- "$SHA_TEMP"
  [[ -z "$ARTIFACT_TEMP" ]] || rm -f -- "$ARTIFACT_TEMP"
  return "$status"
}
trap cleanup_temporary_files EXIT

printf '[bonni-core-oci] Produktroot: %s\n' "$PRODUCT_ROOT"
printf '[bonni-core-oci] Version: %s\n' "$VERSION"
printf '[bonni-core-oci] Image: %s\n' "$IMAGE_REF"
printf '[bonni-core-oci] Core-only-Image wird gebaut ...\n'

docker build \
  --file "$DOCKERFILE" \
  --tag "$IMAGE_REF" \
  --build-arg "BONNI_CORE_VERSION=$VERSION" \
  --build-arg "BONNI_CORE_REVISION=$REVISION" \
  "$PRODUCT_ROOT"

IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE_REF")"
IMAGE_OS="$(docker image inspect --format '{{.Os}}' "$IMAGE_REF")"
IMAGE_ARCH="$(docker image inspect --format '{{.Architecture}}' "$IMAGE_REF")"
IMAGE_VARIANT="$(docker image inspect --format '{{.Variant}}' "$IMAGE_REF")"
LABEL_PRODUCT="$(docker image inspect --format '{{index .Config.Labels "org.bonni.product"}}' "$IMAGE_REF")"
LABEL_VERSION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE_REF")"
LABEL_REVISION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE_REF")"
LABEL_CONTRACT="$(docker image inspect --format '{{index .Config.Labels "org.bonni.runtime.contract"}}' "$IMAGE_REF")"

[[ "$IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] || die "Docker lieferte keine gueltige Image-ID."
[[ "$IMAGE_OS" == "linux" ]] || die "Core-Image muss Linux enthalten; gefunden: $IMAGE_OS"
[[ "$IMAGE_ARCH" == "amd64" || "$IMAGE_ARCH" == "arm64" ]] \
  || die "Core-Image muss amd64 oder arm64 enthalten; gefunden: $IMAGE_ARCH"
[[ "$LABEL_PRODUCT" == "bonni-core" ]] || die "Core-Produktlabel fehlt oder ist falsch."
[[ "$LABEL_VERSION" == "$VERSION" ]] || die "Core-Versionslabel stimmt nicht mit package.json ueberein."
[[ "$LABEL_REVISION" == "$REVISION" ]] || die "Core-Revisionslabel stimmt nicht mit dem Build ueberein."
[[ "$LABEL_CONTRACT" == "1" ]] || die "Bonni-Runtimevertrag des Images ist ungueltig."

printf '[bonni-core-oci] Plattform, Labels, Core-Inhalt und Lizenzen werden geprueft ...\n'

docker run --rm \
  --entrypoint node \
  -e "BONNI_EXPECTED_VERSION=$VERSION" \
  "$IMAGE_REF" \
  -e '
    const fs = require("node:fs");
    const path = require("node:path");

    const version = process.env.BONNI_EXPECTED_VERSION;
    const fail = (message) => { throw new Error(message); };
    const coreOnlyDirectories = ["/app/app", "/app/apps", "/app/addons", "/app/plugins", "/app/bridges"];

    for (const directory of coreOnlyDirectories) {
      if (!fs.statSync(directory).isDirectory()) fail(`CORE_DIRECTORY_MISSING:${directory}`);
      if (fs.readdirSync(directory).length !== 0) fail(`NON_CORE_PAYLOAD_FOUND:${directory}`);
    }
    if (fs.existsSync("/app/licenses/modules")) fail("MODULE_LICENSES_FOUND");
    if (fs.existsSync("/app/SIGNATUR") || fs.existsSync("/app/signatur")) fail("SIGNATURE_STORE_FOUND");

    const catalogPath = "/app/licenses/catalog.json";
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    if (catalog.schemaVersion !== "bonni.license-catalog/v1") fail("CORE_LICENSE_CATALOG_SCHEMA_INVALID");
    if (!Array.isArray(catalog.entries) || catalog.entries.length !== 1) fail("CORE_LICENSE_CATALOG_NOT_CORE_ONLY");
    const entry = catalog.entries[0];
    const expectedReceipt = `platform/bonni-core/${version}/RECEIPT.json`;
    if (entry.type !== "platform" || entry.key !== "bonni-core" || entry.version !== version || entry.receipt !== expectedReceipt) {
      fail("CORE_LICENSE_CATALOG_ENTRY_INVALID");
    }
    const receipt = JSON.parse(fs.readFileSync(path.join("/app/licenses", expectedReceipt), "utf8"));
    if (receipt.schemaVersion !== "bonni.platform-legal-receipt/v1" || receipt.product !== "bonni-core" || receipt.version !== version) {
      fail("CORE_LICENSE_RECEIPT_INVALID");
    }

    const privateName = /(^id_(rsa|dsa|ecdsa|ed25519)(\.pem)?$|\.(jwk|key|kdbx|keystore|p12|pfx|pkcs8)$|private[^/]*\.(pem|key|jwk|der)$)/i;
    const privateMarker = /(?:^|\r?\n)[\t ]*-----BEGIN (?:(?:[A-Z0-9]+ )*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\t ]*(?:\r?\n)/m;
    const pending = ["/app"];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const item of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) {
          pending.push(absolute);
          continue;
        }
        if (!item.isFile()) continue;
        if (privateName.test(item.name)) fail(`PRIVATE_KEY_FILE_FOUND:${absolute}`);
        const size = fs.statSync(absolute).size;
        if (size <= 1024 * 1024 && privateMarker.test(fs.readFileSync(absolute, "utf8"))) {
          fail(`PRIVATE_KEY_MATERIAL_FOUND:${absolute}`);
        }
      }
    }
    process.stdout.write("Core-only-, Lizenz- und Schluesselpruefung: OK\n");
  '

ARCHIVE_TEMP="$(mktemp "$OUTPUT_ROOT/.${ARCHIVE_NAME}.part.XXXXXX")"
SHA_TEMP="$(mktemp "$OUTPUT_ROOT/.${ARCHIVE_NAME}.sha256.part.XXXXXX")"
ARTIFACT_TEMP="$(mktemp "$OUTPUT_ROOT/.artifact.json.part.XXXXXX")"

printf '[bonni-core-oci] Docker-Archiv wird geschrieben und geprueft ...\n'
docker image save --output "$ARCHIVE_TEMP" "$IMAGE_REF"
[[ -s "$ARCHIVE_TEMP" ]] || die "Docker hat ein leeres Archiv erzeugt."

docker run --rm -i \
  --entrypoint node \
  --volume "$ARCHIVE_TEMP:/work/image.oci:ro" \
  --volume "$ARCHIVE_VERIFIER:/work/archive-tags.mjs:ro" \
  -e "BONNI_EXPECTED_VERSION=$VERSION" \
  -e "BONNI_EXPECTED_TAG=$IMAGE_REF" \
  -e "BONNI_EXPECTED_DIGEST=$IMAGE_ID" \
  -e "BONNI_EXPECTED_REVISION=$REVISION" \
  -e "BONNI_EXPECTED_OS=$IMAGE_OS" \
  -e "BONNI_EXPECTED_ARCH=$IMAGE_ARCH" \
  -e "BONNI_EXPECTED_VARIANT=$IMAGE_VARIANT" \
  "$IMAGE_REF" \
  --input-type=module - <<'NODE'
  const { inspectCoreDockerArchivePayload } = await import("file:///work/archive-tags.mjs");
  const version = process.env.BONNI_EXPECTED_VERSION;
  const expectedTag = process.env.BONNI_EXPECTED_TAG;
  const identity = await inspectCoreDockerArchivePayload("/work/image.oci", { version });
  if (identity.tags.length !== 1 || identity.tags[0] !== expectedTag) {
    throw new Error("CORE_RELEASE_ARCHIVE_TAG_INVALID");
  }
  if (identity.digest !== process.env.BONNI_EXPECTED_DIGEST) {
    throw new Error("CORE_RELEASE_ARCHIVE_DIGEST_INVALID");
  }
  const expectedPlatform = {
    os: process.env.BONNI_EXPECTED_OS,
    architecture: process.env.BONNI_EXPECTED_ARCH,
    ...(process.env.BONNI_EXPECTED_VARIANT ? { variant: process.env.BONNI_EXPECTED_VARIANT } : {}),
  };
  if (JSON.stringify(identity.platform) !== JSON.stringify(expectedPlatform)) {
    throw new Error("CORE_RELEASE_ARCHIVE_PLATFORM_INVALID");
  }
  for (const [label, expected] of [
    ["org.bonni.product", "bonni-core"],
    ["org.opencontainers.image.version", version],
    ["org.opencontainers.image.revision", process.env.BONNI_EXPECTED_REVISION],
    ["org.bonni.runtime.contract", "1"],
  ]) {
    if (identity.labels[label] !== expected) throw new Error(`CORE_RELEASE_ARCHIVE_LABEL_INVALID:${label}`);
  }
  process.stdout.write("Offline-Archivinhalt: OK\n");
NODE

tar -xOf "$ARCHIVE_TEMP" manifest.json \
  | docker run --rm -i --entrypoint node \
      -e "BONNI_EXPECTED_TAG=$IMAGE_REF" \
      "$IMAGE_REF" \
      -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => {
          const manifest = JSON.parse(input);
          const tags = manifest.flatMap((entry) => Array.isArray(entry.RepoTags) ? entry.RepoTags : []);
          if (manifest.length !== 1 || tags.length !== 1 || tags[0] !== process.env.BONNI_EXPECTED_TAG) {
            throw new Error("ARCHIVE_NOT_SINGLE_VERSION_TAG");
          }
          process.stdout.write("Archivtag: OK\n");
        });
      '

ARCHIVE_SHA256="$(sha256sum "$ARCHIVE_TEMP" | sed -E 's/[[:space:]].*$//')"
[[ "$ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]] || die "Archiv-SHA-256 konnte nicht bestimmt werden."
ARCHIVE_SIZE="$(wc -c < "$ARCHIVE_TEMP")"
[[ "$ARCHIVE_SIZE" =~ ^[0-9]+$ && "$ARCHIVE_SIZE" -gt 0 ]] || die "Archivgroesse ist ungueltig."
CREATED_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

printf '%s  %s\n' "$ARCHIVE_SHA256" "$ARCHIVE_NAME" > "$SHA_TEMP"

docker run --rm \
  --entrypoint node \
  -e "ARTIFACT_SCHEMA=bonni.core-oci-artifact/v1" \
  -e "ARTIFACT_PRODUCT=bonni-core" \
  -e "ARTIFACT_VERSION=$VERSION" \
  -e "ARTIFACT_DOCKER_TAG=$DOCKER_TAG" \
  -e "ARTIFACT_REPOSITORY=$REPOSITORY" \
  -e "ARTIFACT_REFERENCE=$IMAGE_REF" \
  -e "ARTIFACT_IMAGE_ID=$IMAGE_ID" \
  -e "ARTIFACT_REVISION=$REVISION" \
  -e "ARTIFACT_OS=$IMAGE_OS" \
  -e "ARTIFACT_ARCH=$IMAGE_ARCH" \
  -e "ARTIFACT_VARIANT=$IMAGE_VARIANT" \
  -e "ARTIFACT_ARCHIVE_NAME=$ARCHIVE_NAME" \
  -e "ARTIFACT_ARCHIVE_SIZE=$ARCHIVE_SIZE" \
  -e "ARTIFACT_ARCHIVE_SHA256=$ARCHIVE_SHA256" \
  -e "ARTIFACT_CREATED_AT=$CREATED_AT" \
  "$IMAGE_REF" \
  -e '
    const e = process.env;
    const artifact = {
      schemaVersion: e.ARTIFACT_SCHEMA,
      product: e.ARTIFACT_PRODUCT,
      version: e.ARTIFACT_VERSION,
      dockerTag: e.ARTIFACT_DOCKER_TAG,
      repository: e.ARTIFACT_REPOSITORY,
      imageReference: e.ARTIFACT_REFERENCE,
      imageId: e.ARTIFACT_IMAGE_ID,
      revision: e.ARTIFACT_REVISION,
      platform: {
        os: e.ARTIFACT_OS,
        architecture: e.ARTIFACT_ARCH,
        ...(e.ARTIFACT_VARIANT ? { variant: e.ARTIFACT_VARIANT } : {}),
      },
      archive: {
        file: e.ARTIFACT_ARCHIVE_NAME,
        sizeBytes: Number(e.ARTIFACT_ARCHIVE_SIZE),
        sha256: e.ARTIFACT_ARCHIVE_SHA256,
        format: "docker-save",
      },
      licenses: {
        catalog: "/app/licenses/catalog.json",
        coreReceipt: `/app/licenses/platform/bonni-core/${e.ARTIFACT_VERSION}/RECEIPT.json`,
      },
      coreOnly: true,
      containsPrivateKeys: false,
      createdAt: e.ARTIFACT_CREATED_AT,
    };
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  ' > "$ARTIFACT_TEMP"

[[ -s "$SHA_TEMP" ]] || die "SHA-256-Datei wurde nicht erzeugt."
[[ -s "$ARTIFACT_TEMP" ]] || die "artifact.json wurde nicht erzeugt."

# Alle temporaeren Dateien liegen im Zielverzeichnis. Die Umbenennungen bleiben
# daher auf demselben Dateisystem atomar; artifact.json wird als Abschlussmarker
# zuletzt sichtbar gemacht.
mv -- "$ARCHIVE_TEMP" "$ARCHIVE_PATH"
ARCHIVE_TEMP=""
mv -- "$SHA_TEMP" "$SHA_PATH"
SHA_TEMP=""
mv -- "$ARTIFACT_TEMP" "$ARTIFACT_PATH"
ARTIFACT_TEMP=""

printf '[bonni-core-oci] Fertig.\n'
printf '[bonni-core-oci] OCI-Archiv: %s\n' "$ARCHIVE_PATH"
printf '[bonni-core-oci] SHA-256: %s\n' "$SHA_PATH"
printf '[bonni-core-oci] Metadaten: %s\n' "$ARTIFACT_PATH"
printf '[bonni-core-oci] Image-ID: %s\n' "$IMAGE_ID"
