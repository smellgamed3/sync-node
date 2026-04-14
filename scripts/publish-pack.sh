#!/usr/bin/env bash
set -euo pipefail

if [ $# -ge 1 ] && [ -n "${1:-}" ]; then
  export NPM_SCOPE="$1"
fi

node "$(dirname "$0")/publish-pack.mjs"
