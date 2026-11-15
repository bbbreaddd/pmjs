#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GAME_ROOT="${1:-${SCRIPT_DIR}/gamedata}"
SAVE_ROOT="${2:-${SCRIPT_DIR}/saves}"
GAME_ROOT="$(realpath -m "$GAME_ROOT")"
SAVE_ROOT="$(realpath -m "$SAVE_ROOT")"
exec "$RUNTIME_ROOT/dist/pmjs-arm64/bin/pmjs" "$GAME_ROOT" \
  --save-root "$SAVE_ROOT" \
  --config "${SCRIPT_DIR}/config.json"
