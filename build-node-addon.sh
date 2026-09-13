#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cmake -S "$ROOT" -B "$ROOT/build" -DCMAKE_BUILD_TYPE=Release "$@"
cmake --build "$ROOT/build" --parallel
ctest --test-dir "$ROOT/build" --output-on-failure
