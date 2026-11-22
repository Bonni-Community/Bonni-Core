#!/usr/bin/env bash
# Geführte Neuinstallation aus einem offiziellen Bonni-Core-Container-ZIP.
set +x
set -euo pipefail
umask 077
export LC_ALL=C

fail() { printf '[Bonni] %s\n' "$*" >&2; exit 1; }
say() { printf '[Bonni] %s\n' "$*"; }

root=''
check=false
browser=false
core_imported=false
while (($#)); do
  case "$1" in
    --ordner) (($# >= 2)) && [[ -n "$2" ]] || fail 'Nach --ordner fehlt der Datenpfad.'; root=$2; shift 2 ;;
    --pruefen) check=true; shift ;;
    --browser) browser=true; shift ;;
    -h|--help) printf '%s\n' 'bash bonnicore-install.sh [--ordner /absoluter/datenpfad] [--pruefen | --browser]' 'Nur für Bonni-Core-Neuinstallationen; keine Apps. Prüfen ändert keine Dateien und startet nichts.'; exit 0 ;;
    *) fail "Unbekannte Option: $1" ;;
  esac
done
[[ "$check:$browser" != 'true:true' ]] || fail 'Bitte --pruefen und --browser getrennt aufrufen.'

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
for utility in docker sha256sum grep od tr; do
  command -v "$utility" >/dev/null || fail "Benötigtes Programm fehlt: $utility."
