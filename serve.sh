#!/usr/bin/env bash
# Serve the project on a local static HTTP server.
# Usage:  ./serve.sh [port]
# Default port: 8765
set -euo pipefail

PORT="${1:-8765}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Serving $ROOT at http://localhost:$PORT"
echo "Press Ctrl-C to stop."

cd "$ROOT"

if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  exec python -m SimpleHTTPServer "$PORT"
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes serve -l "$PORT" .
else
  echo "No python or npx available. Install Python 3 or Node.js."
  exit 1
fi
