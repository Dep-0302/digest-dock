#!/usr/bin/env python3
"""No-key YouTube transcript benchmark for yt-dlp and youtube-transcript-api.

The harness deliberately disables config files, cookies, netrc-style auth and
proxy environment variables. Transcript bodies are never persisted: results
contain only timing, shape metrics and SHA-256 digests of normalized text.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import platform
import re
import statistics
import subprocess
import sys
import tempfile
import time
import unicodedata
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import requests
from youtube_transcript_api import YouTubeTranscriptApi


PROXY_ENV_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
)
NO_TRANSCRIPT_EXCEPTIONS = {
    "NoTranscriptFound",
    "TranscriptsDisabled",
}


@dataclass
class NormalizedTranscript:
    segments: list[dict[str, Any]]
    text: str
    text_sha256: str
    character_count: int


class TimeoutSession(requests.Session):
    """Requests session that supplies a default timeout to library calls."""

    def __init__(self, timeout: float) -> None:
        super().__init__()
        self.default_timeout = timeout
        self.trust_env = False

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        kwargs.setdefault("timeout", self.default_timeout)
        return super().request(method, url, **kwargs)


def clean_environment() -> dict[str, str]:
    env = os.environ.copy()
    for key in PROXY_ENV_KEYS:
        env.pop(key, None)
    return env


def compact_error(text: str, limit: int = 1600) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def normalize_text(text: str) -> str:
    text = html.unescape(text)
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_segments(rows: Iterable[dict[str, Any]]) -> NormalizedTranscript:
    segments: list[dict[str, Any]] = []
    prior: tuple[float, str] | None = None
    for row in rows:
        text = normalize_text(str(row.get("text", "")))
        if not text:
            continue
        start = round(float(row.get("start", 0.0)), 3)
        duration = round(max(float(row.get("duration", 0.0)), 0.0), 3)
        current = (start, text)
        if current == prior:
            continue
        segments.append({"start": start, "duration": duration, "text": text})
        prior = current
    joined = "\n".join(item["text"] for item in segments)
    return NormalizedTranscript(
        segments=segments,
        text=joined,
        text_sha256=hashlib.sha256(joined.encode("utf-8")).hexdigest(),
        character_count=len(joined),
    )


def parse_json3(path: Path) -> NormalizedTranscript:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = []
    for event in payload.get("events", []):
        raw_text = "".join(segment.get("utf8", "") for segment in event.get("segs", []))
        rows.append(
            {
                "start": float(event.get("tStartMs", 0)) / 1000.0,
                "duration": float(event.get("dDurationMs", 0)) / 1000.0,
                "text": raw_text,
            }
        )
    return normalize_segments(rows)


def classify_pass(case: dict[str, Any], outcome: str) -> bool:
    if case["expectTranscript"]:
        return outcome == "success"
    return outcome == "no_transcript"


def base_result(tool: str, case: dict[str, Any], run_index: int) -> dict[str, Any]:
    return {
        "tool": tool,
        "caseId": case["id"],
        "videoId": case["videoId"],
        "category": case["category"],
        "requestedLanguage": case["language"],
        "requestedTrackKind": case["trackKind"],
        "run": run_index,
    }


def run_ytdlp(case: dict[str, Any], run_index: int, executable: Path, timeout: float) -> dict[str, Any]:
    result = base_result("yt-dlp", case, run_index)
    with tempfile.TemporaryDirectory(prefix="youtube-transcript-ytdlp-") as tmp:
        tmp_path = Path(tmp)
        command = [
            str(executable),
            "--ignore-config",
            "--no-cookies",
            "--proxy",
            "",
            "--no-playlist",
            "--skip-download",
            "--sub-format",
            "json3",
            "--no-progress",
            "--output",
            str(tmp_path / "%(id)s.%(ext)s"),
        ]
        if case["trackKind"] == "manual":
            command += ["--write-subs", "--sub-langs", case["language"]]
        elif case["trackKind"] == "auto":
            command += ["--write-auto-subs", "--sub-langs", case["language"]]
        else:
            command += ["--write-subs", "--write-auto-subs", "--sub-langs", "all"]
        command.append(f"https://www.youtube.com/watch?v={case['videoId']}")

        started = time.perf_counter()
        try:
            proc = subprocess.run(
                command,
                capture_output=True,
                text=True,
                env=clean_environment(),
                timeout=timeout,
                check=False,
            )
            elapsed = time.perf_counter() - started
        except subprocess.TimeoutExpired as exc:
            elapsed = time.perf_counter() - started
            result.update(
                {
                    "outcome": "timeout",
                    "elapsedSeconds": round(elapsed, 3),
                    "exitCode": None,
                    "errorType": "TimeoutExpired",
                    "error": compact_error(str(exc)),
                }
            )
            result["passedExpectation"] = classify_pass(case, result["outcome"])
            return result

        files = sorted(tmp_path.glob("*.json3"))
        stderr = compact_error(proc.stderr)
        stdout = compact_error(proc.stdout)
        result.update(
            {
                "elapsedSeconds": round(elapsed, 3),
                "exitCode": proc.returncode,
                "processesSpawned": 1,
                "stderr": stderr,
                "stdout": stdout,
                "outputFileCount": len(files),
            }
        )
        if proc.returncode != 0:
            result.update({"outcome": "error", "errorType": "YtDlpExit", "error": stderr or stdout})
        elif not files:
            result.update({"outcome": "no_transcript", "errorType": None, "error": None})
        else:
            try:
                normalized = parse_json3(files[0])
                if not normalized.segments:
                    result.update({"outcome": "no_transcript", "errorType": None, "error": None})
                else:
                    result.update(
                        {
                            "outcome": "success",
                            "errorType": None,
                            "error": None,
                            "segmentCount": len(normalized.segments),
                            "characterCount": normalized.character_count,
                            "textSha256": normalized.text_sha256,
                            "normalizationSource": "json3.events[].segs[].utf8",
                        }
                    )
            except Exception as exc:  # noqa: BLE001 - benchmark records parser failures verbatim
                result.update(
                    {
                        "outcome": "normalization_error",
                        "errorType": type(exc).__name__,
                        "error": compact_error(str(exc)),
                    }
                )
        result["passedExpectation"] = classify_pass(case, result["outcome"])
        return result


def select_transcript(tracks: list[Any], case: dict[str, Any]) -> Any | None:
    language = case["language"]
    generated = case["trackKind"] == "auto"
    matching = [
        track
        for track in tracks
        if track.language_code == language and bool(track.is_generated) == generated
    ]
    return matching[0] if matching else None


def run_transcript_api(case: dict[str, Any], run_index: int, timeout: float) -> dict[str, Any]:
    result = base_result("youtube-transcript-api", case, run_index)
    session = TimeoutSession(timeout)
    api = YouTubeTranscriptApi(http_client=session)
    started = time.perf_counter()
    try:
        tracks = list(api.list(case["videoId"]))
        discovered = [
            {
                "language": track.language_code,
                "kind": "auto" if track.is_generated else "manual",
            }
            for track in tracks
        ]
        if case["trackKind"] == "none":
            outcome = "no_transcript" if not tracks else "unexpected_transcript"
            result.update(
                {
                    "outcome": outcome,
                    "discoveredTrackCount": len(tracks),
                    "discoveredTracks": discovered,
                    "errorType": None,
                    "error": None,
                }
            )
        else:
            selected = select_transcript(tracks, case)
            if selected is None:
                result.update(
                    {
                        "outcome": "no_matching_track",
                        "discoveredTrackCount": len(tracks),
                        "discoveredTracks": discovered,
                        "errorType": "NoMatchingTrack",
                        "error": f"No {case['trackKind']} {case['language']} track",
                    }
                )
            else:
                fetched = selected.fetch()
                normalized = normalize_segments(
                    {"start": item.start, "duration": item.duration, "text": item.text}
                    for item in fetched
                )
                result.update(
                    {
                        "outcome": "success" if normalized.segments else "no_transcript",
                        "discoveredTrackCount": len(tracks),
                        "selectedLanguage": selected.language_code,
                        "selectedTrackKind": "auto" if selected.is_generated else "manual",
                        "segmentCount": len(normalized.segments),
                        "characterCount": normalized.character_count,
                        "textSha256": normalized.text_sha256,
                        "normalizationSource": "FetchedTranscriptSnippet(text,start,duration)",
                        "errorType": None,
                        "error": None,
                    }
                )
    except Exception as exc:  # noqa: BLE001 - exception class is benchmark data
        outcome = "no_transcript" if type(exc).__name__ in NO_TRANSCRIPT_EXCEPTIONS else "error"
        result.update(
            {
                "outcome": outcome,
                "errorType": type(exc).__name__,
                "error": compact_error(str(exc)),
            }
        )
    finally:
        session.close()
    elapsed = time.perf_counter() - started
    result.update(
        {
            "elapsedSeconds": round(elapsed, 3),
            "processesSpawned": 0,
            "timeoutRequestedSeconds": timeout,
            "timeoutEnforcedByAdapter": True,
        }
    )
    result["passedExpectation"] = classify_pass(case, result["outcome"])
    return result


def median(values: list[float | int]) -> float | None:
    return round(float(statistics.median(values)), 3) if values else None


def aggregate(attempts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for attempt in attempts:
        grouped.setdefault((attempt["tool"], attempt["caseId"]), []).append(attempt)
    rows = []
    for (tool, case_id), values in sorted(grouped.items()):
        elapsed = [item["elapsedSeconds"] for item in values]
        successful = [item for item in values if item["outcome"] == "success"]
        rows.append(
            {
                "tool": tool,
                "caseId": case_id,
                "attempts": len(values),
                "expectationPasses": sum(bool(item["passedExpectation"]) for item in values),
                "expectationPassRate": round(
                    sum(bool(item["passedExpectation"]) for item in values) / len(values), 3
                ),
                "outcomes": {outcome: sum(item["outcome"] == outcome for item in values) for outcome in sorted({item["outcome"] for item in values})},
                "medianElapsedSeconds": median(elapsed),
                "minElapsedSeconds": round(min(elapsed), 3),
                "maxElapsedSeconds": round(max(elapsed), 3),
                "medianSegmentCount": median([item["segmentCount"] for item in successful]),
                "medianCharacterCount": median([item["characterCount"] for item in successful]),
                "stableDigestAcrossRuns": len({item["textSha256"] for item in successful}) <= 1 if successful else None,
                "errorTypes": sorted({item["errorType"] for item in values if item.get("errorType")}),
            }
        )
    return rows


def cross_tool_comparison(attempts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    case_ids = sorted({item["caseId"] for item in attempts})
    for case_id in case_ids:
        first_result: dict[str, dict[str, Any]] = {}
        for item in attempts:
            if item["caseId"] == case_id and item["tool"] not in first_result:
                first_result[item["tool"]] = item
        left = first_result.get("yt-dlp")
        right = first_result.get("youtube-transcript-api")
        if left and right and left["outcome"] == "success" and right["outcome"] == "success":
            left_chars = int(left["characterCount"])
            right_chars = int(right["characterCount"])
            rows.append(
                {
                    "caseId": case_id,
                    "ytDlpOutcome": left["outcome"],
                    "youtubeTranscriptApiOutcome": right["outcome"],
                    "bothMatchedExpectation": bool(left["passedExpectation"] and right["passedExpectation"]),
                    "bothRetrievedTranscript": True,
                    "exactNormalizedDigestMatch": left["textSha256"] == right["textSha256"],
                    "characterCountDifference": left_chars - right_chars,
                    "characterCountRatio": round(left_chars / right_chars, 4) if right_chars else None,
                    "segmentCountDifference": int(left["segmentCount"]) - int(right["segmentCount"]),
                }
            )
        else:
            rows.append(
                {
                    "caseId": case_id,
                    "ytDlpOutcome": left["outcome"] if left else "missing",
                    "youtubeTranscriptApiOutcome": right["outcome"] if right else "missing",
                    "bothMatchedExpectation": bool(
                        left and right and left["passedExpectation"] and right["passedExpectation"]
                    ),
                    "bothRetrievedTranscript": False,
                    "exactNormalizedDigestMatch": None,
                }
            )
    return rows


def package_size(path: Path) -> int | None:
    if not path.exists():
        return None
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def environment_metadata(ytdlp: Path) -> dict[str, Any]:
    site_packages = Path(requests.__file__).resolve().parent.parent
    ytdlp_package = site_packages / "yt_dlp"
    transcript_package = site_packages / "youtube_transcript_api"
    ytdlp_version = subprocess.check_output([str(ytdlp), "--version"], text=True).strip()
    try:
        from importlib.metadata import version

        transcript_api_version = version("youtube-transcript-api")
    except Exception:  # pragma: no cover - metadata should exist in the benchmark venv
        transcript_api_version = "unknown"
    return {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "pythonExecutable": str(Path(sys.executable).resolve()),
        "ytDlpVersion": ytdlp_version,
        "youtubeTranscriptApiVersion": transcript_api_version,
        "ytDlpPackageBytes": package_size(ytdlp_package),
        "youtubeTranscriptApiPackageBytes": package_size(transcript_package),
        "requestsPackageBytes": package_size(Path(requests.__file__).resolve().parent),
        "networkPolicy": {
            "cookies": "disabled",
            "proxyEnvironment": "removed",
            "credentials": "none",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--timeout", type=float, default=45.0)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be at least 1")

    manifest = json.loads(args.cases.read_text(encoding="utf-8"))
    cases = manifest["cases"]
    ytdlp = Path(sys.executable).parent / "yt-dlp"
    if not ytdlp.exists():
        raise SystemExit(f"yt-dlp executable not found next to Python: {ytdlp}")

    attempts: list[dict[str, Any]] = []
    for run_index in range(1, args.runs + 1):
        for case in cases:
            print(f"[{run_index}/{args.runs}] yt-dlp {case['id']}", flush=True)
            attempts.append(run_ytdlp(case, run_index, ytdlp, args.timeout))
            print(f"[{run_index}/{args.runs}] youtube-transcript-api {case['id']}", flush=True)
            attempts.append(run_transcript_api(case, run_index, args.timeout))

    payload = {
        "schemaVersion": 1,
        "environment": environment_metadata(ytdlp),
        "caseManifest": manifest,
        "configuration": {"runs": args.runs, "ytDlpTimeoutSeconds": args.timeout},
        "attempts": attempts,
    }
    summary = {
        "schemaVersion": 1,
        "environment": payload["environment"],
        "configuration": payload["configuration"],
        "aggregate": aggregate(attempts),
        "crossTool": cross_tool_comparison(attempts),
        "overall": {
            tool: {
                "attempts": len([item for item in attempts if item["tool"] == tool]),
                "expectationPasses": sum(item["passedExpectation"] for item in attempts if item["tool"] == tool),
            }
            for tool in ("yt-dlp", "youtube-transcript-api")
        },
    }
    for tool_data in summary["overall"].values():
        tool_data["expectationPassRate"] = round(tool_data["expectationPasses"] / tool_data["attempts"], 3)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "raw.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (args.output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary["overall"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
