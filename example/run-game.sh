#!/usr/bin/env bash
set -euo pipefail

# Reference launcher script for a PMJS port
# Usage: ./run-game.sh [path/to/game] [path/to/saves]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$RUNTIME_ROOT"

GAME_ROOT="${1:-${SCRIPT_DIR}/gamedata}"
SAVE_ROOT="${2:-${SCRIPT_DIR}/saves}"
BOOTSTRAP_OUTPUT="build-js/game-bootstrap.js"

mkdir -p "$(dirname "$BOOTSTRAP_OUTPUT")" "$SAVE_ROOT"

echo "==> Building JS bootstrap bundle..."
node tools/build-js-runtime.mjs \
  --game "$GAME_ROOT" \
  --config "${SCRIPT_DIR}/config.json" \
  --output "$BOOTSTRAP_OUTPUT"

RUNNER="node"
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  if command -v xvfb-run >/dev/null 2>&1; then
    RUNNER="xvfb-run -a node"
  fi
fi

echo "==> Starting PMJS runner..."
$RUNNER runner/cli.cjs \
  --addon build/pmjs_native.node \
  --game-root "$GAME_ROOT" \
  --bootstrap "$BOOTSTRAP_OUTPUT" \
  --save-root "$SAVE_ROOT" \
  --config "${SCRIPT_DIR}/config.json"
