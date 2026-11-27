#!/usr/bin/env bash
set -euo pipefail
umask 077

embedded_zip=''
embedded_sha256=''

fail() {
  printf '[Bonni] %s\n' "$*" >&2
  exit 1
}

launcher=$(readlink -f -- "${BASH_SOURCE[0]}")
cd -- "$(dirname -- "$launcher")"
work=''
trap 'if [[ -n "$work" ]]; then rm -rf -- "$work"; fi' EXIT

if [[ -n "$embedded_zip" ]]; then
  (($# == 0)) || fail 'Dieses Einzelpaket wird ohne weitere Optionen gestartet.'
  [[ -f /etc/unraid-version && $(uname -m) == x86_64 ]] || fail 'Dieses Paket ist für Unraid auf AMD64 vorgesehen.'
  work=$(mktemp -d .bonni-install.XXXXXXXX)
  archive="$work/$embedded_zip"
  first_line=$(awk '/^__BONNI_ZIP_PAYLOAD__$/ { print NR + 1; exit }' "$launcher")
  [[ "$first_line" =~ ^[0-9]+$ ]] || fail 'Das eingebettete ZIP fehlt.'
  printf '[Bonni] Entpacke das AMD64-Paket …\n'
  tail -n "+$first_line" -- "$launcher" >"$archive"
  archive_hash=$(sha256sum -- "$archive")
  [[ "${archive_hash%% *}" == "$embedded_sha256" ]] || fail 'Die Prüfsumme des eingebetteten ZIPs stimmt nicht.'
else
  shopt -s nullglob
  archives=(64-Bit-Bonni-Core-v*-AMD64.zip)
  ((${#archives[@]} == 1)) || fail 'Bitte genau ein AMD64-Release-ZIP neben bonnicore-install.sh ablegen.'
  archive=${archives[0]}
fi

name=${archive##*/}
[[ "$name" =~ ^64-Bit-Bonni-Core-v[0-9]+\.[0-9]+\.[0-9]+([+-][a-z])?-AMD64\.zip$ ]] || fail 'Der Dateiname passt nicht zu einem AMD64-Release-ZIP.'
member="${name%.zip}/bonnicore-install.sh"
work=${work:-$(mktemp -d .bonni-install.XXXXXXXX)}
installer="$work/installer.sh"
unzip -p "$archive" "$member" >"$installer" || fail 'Der Installer fehlt im ZIP oder lässt sich nicht lesen.'
grep -Fq -- '--unraid-zip' "$installer" || fail 'Dieses Release-ZIP enthält noch den älteren Installer.'

if [[ "${1-}" == --einzeldatei && $# == 1 ]]; then
  mkdir -p -- Unraid
  target='Unraid/bonnicore-install.sh'
  [[ ! -e "$target" && ! -L "$target" ]] || fail "Die Datei $target existiert bereits."
  archive_hash=$(sha256sum -- "$archive")
  temporary="$work/bonnicore-install.sh"
  sed -e "s/^embedded_zip=''$/embedded_zip='$name'/" \
      -e "s/^embedded_sha256=''$/embedded_sha256='${archive_hash%% *}'/" "$launcher" >"$temporary"
  printf '__BONNI_ZIP_PAYLOAD__\n' >>"$temporary"
  cat -- "$archive" >>"$temporary"
  mv -n -- "$temporary" "$target" || fail "Die Datei $target konnte nicht angelegt werden."
  [[ ! -e "$temporary" ]] || fail "Die Datei $target existiert bereits."
  printf '[Bonni] Einzelpaket erstellt: %s\n' "$target"
  exit 0
fi

(($# == 0)) || fail 'Aufruf: bash bonnicore-install.sh [--einzeldatei]'
bash "$installer" --unraid-zip "$archive"
exit 0
