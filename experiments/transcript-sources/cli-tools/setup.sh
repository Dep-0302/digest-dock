#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-/Users/wangchao/.local/bin/python3.12}"
VENV_DIR="${VENV_DIR:-$SCRIPT_DIR/.venv312}"
PIP_CACHE_DIR="${PIP_CACHE_DIR:-/tmp/youtube-digest-transcript-pip-cache312}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3)"
fi

if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))'; then
  echo "Python 3.10+ is required by the pinned yt-dlp version; got: $($PYTHON_BIN --version)" >&2
  exit 2
fi

"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --cache-dir "$PIP_CACHE_DIR" --upgrade pip
"$VENV_DIR/bin/python" -m pip install --cache-dir "$PIP_CACHE_DIR" -r "$SCRIPT_DIR/requirements.txt"

"$VENV_DIR/bin/python" --version
"$VENV_DIR/bin/yt-dlp" --version
"$VENV_DIR/bin/python" -c 'import youtube_transcript_api; print("youtube-transcript-api import: OK")'
