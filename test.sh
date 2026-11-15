#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "== loopar-install checks (no network) =="
node --check index.js
node index.js doctor
node index.js --help >/dev/null
echo "OK"

echo ""
echo "Optional clone smoke (needs Git + network): npm run test:smoke"
