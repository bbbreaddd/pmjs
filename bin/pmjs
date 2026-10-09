#!/bin/sh
set -eu
PMJS_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
export LD_LIBRARY_PATH="$PMJS_ROOT/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
if [ -x "$PMJS_ROOT/bin/node" ]; then
  PMJS_NODE="$PMJS_ROOT/bin/node"
else
  PMJS_NODE="${PMJS_NODE:-node}"
fi
exec "$PMJS_NODE" "$PMJS_ROOT/share/pmjs/tools/pmjs.mjs" "$PMJS_ROOT" "$@"
