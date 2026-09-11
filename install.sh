#!/bin/sh
# Use a local, inspected source bundle. No downloads are evaluated as shell code.
set -eu
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js >=24.1.0 is required. Install Node.js, then run this script again.' >&2
  exit 1
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/scripts/install.mjs" "$@"
