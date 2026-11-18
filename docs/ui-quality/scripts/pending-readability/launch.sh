#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 3 ]]; then
  echo "Usage: bash launch.sh REPOSITORY BUILT_OUTPUT EXISTING_ELECTRON [desktop|narrow|zoom200|narrow-zoom200] [pending|send|footer|manual] [en|zh-CN] [light|dark]" >&2
  exit 1
fi
REPOSITORY="$1"
OUTPUT="$2"
ELECTRON="$3"
shift 3
[[ -x "$ELECTRON" ]] || { echo "Existing Electron executable unavailable: $ELECTRON" >&2; exit 1; }
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export TZ=UTC
exec env -u ELECTRON_RUN_AS_NODE "$ELECTRON" "$HERE/launch.cjs" \
  "$REPOSITORY" "$OUTPUT" "${1:-desktop}" "${2:-pending}" "${3:-en}" "${4:-light}"
