#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRESET="${PMJS_BUILD_PRESET:-release-x64}"
configure=(--preset "$PRESET")
build=(--build --preset "$PRESET")
if [ -n "${PMJS_BUILD_DIR:-}" ]; then
  BUILD_DIR="$PMJS_BUILD_DIR"
  case "$BUILD_DIR" in /*) ;; *) BUILD_DIR="$PWD/$BUILD_DIR" ;; esac
  configure+=(-B "$BUILD_DIR")
  build=(--build "$BUILD_DIR")
fi
cd "$ROOT"
cmake "${configure[@]}" "$@"
cmake "${build[@]}" --target pmjs_native --parallel "${PMJS_BUILD_JOBS:-4}"
