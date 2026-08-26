#!/usr/bin/env python3
"""Record local installation/runtime facts without installing anything."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def command_output(command: list[str]) -> str | None:
    try:
        return subprocess.check_output(command, stderr=subprocess.DEVNULL, text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def main() -> int:
    venv312 = ROOT / ".venv312" / "bin"
    legacy = ROOT / ".venv" / "bin"
    payload = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "system": {
            "pythonExecutable": sys.executable,
            "pythonVersion": command_output([sys.executable, "--version"]),
            "ytDlpOnPath": shutil.which("yt-dlp"),
            "youtubeTranscriptApiImportable": importlib.util.find_spec("youtube_transcript_api") is not None,
        },
        "isolatedPython312Venv": {
            "pythonVersion": command_output([str(venv312 / "python"), "--version"]),
            "ytDlpVersion": command_output([str(venv312 / "yt-dlp"), "--version"]),
            "ytDlpRequiresPython": command_output(
                [
                    str(venv312 / "python"),
                    "-c",
                    "from importlib.metadata import metadata; print(metadata('yt-dlp').get('Requires-Python'))",
                ]
            ),
            "youtubeTranscriptApiVersion": command_output(
                [
                    str(venv312 / "python"),
                    "-c",
                    "from importlib.metadata import version; print(version('youtube-transcript-api'))",
                ]
            ),
            "youtubeTranscriptApiRequiresPython": command_output(
                [
                    str(venv312 / "python"),
                    "-c",
                    "from importlib.metadata import metadata; print(metadata('youtube-transcript-api').get('Requires-Python'))",
                ]
            ),
        },
        "python39CompatibilityObservation": {
            "pythonVersion": command_output([str(legacy / "python"), "--version"]),
            "ytDlpVersionResolvedOn2026-08-18": command_output([str(legacy / "yt-dlp"), "--version"]),
            "note": "The same unconstrained install on system Python 3.9 resolved an older yt-dlp than Python 3.12.",
        },
    }
    output = ROOT / "results" / "environment-probe.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
