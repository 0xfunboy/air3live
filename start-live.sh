#!/usr/bin/env bash
set -euo pipefail
AIR3_LAUNCH_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$AIR3_LAUNCH_ROOT"
exec node scripts/start-live.mjs "$@"