done
docker_local=(docker --host unix:///var/run/docker.sock)
"${docker_local[@]}" compose version >/dev/null 2>&1 || fail 'Docker Compose v2 fehlt. Bitte Docker/Container Manager zuerst bereitstellen.'
"${docker_local[@]}" info >/dev/null 2>&1 || fail 'Der lokale Docker-Dienst läuft nicht oder ist für dieses Terminal nicht erreichbar.'

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

if [[ "$browser" == true ]]; then
  [[ -t 0 ]] || fail 'Für den Browser-Assistenten ein interaktives NAS-Terminal öffnen.'
  [[ "$here" != *','* && "$here" != *'"'* && "$here" != *$'\n'* && "$here" != *$'\r'* ]] || fail 'Das Paket für den Browser-Assistenten in einen einfachen Ordner entpacken.'
  for ui_file in bonnicore-setup.html bonnicore-setup.mjs; do
    [[ -f "$ui_file" && ! -L "$ui_file" ]] || fail 'Der Browser-Assistent fehlt im Paket.'
  done
  verify_bundle
  mapfile -t image_lines < <(grep -E '^      BONNI_INITIAL_IMAGE: [a-z0-9][a-z0-9._:/@-]{1,255}$' <<<"$source_yaml")
  ((${#image_lines[@]} == 1)) || fail 'Das Core-Image für den Assistenten ist nicht eindeutig.'
  wizard_ref=${image_lines[0]#*BONNI_INITIAL_IMAGE: }
  say 'Das Offline-Paket ist geprüft. Lade das Core-Image für den temporären Assistenten …'
  "${docker_local[@]}" image load -i "$core_tar"
  core_imported=true
  wizard_image=$("${docker_local[@]}" image inspect --format '{{.Id}}' "$wizard_ref") || fail 'Das erwartete Core-Image fehlt nach dem Import.'
  [[ "$wizard_image" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Das Core-Image konnte nicht eindeutig gebunden werden.'
  say 'Am eigenen Rechner per SSH weiterleiten (NAS-Benutzer und NAS-IP einsetzen):'
  say 'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:4180:127.0.0.1:4180 <NAS-Benutzer>@<NAS-IP>'
  say 'Danach den unten angezeigten Einrichtungslink im Browser öffnen. Der Link läuft nach 10 Minuten ab.'
  choice=$("${docker_local[@]}" run --rm --pull never --network host --log-driver none --read-only \
    --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 \
    --mount "type=bind,source=$here/bonnicore-setup.html,target=/wizard/bonnicore-setup.html,readonly" \
    --mount "type=bind,source=$here/bonnicore-setup.mjs,target=/wizard/bonnicore-setup.mjs,readonly" \
    --entrypoint /usr/local/bin/node "$wizard_image" /wizard/bonnicore-setup.mjs "$os" "$architecture" "${root:-$suggestion}" "$core_version") \
    || fail 'Keine Eingaben übernommen. Für die Terminal-Einrichtung den Befehl ohne --browser starten.'
  [[ "$choice" == *$'\t'* && "$choice" != *$'\n'* && "$choice" != *$'\r'* ]] || fail 'Die Antwort des Assistenten war unvollständig.'
  root=${choice%%$'\t'*}; admin=${choice#*$'\t'}; confirm=$admin
  [[ -n "$root" && -n "$admin" && "$admin" != *$'\t'* ]] || fail 'Die Antwort des Assistenten war unvollständig.'
  unset choice
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
[[ ! -e "$config" && ! -L "$config" ]] || fail "Es gibt bereits eine Installationskonfiguration: $config. Sie wird nicht überschrieben."
require_empty_root() {
  local -a entries
  if [[ -d "$root" ]]; then
    [[ -r "$root" && -x "$root" && ! -L "$root" ]] || fail 'Der Datenordner konnte nicht sicher geprüft werden.'
    shopt -s dotglob
    entries=("$root"/*)
    shopt -u dotglob
    ((${#entries[@]} == 0)) || fail 'Der Datenordner ist bereits belegt. Vorhandene Installationen werden nicht verändert.'
  fi
}
require_empty_root

verify_bundle
say "Paket und Prüfsummen in Ordnung: $architecture. Ziel: $root."
if [[ "$create_unraid_parent" == true ]]; then say "Wird bei der Installation neu angelegt: $target_parent."; fi
if [[ "$check" == true ]]; then exit 0; fi

port=4000
if command -v ss >/dev/null; then
  listeners=$(ss -H -ltn) || fail 'Offene TCP-Ports konnten nicht geprüft werden.'
  if grep -Eq '[[:space:]][^[:space:]]*:(4000|4001|4199)[[:space:]]' <<<"$listeners"; then
    fail 'Port 4000, 4001 oder 4199 ist belegt. Bestehende Dienste werden nicht automatisch gestoppt.'
  fi
fi
[[ -t 0 ]] || fail 'Für die Erstinstallation bitte ein interaktives NAS-Terminal öffnen.'
if [[ "$browser" == false ]]; then
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
read -r -p 'Bonni Core jetzt neu installieren und starten? [j/N] ' confirm
[[ "$confirm" == j || "$confirm" == J ]] || { say 'Abgebrochen. Es wurde nichts installiert.'; exit 0; }

random_hex() { od -An -N32 -v -tx1 /dev/urandom | tr -d '[:space:]'; }
database_secret=$(random_hex)
master_secret=$(random_hex)
[[ ${#database_secret} == 64 && ${#master_secret} == 64 ]] || fail 'Zufallsschlüssel konnten nicht erzeugt werden.'
yaml=${source_yaml/'x-bonni-root: &bonni_root /var/lib/bonni-core'/"x-bonni-root: &bonni_root $root"}
yaml=${yaml/BITTE_EIGENES_DATENBANKKENNWORT_EINTRAGEN/"$database_secret"}
yaml=${yaml/BITTE_EIGENEN_ZUFAELLIGEN_MASTER_KEY_EINTRAGEN/"$master_secret"}
yaml=${yaml/BITTE_EIGENES_ADMIN_KENNWORT_EINTRAGEN/"$admin"}
unset database_secret master_secret admin
project_hash=$(printf '%s' "$root" | sha256sum)
project="bonni-install-${project_hash:0:12}"
compose=("${docker_local[@]}" compose --project-directory "$root" --project-name "$project")
# Never print the configuration with its secrets.
"${docker_local[@]}" compose -f - config -q <<<"$yaml" || fail 'Docker Compose lehnt die Installationskonfiguration ab.'
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
say 'Importiere die geprüften lokalen Core- und Datenbank-Images …'
if [[ "$core_imported" == false ]]; then "${docker_local[@]}" image load -i "$core_tar"; fi
"${docker_local[@]}" image load -i "$database_tar"
"${compose[@]}" -f "$config" up -d --pull never
say "Start angestoßen. Öffne http://<NAS-IP>:$port, sobald Bonni bereit ist."
say "Konfiguration: $config (enthält Zugangsdaten, nicht teilen)."
