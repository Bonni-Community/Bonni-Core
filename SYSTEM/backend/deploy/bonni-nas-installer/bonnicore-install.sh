#!/usr/bin/env bash
# Geführte Neuinstallation aus einem offiziellen Bonni-Core-Container-ZIP.
set +x
set -euo pipefail
umask 077
export LC_ALL=C

fail() { printf '[Bonni] %s\n' "$*" >&2; exit 1; }
fail_with() {
  local code=$1; shift
  if [[ "${diagnose_only:-false}" == true ]]; then printf '%s\n' "$code" >&3; exit 1; fi
  wizard_failure=$code
  fail "$@"
}
say() { printf '[Bonni] %s\n' "$*"; }

install_unraid() {
  local zip=$1 members spec stem version registry local_image image_id identity running attempt contents
  local appdata=/mnt/user/appdata data template_dir=/boot/config/plugins/dockerMan/templates-user
  local template name=Bonni-Core webui='http://[IP]:[PORT:4000]/' mode=unraid-single-container
  local -a docker=(docker --host unix:///var/run/docker.sock)
  [[ -f /etc/unraid-version && $(uname -m) == x86_64 ]] || fail 'Dieser Installationsweg ist für Unraid auf AMD64 vorgesehen.'
  ((EUID == 0)) || fail 'Bitte das Unraid-Webterminal öffnen.'
  [[ -d "$appdata" && -d "$template_dir" ]] || fail 'Unraid benötigt einen erreichbaren appdata-Share und aktiviertes Docker.'
  timeout 15 "${docker[@]}" info >/dev/null 2>&1 || fail 'Der lokale Docker-Dienst ist nicht erreichbar.'
  data="$appdata/bonni-core-unraid"
  template="$template_dir/my-Bonni-Core.xml"
  exec 9>/var/lock/bonni-core-install.lock
  flock -n 9 || fail 'Eine Bonni-Installation läuft bereits.'
  if [[ -n "$zip" ]]; then
    [[ -f "$zip" ]] || fail 'Das Bonni-Core-ZIP wurde nicht gefunden.'
    members=${zip##*/}
    [[ "$members" =~ ^64-Bit-Bonni-Core-v([0-9]+\.[0-9]+\.[0-9]+([+-][a-z])?)-AMD64\.zip$ ]] || fail 'Bitte das unveränderte 64-Bit-Bonni-Core-Release-ZIP für AMD64 angeben.'
    members=${members%.zip}
    stem=${members#64-Bit-}
  else
    cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
    shopt -s nullglob
    local -a images=(Bonni-Core-v*-AMD64.tar)
    ((${#images[@]} == 1)) || fail 'Im entpackten Paket muss genau ein AMD64-Core-Image liegen.'
    stem=${images[0]%.tar}
  fi
  [[ "$stem" =~ ^Bonni-Core-v([0-9]+\.[0-9]+\.[0-9]+([+-][a-z])?)-AMD64$ ]] || fail 'Das Paket enthält keinen eindeutigen AMD64-Stand.'
  version=${BASH_REMATCH[1]}
  read_member() {
    if [[ -n "$zip" ]]; then unzip -p "$zip" "$members/$1"; else cat -- "$1"; fi
  }
  spec=$(read_member my-Bonni-Core.xml) || fail 'Die Unraid-Vorlage fehlt im Paket.'
  registry=$(sed -nE 's/^[[:space:]]*<Repository>([^<]+)<\/Repository>[[:space:]]*$/\1/p' <<<"$spec")
  [[ "$registry" =~ ^[a-z0-9][a-z0-9._:/-]*@sha256:([a-f0-9]{64})$ ]] || fail 'Die Unraid-Vorlage enthält keine eindeutige Image-Referenz.'
  local_image="bonni-core:${version//+/-}-amd64-${BASH_REMATCH[1]}"

  if identity=$("${docker[@]}" container inspect --format '{{index .Config.Labels "org.bonni.install.unraid"}}|{{.Config.Image}}' "$name" 2>/dev/null); then
    [[ "$identity" == "$mode|$local_image" ]] || fail 'Bonni-Core existiert bereits. Nutze für diese Installation die WebUI und den Update-Weg des bestehenden Containers.'
    running=$("${docker[@]}" container inspect --format '{{.State.Running}}' "$name")
    if [[ "$running" == false ]]; then "${docker[@]}" start "$name" >/dev/null; fi
  else
    [[ ! -L "$data" ]] || fail 'Der Bonni-Datenordner ist ein symbolischer Link.'
    if [[ -e "$data" ]]; then
      [[ -d "$data" && -r "$data" && -x "$data" ]] || fail 'Der Bonni-Datenordner ist nicht zugänglich.'
      contents=$(find "$data" -mindepth 1 -maxdepth 1 -print -quit) || fail 'Der Bonni-Datenordner ließ sich nicht prüfen.'
      [[ -z "$contents" ]] || fail 'Im Bonni-Datenordner befinden sich bereits Daten.'
    fi
    [[ ! -L "$template" && ( ! -e "$template" || -f "$template" ) ]] || fail 'Der Pfad der Unraid-Vorlage ist ungültig.'
    if [[ -f "$template" ]]; then
      grep -Eq '^[[:space:]]*<Name>Bonni-Core</Name>[[:space:]]*$' "$template" || fail 'Unter dem Namen liegt eine andere Unraid-Vorlage.'
    fi

    local expected archive
    expected=$(read_member "$stem.tar.sha256") || fail 'Die Prüfsumme des Core-Images fehlt.'
    local hash=${expected%% *}
    [[ "$hash" =~ ^[a-f0-9]{64}$ && "$expected" == "$hash  $stem.tar" ]] || fail 'Die Prüfsumme im Paket hat ein ungültiges Format.'
    if [[ -n "$zip" ]]; then
      unraid_install_temp=$(mktemp -d "$appdata/.bonni-install.XXXXXXXX")
      trap 'rm -rf -- "$unraid_install_temp"' EXIT
      archive="$unraid_install_temp/$stem.tar"
      say 'Entpacke das Bonni-Core-Image aus dem ZIP …'
      read_member "$stem.tar" >"$archive" || fail 'Das Core-Image konnte nicht entpackt werden.'
    else
      archive="$stem.tar"
    fi
    local actual
    actual=$(sha256sum -- "$archive") || fail 'Das Core-Image konnte nicht geprüft werden.'
    [[ "${actual%% *}" == "$hash" ]] || fail 'Die Prüfsumme des Core-Images stimmt nicht.'
    say 'Importiere das geprüfte Core-Image in Docker …'
    "${docker[@]}" image load --input "$archive" || fail 'Der Image-Import ist fehlgeschlagen.'
    identity=$("${docker[@]}" image inspect --format '{{.Os}}/{{.Architecture}}|{{index .Config.Labels "org.bonni.product"}}|{{.Id}}' "$local_image") || fail 'Das erwartete lokale Bonni-Core-Image fehlt.'
    image_id=${identity##*|}
    [[ "$identity" == "linux/amd64|bonni-core|$image_id" && "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Das Docker-Image passt nicht zum Unraid-Paket.'

    mkdir -p -- "$data"
    local rendered=${spec/"$registry"/"$local_image"} staged backup
    if [[ ! -f "$template" || $(<"$template") != "$rendered" ]]; then
      if [[ -f "$template" ]]; then
        backup=$(mktemp "$template_dir/my-Bonni-Core.xml.bak.XXXXXXXX")
        cp -- "$template" "$backup"
      fi
      staged=$(mktemp "$template_dir/.bonni-template.XXXXXXXX")
      printf '%s\n' "$rendered" >"$staged"
      mv -f -- "$staged" "$template"
    fi
    say 'Lege Bonni-Core in Docker an und starte den Container …'
    "${docker[@]}" run --detach --name "$name" --pull never --network bridge --publish 4000:4000/tcp \
      --env "BONNI_DEPLOYMENT_MODE=$mode" --env "TZ=${TZ:-Europe/Berlin}" \
      --label "org.bonni.install.unraid=$mode" --label net.unraid.docker.managed=dockerman \
      --label "net.unraid.docker.webui=$webui" \
      --mount "type=bind,source=$data,target=/bonni-data" \
      --init --restart unless-stopped --stop-timeout 75 --security-opt no-new-privileges \
      --health-cmd 'node /app/backend/scripts/deployment/unraid-runtime.mjs --health' --health-start-period 5m \
      "$local_image" >/dev/null || fail 'Docker konnte Bonni-Core nicht starten. Prüfe die Meldung direkt darüber.'
  fi

  for ((attempt=0; attempt<30; attempt++)); do
    if curl -fsS --max-time 1 http://127.0.0.1:4000/api/setup/status >/dev/null 2>&1 \
        || curl -fsS --max-time 1 http://127.0.0.1:4000/runtime-proxy/active-health >/dev/null 2>&1; then
      say 'Jetzt in Unraid: Docker → Bonni-Core → WebUI. Den Einrichtungscode findest du im Menü Protokolle.'
      return
    fi
    sleep 1
  done
  fail 'Bonni-Core wurde angelegt. Die WebUI antwortet noch nicht. Öffne Docker → Bonni-Core → Protokolle.'
}

if [[ "${1-}" == --unraid-zip ]]; then
  (($# == 2)) || fail 'Aufruf: bash bonnicore-install.sh --unraid-zip /pfad/zum/AMD64-Release.zip'
  install_unraid "$2"
  exit
fi
if { (($# == 0)) || [[ $# == 1 && $1 == --browser ]]; } \
    && [[ -f /etc/unraid-version && -f "$(dirname -- "${BASH_SOURCE[0]}")/my-Bonni-Core.xml" ]]; then
  install_unraid ''
  exit
fi

root=''
check=false
recover=false
erase=false
mode=browser
mode_explicit=false
core_imported=false
while (($#)); do
  case "$1" in
    --ordner) (($# >= 2)) && [[ -n "$2" ]] || fail 'Nach --ordner fehlt der Datenpfad.'; root=$2; shift 2 ;;
    --pruefen) check=true; shift ;;
    --wieder-starten|--reparatur) recover=true; shift ;;
    --browser|--terminal) [[ "$mode_explicit" == false ]] || fail 'Bitte nur --browser oder --terminal angeben.'; mode=${1#--}; mode_explicit=true; shift ;;
    -h|--help) printf '%s\n' 'bash bonnicore-install.sh [--ordner /absoluter/datenpfad] [--wieder-starten] [--pruefen | --browser | --terminal]' 'Im Browser zwischen Reparatur und Neuinstallation wählen. --wieder-starten öffnet nur die Reparatur. --terminal führt den jeweiligen Ablauf im Terminal aus.' '--wieder-starten --pruefen prüft eine vorhandene Installation ohne Start.'; exit 0 ;;
    *) fail "Unbekannte Option: $1" ;;
  esac
done
[[ "$check:$mode_explicit" != 'true:true' ]] || fail 'Bitte --pruefen und den Einrichtungsmodus getrennt aufrufen.'

case "$(uname -s)" in Linux) ;; *) fail 'Dieser Installer benötigt Linux und Docker Compose.' ;; esac
os='Linux (NAS-Software nicht erkannt)'
suggestion='/var/lib/bonni-core'
unraid_appdata='/mnt/user/appdata'
unraid_default="$unraid_appdata/bonni-core/bonni-daten"
if [[ -f /etc/unraid-version ]]; then os='Unraid'; suggestion=$unraid_default
elif [[ -f /etc/synoinfo.conf || -f /etc.defaults/synoinfo.conf ]]; then os='Synology DSM'; suggestion=''
elif [[ -f /etc/config/uLinux.conf ]]; then os='QNAP QTS / QuTS hero'; suggestion=''
elif [[ -f /etc/version ]] && grep -qi '^TrueNAS' /etc/version; then os='TrueNAS'; suggestion=''
fi
say "Erkannt: $os."
if [[ "$check" == false ]]; then
  [[ -t 0 ]] || fail 'Bitte ein interaktives NAS-Terminal öffnen.'
  if [[ "$mode" == browser ]]; then say 'Einrichtung im Browser (Standard).'; else say 'Einrichtung im Terminal.'; fi
fi

here=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd -- "$here"
shopt -s nullglob
templates=(Bonni-Core-v*-Offline.yml)
((${#templates[@]} == 1)) || fail 'Genau eine Offline-Compose-Datei muss neben bonnicore-install.sh liegen.'
template=${templates[0]}
pattern='^Bonni-Core-v[0-9]+\.[0-9]+\.[0-9]+([+-][a-z])?-(AMD64|ARM64|ARMv7)-Offline\.yml$'
[[ "$template" =~ $pattern ]] || fail 'Unbekannter Compose-Dateiname.'
architecture=${BASH_REMATCH[2]}
case "$(uname -m):$architecture" in
  x86_64:AMD64|aarch64:ARM64|arm64:ARM64|armv7l:ARMv7|armv8l:ARMv7) ;;
  *) fail "Das Paket $architecture passt nicht zur erkannten NAS-Architektur $(uname -m)." ;;
esac
if [[ "$os" == Unraid && "$architecture" != AMD64 ]]; then
  fail 'Für Unraid ist das AMD64-Paket vorgesehen.'
fi
stem=${template%-Offline.yml}
core_version=${stem#Bonni-Core-v}
core_version=${core_version%-"$architecture"}
core_tar="$stem.tar"
database_tar="$stem-Datenbank.tar"
for utility in sha256sum grep od tr df awk stat; do
  command -v "$utility" >/dev/null || fail "Benötigtes Programm fehlt: $utility."
done
docker_local=(docker --host unix:///var/run/docker.sock)
host_wizard=false
if [[ "$os:$mode:$check" == 'Unraid:browser:false' ]]; then host_wizard=true; fi
require_docker() {
  local -a command=("${docker_local[@]}")
  if [[ "$host_wizard" == true ]]; then command=(timeout 8 "${command[@]}"); fi
  command -v docker >/dev/null || fail_with docker-missing 'Der Docker-Befehl fehlt. Prüfe den Docker-Dienst auf dem NAS.'
  "${command[@]}" info >/dev/null 2>&1 || fail_with docker-off 'Der lokale Docker-Dienst läuft nicht oder ist für dieses Terminal nicht erreichbar.'
  "${command[@]}" compose version >/dev/null 2>&1 || fail_with compose-missing 'Docker Compose v2 fehlt. Bitte Docker/Container Manager zuerst bereitstellen.'
}
if [[ "$host_wizard" == false ]]; then require_docker; fi

check_docker_space() {
  local details docker_root driver_status free_kib tar size archive_kib=0 need_kib=524288 hint quiet=false
  if [[ "${1-}" == --quiet ]]; then quiet=true; shift; fi
  # DockerRootDir is the daemon's data path, not the location of the ZIP or the NAS share.
  # Do not guess a storage path if Docker reports a separate containerd image store.
  local -a command=("${docker_local[@]}")
  if [[ "$host_wizard" == true ]]; then command=(timeout 8 "${command[@]}"); fi
  details=$("${command[@]}" info --format '{{.DockerRootDir}}{{println}}{{json .DriverStatus}}' 2>/dev/null) \
    || fail_with disk-unreadable 'Docker-Speicher nicht prüfbar: Der lokale Docker-Dienst meldet seinen Datenpfad nicht.'
  docker_root=${details%%$'\n'*}
  driver_status=${details#*$'\n'}
  [[ "$details" == *$'\n'* && "$docker_root" == /* && "$docker_root" != / && "$docker_root" != *[[:cntrl:]]* && -d "$docker_root" \
    && ( "$driver_status" == null || "$driver_status" == \[*\] ) && "$driver_status" != *$'\n'* ]] \
    || fail_with disk-unreadable 'Docker-Speicher nicht prüfbar: Docker-Datenpfad oder Speichertreiber nicht eindeutig. Es wird nicht fortgefahren.'
  [[ "$driver_status" != *'io.containerd.snapshotter.v1'* ]] \
    || fail_with disk-unreadable 'Docker-Speicher nicht prüfbar: Das separate containerd-Image-Verzeichnis lässt sich nicht sicher ermitteln. Es wird nicht fortgefahren.'
  free_kib=$(df -Pk -- "$docker_root" 2>/dev/null | awk 'NR == 2 { print $4 } END { if (NR != 2) exit 1 }') \
    || fail_with disk-unreadable "Docker-Speicher nicht prüfbar: Freier Platz für $docker_root ist nicht lesbar."
  [[ "$free_kib" =~ ^[0-9]{1,16}$ ]] || fail_with disk-unreadable "Docker-Speicher nicht prüfbar: Ungültige Größenangabe für $docker_root."
  for tar in "$@"; do
    size=$(stat -c '%s' -- "$tar" 2>/dev/null) || fail "Größe des Image-Archivs nicht lesbar: $tar."
    [[ "$size" =~ ^[0-9]{1,15}$ ]] && (( 10#$size > 0 )) || fail "Ungültige Größe des Image-Archivs: $tar."
    archive_kib=$((archive_kib + (10#$size + 1023) / 1024))
  done
  if (($#)); then
    # Estimate load workspace from archive size: extra room for unpacking and Docker metadata.
    need_kib=$((2 * archive_kib + need_kib))
    if ((need_kib < 2097152)); then need_kib=2097152; fi
  fi
  free_kib=$((10#$free_kib))
  if ((free_kib < need_kib)); then
    hint='Bitte auf dem Docker-Speicher Platz schaffen und erneut starten.'
    if [[ "$os" == Unraid ]]; then hint='Auf Unraid unter Einstellungen > Docker Größe und Speicherort der Docker-vDisk prüfen.'; fi
    fail_with disk-space "Zu wenig Docker-Speicher ($docker_root): $((free_kib / 1024)) MiB frei, mindestens $(((need_kib + 1023) / 1024)) MiB empfohlen. Abbruch. $hint"
  fi
  if [[ "$quiet" == false ]]; then
    say "Docker-Speicher ($docker_root): $((free_kib / 1024)) MiB frei; Speicherprüfung bestanden."
  fi
}

verify_bundle() {
  local input check_file hash_line marker
  for input in "$template" "$core_tar" "$database_tar"; do
    check_file="$input.sha256"
    [[ -f "$input" && ! -L "$input" && -f "$check_file" && ! -L "$check_file" ]] || fail "Paketdatei oder Prüfsumme fehlt: $input."
    hash_line=$(sha256sum -- "$input") || fail "Prüfsumme nicht lesbar: $input."
    [[ "$(<"$check_file")" == "$hash_line" ]] || fail "Prüfsumme stimmt nicht: $input."
  done
  source_yaml=$(<"$template")
  for marker in 'x-bonni-root: &bonni_root /var/lib/bonni-core' \
    'BITTE_EIGENES_DATENBANKKENNWORT_EINTRAGEN' 'BITTE_EIGENEN_ZUFAELLIGEN_MASTER_KEY_EINTRAGEN' \
    'BITTE_EIGENES_ADMIN_KENNWORT_EINTRAGEN' 'BONNI_OFFLINE: "true"'; do
    [[ "$source_yaml" == *"$marker"* ]] || fail 'Die Compose-Vorlage passt nicht zu diesem Installer.'
  done
}

project_for_root() {
  local hash
  hash=$(printf '%s' "$root" | sha256sum)
  printf 'bonni-install-%s\n' "${hash:0:12}"
}

main_heading=$'\n  bonni-core:\n'
native_heading=$'\n  bonni-core:\n    container_name: Bonni-Core\n    labels:\n      net.unraid.docker.managed: dockerman\n      net.unraid.docker.icon: /state/plugins/dynamix.docker.manager/images/Bonni-Core-icon.png\n      net.unraid.docker.webui: "http://[IP]:[PORT:4000]/"\n      net.unraid.docker.shell: bash\n      folder.view3: "Bonni Core"\n'

read_image_ref() {
  local -a refs
  mapfile -t refs < <(grep -E "^      $1: [a-z0-9][a-z0-9._:/@-]{1,255}$" <<<"$source_yaml")
  ((${#refs[@]} == 1)) || fail 'Die Image-Referenz in der Compose-Vorlage ist nicht eindeutig.'
  printf '%s' "${refs[0]#*: }"
}

render_config() {
  local rendered
  rendered=${source_yaml/'x-bonni-root: &bonni_root /var/lib/bonni-core'/"x-bonni-root: &bonni_root $root"}
  rendered=${rendered/BITTE_EIGENES_DATENBANKKENNWORT_EINTRAGEN/"$1"}
  rendered=${rendered/BITTE_EIGENEN_ZUFAELLIGEN_MASTER_KEY_EINTRAGEN/"$2"}
  rendered=${rendered/BITTE_EIGENES_ADMIN_KENNWORT_EINTRAGEN/"$3"}
  if [[ "$4" == native ]]; then
    [[ "$rendered" == *"$main_heading"* ]] || fail 'Der Bonni-Hauptdienst fehlt in der Compose-Vorlage.'
    rendered=${rendered/"$main_heading"/"$native_heading"}
  fi
  printf '%s\n' "$rendered"
}

read_private_recovery_file() {
  local metadata perms owner size
  [[ -f "$1" && ! -L "$1" ]] || fail_with invalid-config "$2 fehlt oder ist keine direkte Datei."
  metadata=$(stat -c '%a %u %s' -- "$1") || fail_with invalid-config "$2 ist nicht lesbar."
  read -r perms owner size <<<"$metadata"
  [[ "$perms" =~ ^[0-7]{1,4}$ && "$owner" == "$(id -u)" && "$size" =~ ^[0-9]{1,8}$ ]] || fail_with invalid-config "$2 gehört nicht dem aktuellen Benutzer oder hat ungültige Dateidaten."
  (( (8#$perms & 077) == 0 && size > 0 && size <= 65536 )) || fail_with invalid-config "$2 hat unsichere Rechte oder eine unzulässige Größe."
  cat -- "$1"
}

read_exact_field() {
  local data=$1 regex=$2 line found='' count=0
  while IFS= read -r line; do
    if [[ "$line" =~ $regex ]]; then found=${BASH_REMATCH[1]}; count=$((count+1)); fi
  done <<<"$data"
  ((count == 1)) || fail_with invalid-config 'Vorhandene Installation passt nicht eindeutig zum Bonni-Format.'
  printf '%s' "$found"
}

prepare_recovery() {
  local intent=${1:-recover} path_cursor original normal native database_value master_value admin_value native_expected
  local stored_state schema phase stored_root runtime_project environment owner
  [[ "$root" =~ ^(/[a-zA-Z0-9._-]+){2,}$ && "$root/" != *'/./'* && "$root/" != *'/../'* && "$root" != "$here" ]] || fail_with data-path 'Bitte den bisherigen absoluten Bonni-Datenpfad mit --ordner angeben.'
  case "$root" in /bin/*|/boot/*|/dev/*|/etc/*|/proc/*|/sys/*|/usr/*|/var/lib/docker|/var/lib/docker/*) fail 'Der Datenpfad liegt in einem Systemordner.';; esac
  [[ -d "$root" && -r "$root" && -x "$root" ]] || fail_with data-path 'Der ursprüngliche Bonni-Datenordner fehlt oder ist nicht lesbar.'
  path_cursor=$root
  while [[ -n "$path_cursor" ]]; do
    [[ ! -L "$path_cursor" ]] || fail_with data-path 'Der ursprüngliche Bonni-Datenpfad darf keine Symlinks enthalten.'
    path_cursor=${path_cursor%/*}
  done
  recovery_config="$root.bonni-compose.yml"
  original=$(read_private_recovery_file "$recovery_config" 'Die vorhandene Bonni-Startkonfiguration') || exit 1
  database_value=$(read_exact_field "$original" '^      POSTGRES_PASSWORD: "([0-9a-f]{64})"$') || exit 1
  master_value=$(read_exact_field "$original" '^      MASTER_KEY: "([0-9a-f]{64})"$') || exit 1
  admin_value=$(read_exact_field "$original" '^      BONNI_BOOTSTRAP_ADMIN_PASSWORD: "([a-zA-Z0-9._@%+!:=-]{8,512})"$') || exit 1
  recovery_layout=normal
  normal=$(render_config "$database_value" "$master_value" "$admin_value" normal) || exit 1
  if [[ "$original" != "$normal" ]]; then
    [[ "$os" == Unraid ]] || fail_with wrong-package 'Die vorhandene Konfiguration passt nicht zu diesem NAS-Paket. Das ursprüngliche Offline-ZIP verwenden.'
    native=$(render_config "$database_value" "$master_value" "$admin_value" native) || exit 1
    [[ "$original" == "$native" ]] || fail_with wrong-package 'Die vorhandene Konfiguration passt nicht zu diesem NAS-Paket. Das ursprüngliche Offline-ZIP verwenden.'
    recovery_layout=native
    # Validate any already registered native template's private start inputs,
    # without rewriting them or consuming a credential from the boot device.
    if [[ -e "$root.bonni-unraid.env" || -L "$root.bonni-unraid.env" ]]; then
      environment=$(read_private_recovery_file "$root.bonni-unraid.env" 'Die Unraid-Startwerte') || exit 1
      native_expected=$(printf '%s\n' "BONNI_HOST_PROJECT_ROOT=$root" "BONNI_INITIAL_IMAGE=$(read_image_ref BONNI_INITIAL_IMAGE)" "BONNI_DATABASE_IMAGE=$(read_image_ref BONNI_DATABASE_IMAGE)" 'BONNI_PLATFORM=linux/amd64' 'BONNI_OFFLINE=true' 'BONNI_HTTP_PORT=4000' "POSTGRES_PASSWORD=$database_value" "MASTER_KEY=$master_value" "BONNI_BOOTSTRAP_ADMIN_PASSWORD=$admin_value")
      [[ "$environment" == "$native_expected" ]] || fail 'Die Unraid-Startwerte passen nicht zur gespeicherten Installation.'
    fi
  fi
  recovery_project=$(project_for_root)
  recovery_compose=("${docker_local[@]}" compose --project-directory "$root" --project-name "$recovery_project" -f "$recovery_config")
  recovery_core_ref=$(read_image_ref BONNI_INITIAL_IMAGE) || exit 1
  recovery_db_ref=$(read_image_ref BONNI_DATABASE_IMAGE) || exit 1
  recovery_core_id=''; recovery_db_id=''; recovery_runtime_project=''
  local state_file="$root/.bonni-deployment.json"
  if [[ -e "$state_file" || -L "$state_file" ]]; then
    stored_state=$(read_private_recovery_file "$state_file" 'Der Bonni-Installationsbeleg') || exit 1
    schema=$(read_exact_field "$stored_state" '^  "schema": "(bonni\.container-deployment/v1)",?$') || exit 1
    phase=$(read_exact_field "$stored_state" '^  "phase": "(ready)",?$') || exit 1
    stored_root=$(read_exact_field "$stored_state" '^  "root": "([a-zA-Z0-9/._-]+)",?$') || exit 1
    runtime_project=$(read_exact_field "$stored_state" '^  "project": "(bonni-[0-9a-f]{12})",?$') || exit 1
    recovery_runtime_project=$runtime_project
    recovery_core_id=$(read_exact_field "$stored_state" '^  "initialImage": "(sha256:[0-9a-f]{64})",?$') || exit 1
    recovery_db_id=$(read_exact_field "$stored_state" '^  "databaseImage": "(sha256:[0-9a-f]{64})",?$') || exit 1
    [[ "$schema" == bonni.container-deployment/v1 && "$phase" == ready && "$stored_root" == "$root" ]] || fail 'Der Installationsbeleg gehört nicht zu diesem Datenordner.'
    environment=$(read_private_recovery_file "$root/SYSTEM/backend/.env" 'Die gespeicherte Laufzeitkonfiguration') || exit 1
    [[ "$(read_exact_field "$environment" "^COMPOSE_PROJECT_NAME='(bonni-[0-9a-f]{12})'$" )" == "$runtime_project" ]] || fail 'Der gespeicherte Projektname stimmt nicht mit dem Installationsbeleg überein.'
    if [[ "$intent" == recover ]]; then
      owner=$("${docker_local[@]}" volume inspect --format '{{index .Labels "com.docker.compose.project"}}/{{index .Labels "org.bonni.runtime.data"}}' "${runtime_project}_postgres_data" 2>/dev/null) || fail_with database 'Das ursprüngliche PostgreSQL-Volume fehlt oder ist nicht lesbar. Es wird keine neue Datenbank angelegt.'
      [[ "$owner" == "$runtime_project/production-database" ]] || fail_with database 'Das PostgreSQL-Volume konnte Bonnis Installation nicht eindeutig zugeordnet werden.'
    fi
  else
    local -a old_files
    shopt -s dotglob
    old_files=("$root"/*)
    shopt -u dotglob
    ((${#old_files[@]} == 0)) || fail_with invalid-config 'Der Datenordner ist belegt, aber der Installationsbeleg fehlt. Bonni startet nicht automatisch.'
  fi
  "${recovery_compose[@]}" config -q >/dev/null 2>&1 || fail_with invalid-config 'Docker Compose kann die gespeicherte Konfiguration nicht prüfen.'
}

check_recovery_images() {
  local ref tar expected image i
  local -a image_refs=("$recovery_core_ref" "$recovery_db_ref")
  local -a image_tars=("$core_tar" "$database_tar")
  local -a pinned=("$recovery_core_id" "$recovery_db_id")
  recovery_missing=()
  for i in 0 1; do
    ref=${image_refs[i]}; tar=${image_tars[i]}; expected=${pinned[i]}
    if ! image=$("${docker_local[@]}" image inspect --format '{{.Id}}' "$ref" 2>/dev/null); then
      recovery_missing+=("$tar")
    elif [[ ! "$image" =~ ^sha256:[a-f0-9]{64}$ || ( -n "$expected" && "$expected" != "$image" ) ]]; then
      fail_with wrong-package 'Das lokale Image passt nicht zum gespeicherten Installationsstand. Kein Start.'
    fi
  done
  if ((${#recovery_missing[@]})); then check_docker_space "${recovery_missing[@]}"; fi
}

start_recovery() {
  # Recheck after approval. Never guess a project name from container names,
  # pull an image, create a replacement database or start a new installation.
  prepare_recovery
  check_recovery_images
  local ref tar expected image i
  local -a image_refs=("$recovery_core_ref" "$recovery_db_ref")
  local -a image_tars=("$core_tar" "$database_tar")
  local -a pinned=("$recovery_core_id" "$recovery_db_id")
  for i in 0 1; do
    ref=${image_refs[i]}; tar=${image_tars[i]}; expected=${pinned[i]}
    if ! image=$("${docker_local[@]}" image inspect --format '{{.Id}}' "$ref" 2>/dev/null); then
      check_docker_space --quiet "$tar"
      say "Importiere das fehlende, geprüfte Image: $tar"
      "${docker_local[@]}" image load -i "$tar" || fail 'Das fehlende Image konnte nicht importiert werden.'
      image=$("${docker_local[@]}" image inspect --format '{{.Id}}' "$ref" 2>/dev/null) || fail 'Das erwartete Image fehlt nach dem Import.'
    fi
    [[ "$image" =~ ^sha256:[a-f0-9]{64}$ && ( -z "$expected" || "$expected" == "$image" ) ]] || fail 'Das lokale Image passt nicht zum gespeicherten Installationsstand. Kein Start.'
  done
  "${recovery_compose[@]}" up -d --pull never --no-build --no-recreate --wait --wait-timeout 300 bonni-core || fail_with start-failed 'Bonni hat den Wiederanlauf nicht abgeschlossen. Die Startkonfiguration wurde nicht ersetzt.'
  if [[ "$mode" == browser ]]; then wait_for_webui "${recovery_compose[@]}"; fi
  say 'Bonni Core ist wieder bereit. WebUI: http://<NAS-IP>:4000'
}

verify_erase_target() {
  # Explicitly authorized clean-install replacement only. No generic folder
  # cleanup, Docker prune, or deletion of volumes, templates or mounts.
  local containers projects project_id mount_points mount_path
  [[ "$root" != "$unraid_appdata" && ! "$root" =~ ^/mnt/[^/]+/[^/]+$ && "$root" != /var/lib/bonni-core ]] \
    || fail 'Dieser gemeinsame oder allgemeine Pfad ist nicht zum Löschen freigegeben.'
  prepare_recovery erase
  projects=("$recovery_project")
  if [[ -n "$recovery_runtime_project" ]]; then projects+=("$recovery_runtime_project"); fi
  for project_id in "${projects[@]}"; do
    containers=$("${docker_local[@]}" ps --all --quiet --filter "label=com.docker.compose.project=$project_id" 2>/dev/null) || fail 'Container-Status nicht sicher prüfbar.'
    [[ -z "$containers" ]] || fail_with folder-in-use 'Zum Leeren müssen die Container dieser Bonni-Installation vorher entfernt sein.'
  done
  containers=$("${docker_local[@]}" ps --all --quiet --filter "volume=$root" 2>/dev/null) || fail 'Der Mount-Status ist nicht sicher prüfbar.'
  [[ -z "$containers" ]] || fail_with folder-in-use 'Der Datenordner wird noch von einem Container verwendet.'
  mount_points=$(findmnt -nr -o TARGET) || fail 'Mounts im Bonni-Datenordner sind nicht sicher prüfbar.'
  while IFS= read -r mount_path; do
    [[ "$mount_path" != "$root" && "$mount_path" != "$root/"* ]] || fail_with folder-mounted 'Ein Mount liegt im Bonni-Datenpfad. Kein Löschen.'
  done <<<"$mount_points"
}

wizard_result=failed
wizard_failure=unknown
browser_phase=''
wizard_tmp=''
wizard_pid=''
wizard_accepted=false
cleanup_host_wizard() {
  if [[ "$wizard_tmp" == /tmp/bonni-setup.* && -d "$wizard_tmp" ]]; then
    rm -f -- "$wizard_tmp/node" "$wizard_tmp/bonnicore-setup.mjs" "$wizard_tmp/bonnicore-setup.html"
    rmdir -- "$wizard_tmp"
  fi
}
publish_phase() {
  if [[ "$browser_phase" != "$1" ]]; then
    browser_phase=$1
    { printf '%s\n' "$1" >&"$wizard_in"; } 2>/dev/null || :
  fi
}
finish_browser() {
  local status=$?
  if [[ -n "$wizard_pid" ]]; then
    if [[ "$wizard_accepted" == true ]]; then
      if [[ $status != 0 || "$wizard_result" != ready ]]; then publish_phase "failed:$wizard_failure"
      else publish_phase ready; fi
    else
      kill "$wizard_pid" 2>/dev/null || :
    fi
    wait "$wizard_pid" 2>/dev/null || :
  fi
  cleanup_host_wizard
}

# No Docker access: write only a verified binary and public UI files to tmpfs.
prepare_host_wizard() {
  local index=bonni-unraid-runtime.txt digest
  local -a items extraction=(tar -xOf -)
  command -v tar >/dev/null || fail 'Für den Unraid-Assistenten fehlt tar.'
  [[ -f "$index" && ! -L "$index" && "$(stat -c '%s' -- "$index")" -le 256 ]] || fail 'Unraid-Laufzeitindex fehlt. Das neue AMD64-ZIP bitte vollständig entpacken.'
  mapfile -t items < "$index"
  ((${#items[@]}==4)) && [[ "${items[0]}" =~ ^(blobs/sha256/[0-9a-f]{64}|[0-9a-f]{64}/layer\.tar)$ \
    && "${items[1]}" =~ ^(\./)?usr/local/bin/node$ && "${items[2]}" =~ ^(tar|gzip)$ && "${items[3]}" =~ ^[0-9a-f]{64}$ ]] \
    || fail 'Der Unraid-Laufzeitindex im ZIP ist ungültig.'
  if [[ "${items[2]}" == gzip ]]; then extraction=(tar -xOzf -); fi
  wizard_tmp=$(mktemp -d /tmp/bonni-setup.XXXXXXXX)
  # Only stdout extraction: no archive paths, rights or symlinks enter tmpfs.
  tar -xOf "$core_tar" -- "${items[0]}" | "${extraction[@]}" -- "${items[1]}" > "$wizard_tmp/node" \
    || fail 'Die Browser-Laufzeit konnte nicht aus dem Bonni-Archiv gelesen werden.'
  digest=$(sha256sum -- "$wizard_tmp/node") || fail 'Die Browser-Laufzeit ist nicht lesbar.'
  [[ "${digest%% *}" == "${items[3]}" ]] || fail 'Die Prüfsumme der Unraid-Browser-Laufzeit stimmt nicht.'
  install -m 0444 -- bonnicore-setup.mjs bonnicore-setup.html "$wizard_tmp/"
  chmod 0555 -- "$wizard_tmp/node"
  chmod 0711 -- "$wizard_tmp"
  wizard_command=(env -i PATH=/usr/bin:/bin "$wizard_tmp/node" "$wizard_tmp/bonnicore-setup.mjs")
  if ((EUID==0)); then
    command -v setpriv >/dev/null || fail 'Für den unprivilegierten Browser-Start fehlt setpriv.'
    wizard_command=(setpriv --reuid 65534 --regid 65534 --clear-groups --no-new-privs "${wizard_command[@]}")
  fi
}

# Regrouped Unraid entries and ordinary NAS Compose use the same controller.
# Probe that exact service first, then check the real proxy and HTML locally.
wait_for_webui() {
  local controller state deadline=$((SECONDS+600)) probe
  controller=$(timeout 8 "$@" ps --all --quiet bonni-core 2>/dev/null) \
    || fail_with start-failed 'Der Bonni-Hauptcontainer konnte nicht geprüft werden.'
  [[ "$controller" =~ ^[a-f0-9]{12,64}$ ]] || fail_with start-failed 'Docker meldet keinen eindeutigen Bonni-Hauptcontainer.'
  probe='const base = "http://127.0.0.1:4000";
    const request = path => fetch(base + path, {redirect:"error", signal:AbortSignal.timeout(2000)});
    try {
      const response = await request("/runtime-proxy/active-health");
      if (response.status !== 200) process.exit(1);
      const ready = await response.json();
      if (ready.ok !== true || ready.state !== "ready" || ready.database?.ready !== true) process.exit(1);
      const page = await request("/");
      const html = page.status === 200 && /^text\/html(?:;|$)/i.test(page.headers.get("content-type") || "");
      await page.body?.cancel();
      process.exit(html ? 0 : 1);
    } catch { process.exit(1); }'
  publish_phase services
  while ((SECONDS < deadline)); do
    state=$(timeout 8 "${docker_local[@]}" container inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$controller" 2>/dev/null) \
      || fail_with start-failed 'Der Status des Bonni-Hauptcontainers ist nicht lesbar.'
    case "$state" in
      'running healthy')
        publish_phase webui
        if timeout 8 "${docker_local[@]}" exec "$controller" /usr/local/bin/node --input-type=module -e "$probe" >/dev/null 2>&1; then return 0; fi ;;
      'exited '*|'dead '*) fail_with start-failed 'Der Bonni-Hauptcontainer wurde beendet, bevor die Weboberfläche bereit war.' ;;
      *) publish_phase services ;;
    esac
    sleep 2
  done
  fail_with start-timeout 'Die Bonni-Weboberfläche ist nach 10 Minuten noch nicht bereit. Die Installation wurde nicht wiederholt oder rückgängig gemacht.'
}

# Return only one fixed diagnostic code on FD 3; never forward config, NAS
# paths, credentials, Docker output or unfiltered stderr to the browser.
setup_diagnostic() (
  diagnose_only=true
  root=$proposed_root
  if [[ "$1" == repair ]]; then
    prepare_recovery
    check_recovery_images
  else
    verify_erase_target
  fi
)

build_menu() {
  can_repair=no; delete_offer=''; repair_issue='not-installed'; delete_issue=''
  if [[ -n "$proposed_root" && ( -e "$proposed_root.bonni-compose.yml" || -L "$proposed_root.bonni-compose.yml" ) ]]; then
    if repair_issue=$(setup_diagnostic repair 3>&1 >/dev/null 2>&1); then can_repair=yes; repair_issue=''
    else repair_issue=${repair_issue:-unknown}; fi
    if [[ "$recover" == false ]]; then
      if delete_issue=$(setup_diagnostic erase 3>&1 >/dev/null 2>&1); then delete_offer=$proposed_root; delete_issue=''
      else delete_issue=${delete_issue:-unknown}; fi
    fi
  fi
}

host_preflight() (
  diagnose_only=true
  require_docker
  if [[ "$recover" == true ]]; then check_docker_space --quiet
  else check_docker_space --quiet "$core_tar" "$database_tar"; fi
)

update_host_wizard() {
  local block
  if block=$(host_preflight 3>&1 >/dev/null 2>&1); then
    build_menu
    printf 'preflight\tready\t%s\t%s\t%s\t%s\n' "$can_repair" "$delete_offer" "$repair_issue" "$delete_issue" >&"$wizard_in"
  else
    can_repair=no; delete_offer=''
    printf 'preflight\t%s\n' "${block:-unknown}" >&"$wizard_in"
  fi
}

if [[ "$recover" == true && ( "$check" == true || "$mode" == terminal ) ]]; then
  root=${root:-$suggestion}
  verify_bundle
  prepare_recovery
  check_recovery_images
  say 'Vorhandene Bonni-Konfiguration und Daten geprüft. Es wurde nichts geändert.'
  if [[ "$check" == true ]]; then exit 0; fi
  read -r -p 'Vorhandene Bonni-Installation unverändert wieder starten? [j/N] ' confirm
  [[ "$confirm" == j || "$confirm" == J ]] || { say 'Abgebrochen. Bonni wurde nicht gestartet.'; exit 0; }
  start_recovery
  exit 0
fi

if [[ "$check" == false && "$mode" == browser ]]; then
  command -v timeout >/dev/null || fail 'Für die Browser-Einrichtung fehlt das Programm timeout.'
  [[ "$here" != *','* && "$here" != *'"'* && "$here" != *$'\n'* && "$here" != *$'\r'* ]] || fail 'Das Paket für den Browser-Assistenten in einen einfachen Ordner entpacken.'
  for ui_file in bonnicore-setup.html bonnicore-setup.mjs; do
    [[ -f "$ui_file" && ! -L "$ui_file" ]] || fail 'Der Browser-Assistent fehlt im Paket.'
  done
  verify_bundle
  proposed_root=${root:-$suggestion}
  menu_action=menu
  if [[ "$recover" == true ]]; then menu_action=repair; fi
  trap finish_browser EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [[ "$host_wizard" == true ]]; then
    can_repair=no; delete_offer=''; repair_issue=''; delete_issue=''
    prepare_host_wizard
    say 'Der Unraid-Assistent startet ohne Docker und ohne Image-Import.'
  else
  build_menu
  mapfile -t image_lines < <(grep -E '^      BONNI_INITIAL_IMAGE: [a-z0-9][a-z0-9._:/@-]{1,255}$' <<<"$source_yaml")
  ((${#image_lines[@]} == 1)) || fail 'Das Core-Image für den Assistenten ist nicht eindeutig.'
  wizard_ref=${image_lines[0]#*BONNI_INITIAL_IMAGE: }
  wizard_image=''
  if [[ "$recover" == true && "$can_repair" == yes ]]; then
    root=$proposed_root
    prepare_recovery
    check_recovery_images
    # Only reuse an already loaded image for the wizard if the installation receipt pins its ID.
    if [[ -n "$recovery_core_id" ]] && cached_image=$("${docker_local[@]}" image inspect --format '{{.Id}}' "$wizard_ref" 2>/dev/null) \
      && [[ "$cached_image" == "$recovery_core_id" ]]; then
      wizard_image=$cached_image
    else
      check_docker_space "$core_tar"
    fi
  elif [[ "$recover" == false ]]; then
    check_docker_space "$core_tar" "$database_tar"
  else
    check_docker_space "$core_tar"
  fi
  if [[ -z "$wizard_image" ]]; then
    say 'Das Offline-Paket ist geprüft. Lade das Core-Image für den temporären Assistenten …'
    "${docker_local[@]}" image load -i "$core_tar" || fail 'Das Core-Image konnte nicht importiert werden. Docker-Speicher und Paket prüfen.'
    wizard_image=$("${docker_local[@]}" image inspect --format '{{.Id}}' "$wizard_ref") || fail 'Das erwartete Core-Image fehlt nach dem Import.'
  fi
  core_imported=true
  [[ "$wizard_image" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Das Core-Image konnte nicht eindeutig gebunden werden.'
  check_docker_space --quiet
  wizard_command=("${docker_local[@]}" run --rm -i --pull never --network host --log-driver none --read-only
    --cap-drop ALL --security-opt no-new-privileges --user 65534:65534
    --mount "type=bind,source=$here/bonnicore-setup.html,target=/wizard/bonnicore-setup.html,readonly"
    --mount "type=bind,source=$here/bonnicore-setup.mjs,target=/wizard/bonnicore-setup.mjs,readonly"
    --entrypoint /usr/local/bin/node "$wizard_image" /wizard/bonnicore-setup.mjs)
  fi
  say 'Am eigenen Rechner per SSH weiterleiten (NAS-Benutzer und NAS-IP einsetzen):'
  say 'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:4180:127.0.0.1:4180 -L 127.0.0.1:4181:127.0.0.1:4000 <NAS-Benutzer>@<NAS-IP>'
  say 'Danach den unten angezeigten Einrichtungslink im Browser öffnen. Der Link läuft nach 10 Minuten ab.'
  coproc BONNI_WIZARD { exec "${wizard_command[@]}" "$os" "$architecture" "$proposed_root" "$core_version" "$menu_action" "$can_repair" "$delete_offer" "$repair_issue" "$delete_issue" "$host_wizard"; }
  wizard_pid=$BONNI_WIZARD_PID; wizard_in=${BONNI_WIZARD[1]}; wizard_out=${BONNI_WIZARD[0]}
  if [[ "$host_wizard" == true ]]; then update_host_wizard; fi
  while :; do
    IFS= read -r -t 620 choice <&"$wizard_out" || fail 'Keine Eingaben übernommen. Für die Terminal-Einrichtung den Befehl mit --terminal starten.'
    if [[ "$host_wizard" == true && "$choice" == PRUEFEN ]]; then update_host_wizard; else break; fi
  done
  wizard_accepted=true
  if [[ "$choice" == WIEDER-STARTEN && "$can_repair" == yes ]]; then
    root=$proposed_root; unset choice
    publish_phase services
    require_docker
    start_recovery
    wizard_result=ready
    exit 0
  fi
  [[ "$menu_action" == menu && "$choice" == *$'\t'*$'\t'* && "$choice" != *$'\r'* ]] || fail 'Die Antwort des Assistenten war unvollständig.'
  IFS=$'\t' read -r root admin decision surplus <<<"$choice"
  [[ -n "$root" && -n "$admin" && -z "$surplus" ]] || fail 'Die Antwort des Assistenten war unvollständig.'
  case "$decision" in
    neu) [[ -z "$delete_offer" || "$root" != "$delete_offer" ]] || fail 'Löschen wurde nicht bestätigt.';;
    loeschen) [[ -n "$delete_offer" && "$root" == "$delete_offer" ]] || fail 'Der Zielordner ist nicht zum Löschen freigegeben.'; erase=true;;
    *) fail 'Die Antwort des Assistenten war unvollständig.';;
  esac
  confirm=$admin
  unset choice
  require_docker
fi

if [[ -z "$root" ]]; then
  if [[ -t 0 && "$check" == false ]]; then
    prompt='Bitte Speicherort angeben (absoluter Pfad auf dem NAS): '
    if [[ -n "$suggestion" ]]; then
      say "Vorgeschlagener Speicherort: $suggestion"
      prompt='Bitte Speicherort angeben (Enter übernimmt den Vorschlag): '
    fi
    read -r -p "$prompt" root || fail 'Eingabe abgebrochen.'
  fi
  root=${root:-$suggestion}
fi
[[ "$root" =~ ^(/[a-zA-Z0-9._-]+){2,}$ && "$root/" != *'/./'* && "$root/" != *'/../'* && "$root" != "$here" ]] || fail 'Bitte einen absoluten Datenordner ohne Leerzeichen angeben (gegebenenfalls mit --ordner).'
case "$root" in /bin/*|/boot/*|/dev/*|/etc/*|/proc/*|/sys/*|/usr/*|/var/lib/docker|/var/lib/docker/*)
  fail 'Dieser System- oder Docker-Pfad ist nicht als Bonni-Datenordner erlaubt.' ;;
esac
if [[ "$os" == Unraid && "$root" == /mnt/user/* && ! -d "$unraid_appdata" ]]; then fail 'Der Unraid-Share appdata ist nicht erreichbar.'; fi
target_parent=${root%/*}
create_unraid_parent=false
if [[ "$os" == Unraid && "$root" == "$unraid_default" && ! -d "$target_parent" ]]; then
  [[ -d "$unraid_appdata" ]] || fail 'Der Unraid-Share appdata ist nicht erreichbar.'
  create_unraid_parent=true
fi
parent=$root
while [[ -n "$parent" ]]; do
  [[ ! -L "$parent" ]] || fail 'Der Datenpfad darf keine Symlinks enthalten. Bitte den echten Speicherpfad angeben.'
  [[ ! -e "$parent" || -d "$parent" ]] || fail 'Der Datenpfad enthält eine Datei.'
  parent=${parent%/*}
done
[[ -d "$target_parent" || "$create_unraid_parent" == true ]] || fail 'Bitte zuerst den übergeordneten Ordner auf dem richtigen NAS-Speicher anlegen.'
config="$root.bonni-compose.yml"
unraid_env="$root.bonni-unraid.env"
unraid_template='/boot/config/plugins/dockerMan/templates-user/my-Bonni-Core.xml'
unraid_icon_disk='/var/lib/docker/unraid/images/Bonni-Core-icon.png'
unraid_icon_ram='/usr/local/emhttp/state/plugins/dynamix.docker.manager/images/Bonni-Core-icon.png'
unraid_icon='/state/plugins/dynamix.docker.manager/images/Bonni-Core-icon.png'
render_unraid_template() {
  local core_ref=$1
  cat <<XML
<?xml version="1.0"?>
<Container version="2">
  <Name>Bonni-Core</Name>
  <Repository>$core_ref</Repository>
  <Network>host</Network>
  <Shell>bash</Shell>
  <Privileged>false</Privileged>
  <Overview>Bonni Core. Datenpfad und Startkonfiguration gehören zusammen; bei einer laufenden Installation nicht unabhängig ändern.</Overview>
  <Category>Productivity:</Category>
  <Icon>$unraid_icon</Icon>
  <WebUI>http://[IP]:[PORT:4000]/</WebUI>
  <ExtraParams>--init --pid=host --restart=unless-stopped --stop-timeout=600 --security-opt=no-new-privileges --env-file=$unraid_env --label 'folder.view3=Bonni Core' --health-cmd='node /app/backend/scripts/deployment/controller.mjs --health' --health-interval=10s --health-timeout=10s --health-retries=60 --health-start-period=90s</ExtraParams>
  <PostArgs>/bin/bash /app/backend/scripts/deployment/entrypoint.sh</PostArgs>
  <Config Name="Bonni-Daten" Target="$root" Default="$root" Mode="rw" Description="Bestehendes Datenverzeichnis. Nicht ohne eine unterstützte Datenübernahme ändern." Type="Path" Display="always" Required="true" Mask="false">$root</Config>
  <Config Name="Docker-Socket für den Bonni-Controller" Target="/var/run/docker.sock" Default="/var/run/docker.sock" Mode="rw" Type="Path" Display="advanced" Required="true" Mask="false">/var/run/docker.sock</Config>
  <Config Name="NAS-Zeitzone" Target="/etc/localtime" Default="/etc/localtime" Mode="ro" Type="Path" Display="advanced" Required="true" Mask="false">/etc/localtime</Config>
</Container>
XML
}
same_unraid_template() {
  [[ -f "$unraid_template" && ! -L "$unraid_template" ]] && cmp -s -- "$unraid_template" <(render_unraid_template "$1")
}
verify_bundle
if [[ -e "$config" || -L "$config" ]]; then
  if [[ "$check" == false && "$mode" == terminal ]]; then
    verify_erase_target
    erase=true
  elif [[ "$erase" == false ]]; then
    fail_with existing-config "Es gibt bereits eine Installationskonfiguration: $config. Für Reparatur --wieder-starten verwenden."
  fi
fi
if [[ "$erase" == true ]]; then verify_erase_target; fi
reuse_unraid_template=false
if [[ "$os" == Unraid ]]; then
  if [[ -e "$unraid_env" || -L "$unraid_env" ]]; then
    [[ "$erase" == true && "$recovery_layout" == native ]] || fail 'Eine andere Bonni-Unraid-Konfiguration ist bereits vorhanden.'
  fi
  if [[ -e "$unraid_template" || -L "$unraid_template" ]]; then
    template_ref=$(read_image_ref BONNI_INITIAL_IMAGE)
    same_unraid_template "$template_ref" || fail 'Eine abweichende Unraid-Vorlage ist bereits vorhanden (my-Bonni-Core.xml). Sie wird nicht überschrieben.'
    reuse_unraid_template=true
  fi
  if "${docker_local[@]}" container inspect Bonni-Core >/dev/null 2>&1; then fail_with folder-in-use 'Ein Container Bonni-Core existiert bereits. Er wird nicht ersetzt.'; fi
  [[ -f bonni-unraid.png && ! -L bonni-unraid.png ]] || fail 'Das Bonni-Logo für Unraid fehlt im Paket. Bitte vollständig entpacken.'
fi
require_empty_root() {
  local -a entries
  if [[ -d "$root" ]]; then
    [[ -r "$root" && -x "$root" && ! -L "$root" ]] || fail 'Der Datenordner konnte nicht sicher geprüft werden.'
    shopt -s dotglob
    entries=("$root"/*)
    shopt -u dotglob
    ((${#entries[@]} == 0)) || fail_with folder-not-empty 'Der Datenordner ist bereits belegt. Vorhandene Installationen werden nicht verändert.'
  fi
}
if [[ "$erase" == false ]]; then require_empty_root; fi

say "Paket und Prüfsummen in Ordnung: $architecture. Ziel: $root."
if [[ "$create_unraid_parent" == true ]]; then say "Wird bei der Installation neu angelegt: $target_parent."; fi
if [[ "$core_imported" == false ]]; then check_docker_space "$core_tar" "$database_tar"; fi
if [[ "$check" == true ]]; then exit 0; fi

port=4000
if command -v ss >/dev/null; then
  listeners=$(ss -H -ltn) || fail 'Offene TCP-Ports konnten nicht geprüft werden.'
  if grep -Eq '[[:space:]][^[:space:]]*:(4000|4001|4199)[[:space:]]' <<<"$listeners"; then
    fail_with port-used 'Port 4000, 4001 oder 4199 ist belegt. Bestehende Dienste werden nicht automatisch gestoppt.'
  fi
fi
[[ -t 0 ]] || fail 'Für die Erstinstallation bitte ein interaktives NAS-Terminal öffnen.'
if [[ "$mode" == terminal ]]; then
  read -rs -p 'Neues Bonni-Admin-Passwort (mindestens 8 Zeichen): ' admin; printf '\n'
  read -rs -p 'Admin-Passwort wiederholen: ' confirm; printf '\n'
fi
allowed='^[a-zA-Z0-9._@%+!:=-]+$'
[[ "$admin" == "$confirm" ]] || fail 'Die beiden Passwörter stimmen nicht überein.'
[[ ${#admin} -ge 8 && ${#admin} -le 512 ]] || fail 'Das Admin-Passwort muss 8 bis 512 Zeichen lang sein.'
[[ "$admin" =~ $allowed && "$admin" =~ [A-Z] && "$admin" =~ [a-z] && "$admin" =~ [0-9] && "$admin" =~ [-._@%+!:=] ]] || fail 'Verwende Groß- und Kleinbuchstaben, eine Zahl und ein Sonderzeichen aus ._@%+!:=-.'
if grep -Eqi 'BITTE_|change.?me|replace|example|default|password|passwort|admin|postgres|placeholder' <<<"$admin"; then fail 'Bitte ein individuelles Admin-Passwort ohne Platzhalter verwenden.'; fi
unset confirm
say 'Eingerichtet werden Bonni Core, seine Datenbank und der Core-Update-Dienst. Keine Apps.'
if [[ "$mode" == terminal ]]; then
  if [[ "$erase" == true ]]; then
    say "Achtung: $root wird endgültig geleert. Die zugehörigen Startwerte werden neu erstellt. Kein Backup, keine Verschiebung. Docker-Volumes bleiben erhalten."
    prompt='Daten löschen und Bonni neu installieren? [j/N] '
  else
    prompt='Bonni Core jetzt neu installieren und starten? [j/N] '
  fi
  read -r -p "$prompt" confirm
  [[ "$confirm" == j || "$confirm" == J ]] || { say 'Abgebrochen. Es wurde nichts installiert oder gelöscht.'; exit 0; }
fi

random_hex() { od -An -N32 -v -tx1 /dev/urandom | tr -d '[:space:]'; }
database_secret=$(random_hex)
master_secret=$(random_hex)
[[ ${#database_secret} == 64 && ${#master_secret} == 64 ]] || fail 'Zufallsschlüssel konnten nicht erzeugt werden.'
install_layout=normal
if [[ "$os" == Unraid ]]; then
  # One stable, editable main entry. Use the exact current controller and
  # managed runtime; the Unraid XML recreates this same controller.
  install_layout=native
  core_ref=$(read_image_ref BONNI_INITIAL_IMAGE)
  database_ref=$(read_image_ref BONNI_DATABASE_IMAGE)
  # Never copy passwords to the XML, the boot flash or the terminal.
  printf -v native_env '%s\n' "BONNI_HOST_PROJECT_ROOT=$root" "BONNI_INITIAL_IMAGE=$core_ref" "BONNI_DATABASE_IMAGE=$database_ref" \
    'BONNI_PLATFORM=linux/amd64' 'BONNI_OFFLINE=true' 'BONNI_HTTP_PORT=4000' \
    "POSTGRES_PASSWORD=$database_secret" "MASTER_KEY=$master_secret" "BONNI_BOOTSTRAP_ADMIN_PASSWORD=$admin"
fi
yaml=$(render_config "$database_secret" "$master_secret" "$admin" "$install_layout")
unset database_secret master_secret admin
project=$(project_for_root)
compose=("${docker_local[@]}" compose --project-directory "$root" --project-name "$project")
# Never print the configuration with its secrets.
"${docker_local[@]}" compose -f - config -q <<<"$yaml" 2>/dev/null || fail 'Docker Compose lehnt die Installationskonfiguration ab.'
if [[ "$mode" == browser ]]; then publish_phase images; fi
say 'Importiere die geprüften lokalen Core- und Datenbank-Images …'
if [[ "$core_imported" == false ]]; then
  check_docker_space --quiet "$core_tar" "$database_tar"
  "${docker_local[@]}" image load -i "$core_tar" || fail 'Das Core-Image konnte nicht importiert werden. Docker-Speicher und Paket prüfen.'
fi
check_docker_space --quiet "$database_tar"
"${docker_local[@]}" image load -i "$database_tar" || fail_with image-import 'Das Datenbank-Image konnte nicht importiert werden. Docker-Speicher und Paket prüfen.'
if [[ "$erase" == true ]]; then verify_erase_target; fi
check_docker_space --quiet
if [[ "$reuse_unraid_template" == true ]]; then
  same_unraid_template "$core_ref" || fail 'Die geprüfte Unraid-Vorlage wurde inzwischen verändert. Kein Löschen oder Start.'
fi
if [[ "$erase" == true ]]; then
  say "Leere ausschließlich den bestätigten Bonni-Datenordner: $root"
  find -P "$root" -xdev -depth -mindepth 1 -delete || fail 'Nicht alle Bonni-Dateien konnten gelöscht werden. Keine Installation gestartet.'
  require_empty_root
  if [[ "$recovery_layout" == native && -f "$unraid_env" ]]; then rm -- "$unraid_env"; fi
  rm -- "$config"
fi
if [[ "$create_unraid_parent" == true ]]; then
  [[ -d "$unraid_appdata" && ! -L "$unraid_appdata" ]] || fail 'Der Unraid-Share appdata ist nicht erreichbar.'
  if [[ ! -d "$target_parent" ]]; then mkdir -- "$target_parent"; fi
fi
[[ -d "$target_parent" && ! -L "$target_parent" ]] || fail 'Der Zielordner ist kein direkter Ordner.'
if [[ ! -d "$root" ]]; then mkdir -- "$root"; fi
require_empty_root
# The controller requires an empty data directory on first startup.
(set -o noclobber; printf '%s\n' "$yaml" > "$config") || fail 'Konfiguration konnte nicht sicher neu angelegt werden.'
unset yaml
if [[ "$os" == Unraid ]]; then
  (set -o noclobber; printf '%s' "$native_env" > "$unraid_env") || fail 'Unraid-Startwerte konnten nicht sicher gespeichert werden.'
  unset native_env
fi
if [[ "$os" == Unraid ]]; then
  template_parent=${unraid_template%/*}
  mkdir -p -- "$template_parent" "${unraid_icon_disk%/*}" "${unraid_icon_ram%/*}"
  for icon_target in "$unraid_icon_disk" "$unraid_icon_ram"; do
    [[ ! -L "$icon_target" ]] || fail 'Der Bonni-Iconpfad ist ein symbolischer Link.'
    if [[ ! -e "$icon_target" ]]; then install -m 644 -- bonni-unraid.png "$icon_target"; fi
  done
fi
if [[ "$os" == Unraid && "$reuse_unraid_template" == false ]]; then
  # The data path and image reference were restricted to safe characters.
  template_tmp=$(mktemp "$template_parent/.bonni-template.XXXXXX")
  render_unraid_template "$core_ref" > "$template_tmp"
  chmod 644 "$template_tmp"
  mv -n -- "$template_tmp" "$unraid_template"
  if [[ -e "$template_tmp" ]]; then rm -- "$template_tmp"; fail 'Eine vorhandene Unraid-Vorlage wird nicht überschrieben.'; fi
fi
if [[ "$mode" == browser ]]; then publish_phase services; fi
"${compose[@]}" -f "$config" up -d --pull never || fail_with start-failed 'Docker konnte Bonni nicht starten. Prüfe den Bonni-Haupteintrag.'
if [[ "$mode" == browser ]]; then
  wait_for_webui "${compose[@]}" -f "$config"
  wizard_result=ready
  say "Bonni Core ist bereit. WebUI: http://<NAS-IP>:$port"
else
  say "Start angestoßen. Öffne http://<NAS-IP>:$port, sobald Bonni bereit ist."
fi
say "Konfiguration: $config (enthält Zugangsdaten, nicht teilen)."
