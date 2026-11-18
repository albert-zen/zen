#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -lt 3 || "$#" -gt 4 || ( "$#" -eq 4 && "$4" != "--check" ) ]]; then
  echo "Usage: $0 repository seeded-qa-root installed-electron-executable [--check]" >&2
  exit 2
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd -- "$1" && pwd -P)"
ROOT="$(cd -- "$2" && pwd -P)"
ELECTRON="$(cd -- "$(dirname -- "$3")" && pwd -P)/$(basename -- "$3")"
[[ -x "$ELECTRON" ]] || { echo "Choose an already-installed Electron executable, not a download shim" >&2; exit 1; }
if [[ "${4:-}" == "--check" ]]; then
  NODE="${ZENX_QA_NODE_BIN:-$(command -v node || true)}"
  [[ -n "$NODE" && -x "$NODE" ]] || { echo "Set ZENX_QA_NODE_BIN to an installed Node executable for --check" >&2; exit 1; }
  exec "$NODE" "$SCRIPT_DIR/launch-live-native.cjs" --check "$REPO" "$ROOT"
fi
cd -- "$REPO"
export ZENX_LIVE_QA_ROOT="$ROOT"
export ZENX_LIVE_QA_REPOSITORY="$REPO"
exec env -u ELECTRON_RUN_AS_NODE "$ELECTRON" "$SCRIPT_DIR/launch-live-native.cjs"
