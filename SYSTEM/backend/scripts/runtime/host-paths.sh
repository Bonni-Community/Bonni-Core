#!/usr/bin/env bash

# Resolve the host paths once for every wrapper that parses the runtime Compose
# file. Docker Compose expands the complete file even when only one service is
# selected, so these values must also be present for manual recovery commands.
bonni_runtime_export_host_paths() {
  local root_dir="${1:-.}"
  local variable
  local value

  BONNI_BACKEND_ROOT="$(cd "$root_dir" && pwd -P)"

  if [ -n "${BONNI_HOST_PROJECT_ROOT:-}" ]; then
    case "$BONNI_HOST_PROJECT_ROOT" in
      /*) ;;
      *) echo "BONNI_HOST_PROJECT_ROOT muss ein absoluter Hostpfad sein." >&2; return 2 ;;
    esac
  else
    BONNI_HOST_PROJECT_ROOT="$(cd "$BONNI_BACKEND_ROOT/../.." && pwd -P)"
  fi

  BONNI_HOST_RUNTIME_ROOT="${BONNI_HOST_RUNTIME_ROOT:-$BONNI_HOST_PROJECT_ROOT/runtime}"
  BONNI_HOST_RUN_SYSTEM_ROOT="${BONNI_HOST_RUN_SYSTEM_ROOT:-$BONNI_HOST_PROJECT_ROOT/run_system}"
  BONNI_RUNTIME_ENV_FILE="${BONNI_RUNTIME_ENV_FILE:-$BONNI_BACKEND_ROOT/.env}"
  BONNI_UPDATE_TRUSTED_KEYS_HOST_DIR="${BONNI_UPDATE_TRUSTED_KEYS_HOST_DIR:-$BONNI_HOST_RUNTIME_ROOT/secrets/update/trusted-keys}"
  BONNI_HOST_ACTIVE_RELEASE_ROOT="${BONNI_HOST_ACTIVE_RELEASE_ROOT:-$BONNI_HOST_RUNTIME_ROOT/update-runner/active}"

  for variable in BONNI_HOST_RUNTIME_ROOT BONNI_HOST_RUN_SYSTEM_ROOT BONNI_RUNTIME_ENV_FILE BONNI_UPDATE_TRUSTED_KEYS_HOST_DIR BONNI_HOST_ACTIVE_RELEASE_ROOT; do
    value="${!variable}"
    case "$value" in
      /*) ;;
      *) echo "$variable muss ein absoluter Hostpfad sein." >&2; return 2 ;;
    esac
  done

  if [ ! -e "$BONNI_RUNTIME_ENV_FILE" ]; then
    local environment_template="$BONNI_BACKEND_ROOT/.env.example"
    local environment_directory
    local temporary_environment
    if [ ! -f "$environment_template" ] || [ -L "$environment_template" ]; then
      echo "Sichere Vorlage für BONNI_RUNTIME_ENV_FILE fehlt: $environment_template" >&2
      return 2
    fi
    environment_directory="$(dirname "$BONNI_RUNTIME_ENV_FILE")"
    mkdir -p "$environment_directory"
    temporary_environment="$(mktemp "$environment_directory/.runtime.env.tmp.XXXXXX")"
    cp "$environment_template" "$temporary_environment"
    chmod 600 "$temporary_environment"
    if ! ln "$temporary_environment" "$BONNI_RUNTIME_ENV_FILE" 2>/dev/null; then
      if [ ! -f "$BONNI_RUNTIME_ENV_FILE" ]; then
        rm -f "$temporary_environment"
        echo "BONNI_RUNTIME_ENV_FILE konnte nicht atomar angelegt werden." >&2
        return 2
      fi
    fi
    rm -f "$temporary_environment"
  fi
  if [ ! -f "$BONNI_RUNTIME_ENV_FILE" ] || [ ! -r "$BONNI_RUNTIME_ENV_FILE" ] || [ -L "$BONNI_RUNTIME_ENV_FILE" ]; then
    echo "BONNI_RUNTIME_ENV_FILE fehlt oder ist nicht lesbar: $BONNI_RUNTIME_ENV_FILE" >&2
    return 2
  fi

  mkdir -p "$BONNI_UPDATE_TRUSTED_KEYS_HOST_DIR"
  mkdir -p "$BONNI_HOST_ACTIVE_RELEASE_ROOT"
  chmod 700 "$BONNI_HOST_ACTIVE_RELEASE_ROOT"

  BONNI_ACTIVE_RELEASE_ENV_FILE="$BONNI_HOST_ACTIVE_RELEASE_ROOT/active-release.env"
  if [ -L "$BONNI_ACTIVE_RELEASE_ENV_FILE" ] || { [ -e "$BONNI_ACTIVE_RELEASE_ENV_FILE" ] && [ ! -f "$BONNI_ACTIVE_RELEASE_ENV_FILE" ]; }; then
    echo "Active-Release-Overlay ist keine sichere reguläre Datei: $BONNI_ACTIVE_RELEASE_ENV_FILE" >&2
    return 2
  fi
  if [ ! -e "$BONNI_ACTIVE_RELEASE_ENV_FILE" ]; then
    local temporary_overlay
    temporary_overlay="$(mktemp "$BONNI_HOST_ACTIVE_RELEASE_ROOT/.active-release.env.tmp.XXXXXX")"
    chmod 600 "$temporary_overlay"
    printf '%s\n' '# Vom Bonni-Update-Runner verwaltetes Active-Overlay.' > "$temporary_overlay"
    if ! ln "$temporary_overlay" "$BONNI_ACTIVE_RELEASE_ENV_FILE" 2>/dev/null; then
      if [ ! -f "$BONNI_ACTIVE_RELEASE_ENV_FILE" ]; then
        rm -f "$temporary_overlay"
        echo "Active-Release-Overlay konnte nicht atomar angelegt werden." >&2
        return 2
      fi
    fi
    rm -f "$temporary_overlay"
  fi
  chmod 600 "$BONNI_ACTIVE_RELEASE_ENV_FILE"

  export BONNI_BACKEND_ROOT
  export BONNI_HOST_PROJECT_ROOT BONNI_HOST_RUNTIME_ROOT BONNI_HOST_RUN_SYSTEM_ROOT
  export BONNI_RUNTIME_ENV_FILE BONNI_UPDATE_TRUSTED_KEYS_HOST_DIR
  export BONNI_HOST_ACTIVE_RELEASE_ROOT BONNI_ACTIVE_RELEASE_ENV_FILE
}
