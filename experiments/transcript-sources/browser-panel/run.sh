#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export NODE_PATH="${NODE_PATH:-/Users/wangchao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules}"
export CHROME_PATH="${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
exec node "$SCRIPT_DIR/run.mjs"
