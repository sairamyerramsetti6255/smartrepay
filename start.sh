#!/bin/sh
# Resilient production start for Coolify / Node 22+.
set -eu

echo "[BOOT] $(date -u +%Y-%m-%dT%H:%M:%SZ) node=$(node -v) port=${PORT:-3001}"

if node --experimental-sqlite -e "import('node:sqlite').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "[BOOT] Starting with --experimental-sqlite"
  exec node --experimental-sqlite index.js
fi

echo "[BOOT] Starting without --experimental-sqlite"
exec node index.js
