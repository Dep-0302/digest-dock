#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="${VENV_DIR:-$SCRIPT_DIR/.venv312}"

"/usr/bin/python3" "$SCRIPT_DIR/probe_environment.py"
"$VENV_DIR/bin/python" "$SCRIPT_DIR/benchmark.py" \
  --cases "$SCRIPT_DIR/cases.json" \
  --output-dir "$SCRIPT_DIR/results" \
  "$@"
