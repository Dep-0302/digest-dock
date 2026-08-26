#!/usr/bin/env python3
"""Experiment-only loopback wrapper for youtube-transcript-api.

The module keeps third-party imports inside the live provider function so its
validation and fixture tests run without an installed environment. It never
accepts a caller-supplied URL, cookies, headers, proxy settings, or credentials.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Callable


SCHEMA_VERSION = 1
MAX_REQUEST_BYTES = 4096
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
VIDEO_ID = re.compile(r"^[0-9A-Za-z_-]{11}$")
REQUEST_ID = re.compile(r"^[0-9A-Za-z._:-]{1,80}$")
LANGUAGE = re.compile(r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$")
EXTENSION_ORIGIN = re.compile(r"^chrome-extension://[a-p]{32}$")
TRACK_KINDS = {"manual", "asr", "manual-first", "any"}
ALLOWED_FIELDS = {
    "schemaVersion",
    "requestId",
    "providerId",
    "providerVariant",
    "runId",
    "videoId",
    "preferredLanguage",
    "trackKind",
}


class HelperError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def validate_pairing_token(value: str) -> str:
    token = str(value or "")
    if not 32 <= len(token) <= 256 or any(character.isspace() for character in token):
        raise HelperError(
            "HELPER_UNAUTHORIZED",
            "A 32-256 character pairing token is required.",
            401,
        )
    return token


def validate_extension_origin(value: str) -> str:
    origin = str(value or "")
    if not EXTENSION_ORIGIN.fullmatch(origin):
        raise HelperError(
            "HELPER_UNAUTHORIZED",
            "An exact Chrome extension origin is required.",
            403,
        )
    return origin


def validate_request(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HelperError("INVALID_RESPONSE", "Request body must be a JSON object.")
    unknown = set(payload) - ALLOWED_FIELDS
    if unknown:
        raise HelperError("INVALID_RESPONSE", "Request contained unknown fields.")
    if payload.get("schemaVersion") != SCHEMA_VERSION:
        raise HelperError(
            "HELPER_VERSION_MISMATCH",
            "Unsupported local-helper schema version.",
            409,
        )
    if payload.get("providerId") != "local-helper":
        raise HelperError("INVALID_RESPONSE", "Provider ID must be local-helper.")
    if payload.get("providerVariant") != "youtube-transcript-api":
        raise HelperError("INVALID_RESPONSE", "Provider variant is invalid.")
    request_id = str(payload.get("requestId") or "")
    if not REQUEST_ID.fullmatch(request_id):
        raise HelperError("INVALID_RESPONSE", "Request ID is invalid.")
    run_id = str(payload.get("runId") or "")
    if not REQUEST_ID.fullmatch(run_id):
        raise HelperError("INVALID_RESPONSE", "Run ID is invalid.")
    video_id = str(payload.get("videoId") or "")
    if not VIDEO_ID.fullmatch(video_id):
        raise HelperError("INVALID_RESPONSE", "Video ID is invalid.")
    language = payload.get("preferredLanguage")
    if language is not None:
        language = str(language).replace("_", "-")
        if not LANGUAGE.fullmatch(language):
            raise HelperError("INVALID_RESPONSE", "Preferred language is invalid.")
    track_kind = str(payload.get("trackKind") or "manual-first")
    if track_kind not in TRACK_KINDS:
        raise HelperError("INVALID_RESPONSE", "Track kind is invalid.")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "requestId": request_id,
        "providerId": "local-helper",
        "providerVariant": "youtube-transcript-api",
        "runId": run_id,
        "videoId": video_id,
        "preferredLanguage": language,
        "trackKind": track_kind,
    }


def normalize_segments(rows: Any, language: str | None = None) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        raise HelperError("INVALID_RESPONSE", "Provider segments must be an array.")
    output: list[dict[str, Any]] = []
    previous_start = float("-inf")
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise HelperError("INVALID_RESPONSE", f"Provider segment {index} is invalid.")
        text = re.sub(r"\s+", " ", str(row.get("text", ""))).strip()
        try:
            start = float(row["start"])
            duration = float(row["duration"])
        except (TypeError, ValueError):
            raise HelperError("INVALID_RESPONSE", f"Provider segment {index} is invalid.")
        except KeyError:
            raise HelperError("INVALID_RESPONSE", f"Provider segment {index} is invalid.")
        if (
            not text
            or not math.isfinite(start)
            or not math.isfinite(duration)
            or start < 0
            or duration < 0
            or start < previous_start
        ):
            raise HelperError("INVALID_RESPONSE", f"Provider segment {index} is invalid.")
        previous_start = start
        output.append(
            {
                "text": text,
                "start": round(start, 3),
                "duration": round(duration, 3),
                "language": language,
            }
        )
    if not output:
        raise HelperError("EMPTY_TRANSCRIPT", "Provider returned no usable segments.")
    return output


def fetch_with_youtube_transcript_api(request: dict[str, Any]) -> dict[str, Any]:
    try:
        import requests  # type: ignore[import-not-found]
        from youtube_transcript_api import YouTubeTranscriptApi  # type: ignore[import-not-found]
    except ImportError as error:
        raise HelperError(
            "DEPENDENCY_MISSING",
            "Install the isolated local-helper requirements before a live run.",
            503,
        ) from error

    class TimeoutSession(requests.Session):
        def __init__(self) -> None:
            super().__init__()
            self.trust_env = False

        def request(self, method: str, url: str, **kwargs: Any):  # type: ignore[no-untyped-def]
            kwargs.setdefault("timeout", 15)
            return super().request(method, url, **kwargs)

    api = YouTubeTranscriptApi(http_client=TimeoutSession())
    try:
        tracks = list(api.list(request["videoId"]))
        language = (request.get("preferredLanguage") or "").lower()
        requested_kind = request["trackKind"]

        def matches(track: Any, kind: str) -> bool:
            language_match = not language or track.language_code.lower().split("-")[0] == language.split("-")[0]
            kind_match = kind == "any" or bool(track.is_generated) == (kind == "asr")
            return language_match and kind_match

        ordered_kinds = (
            ["manual", "asr"]
            if requested_kind == "manual-first"
            else [requested_kind]
        )
        selected = next(
            (
                track
                for kind in ordered_kinds
                for track in tracks
                if matches(track, kind)
            ),
            None,
        )
        if selected is None:
            if not tracks:
                raise HelperError("NO_TRANSCRIPT", "YouTube returned no caption tracks.", 404)
            raise HelperError(
                "TRACK_UNAVAILABLE",
                "Requested language or track kind was unavailable.",
                404,
            )
        fetched = selected.fetch()
        rows = [item.to_raw_data() for item in fetched]
        selected_language = str(selected.language_code or "") or None
        segments = normalize_segments(rows, selected_language)
        return {
            "ok": True,
            "schemaVersion": SCHEMA_VERSION,
            "segments": segments,
            "language": selected_language,
            "selectedTrack": {
                "language": selected_language,
                "kind": "asr" if selected.is_generated else "manual",
            },
        }
    except HelperError:
        raise
    except Exception as error:  # provider exception names vary across versions
        name = type(error).__name__
        combined = f"{name} {error}".lower()
        if "too many" in combined or "429" in combined or "rate" in combined:
            raise HelperError("RATE_LIMITED", "YouTube rate limited the local helper.", 429) from error
        if "disabled" in combined or "no transcript" in combined:
            raise HelperError("NO_TRANSCRIPT", "YouTube returned no transcript.", 404) from error
        if "unavailable" in combined or "not playable" in combined:
            raise HelperError("VIDEO_UNAVAILABLE", "YouTube video was unavailable.", 404) from error
        raise HelperError("HELPER_UNAVAILABLE", "Local helper provider failed.", 502) from error


def process_request(
    payload: Any,
    provider: Callable[[dict[str, Any]], dict[str, Any]] = fetch_with_youtube_transcript_api,
) -> dict[str, Any]:
    request = validate_request(payload)
    result = provider(request)
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise HelperError("INVALID_RESPONSE", "Local helper provider returned an invalid result.", 502)
    return {
        **result,
        "schemaVersion": SCHEMA_VERSION,
        "providerId": "local-helper",
        "providerVariant": "youtube-transcript-api",
        "runId": request["runId"],
        "requestId": request["requestId"],
        "videoId": request["videoId"],
    }


def disabled_live_provider(_request: dict[str, Any]) -> dict[str, Any]:
    raise HelperError(
        "PROVIDER_UNAVAILABLE",
        "Live transcript access is disabled; restart with --allow-live for a user-authorized test.",
        503,
    )


def make_handler(
    token: str,
    extension_origin: str,
    provider: Callable[[dict[str, Any]], dict[str, Any]] = fetch_with_youtube_transcript_api,
):
    pairing_token = validate_pairing_token(token)
    allowed_origin = validate_extension_origin(extension_origin)

    class Handler(BaseHTTPRequestHandler):
        server_version = "DigestDockTranscriptHelper/0.1"

        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def _cors_allowed(self) -> bool:
            return self.headers.get("Origin") == allowed_origin

        def _send(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            if len(body) > MAX_RESPONSE_BYTES:
                status = 500
                body = json.dumps(
                    {
                        "ok": False,
                        "errorCode": "INVALID_RESPONSE",
                        "message": "Local helper response exceeded the size limit.",
                    }
                ).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if self._cors_allowed():
                self.send_header("Access-Control-Allow-Origin", allowed_origin)
                self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib handler contract
            if not self._cors_allowed():
                self._send(403, {"ok": False, "errorCode": "HELPER_UNAUTHORIZED"})
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", allowed_origin)
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers",
                "Content-Type, X-DigestDock-Helper-Token",
            )
            self.send_header("Access-Control-Max-Age", "300")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler contract
            if self.path != "/health" or not self._cors_allowed():
                self._send(403, {"ok": False, "errorCode": "HELPER_UNAUTHORIZED"})
                return
            if self.headers.get("X-DigestDock-Helper-Token") != pairing_token:
                self._send(401, {"ok": False, "errorCode": "HELPER_UNAUTHORIZED"})
                return
            self._send(
                200,
                {
                    "ok": True,
                    "schemaVersion": SCHEMA_VERSION,
                    "providerId": "local-helper",
                    "providerVariant": "youtube-transcript-api",
                    "networkRequests": 0,
                },
            )

        def do_POST(self) -> None:  # noqa: N802 - stdlib handler contract
            if self.path != "/v1/transcript" or not self._cors_allowed():
                self._send(403, {"ok": False, "errorCode": "HELPER_UNAUTHORIZED"})
                return
            if self.headers.get("X-DigestDock-Helper-Token") != pairing_token:
                self._send(401, {"ok": False, "errorCode": "HELPER_UNAUTHORIZED"})
                return
            if self.headers.get_content_type() != "application/json":
                self._send(415, {"ok": False, "errorCode": "INVALID_RESPONSE"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_REQUEST_BYTES:
                self._send(413, {"ok": False, "errorCode": "INVALID_RESPONSE"})
                return
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                response = process_request(payload, provider)
                self._send(200, response)
            except HelperError as error:
                self._send(
                    error.status,
                    {"ok": False, "errorCode": error.code, "message": str(error)},
                )
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send(400, {"ok": False, "errorCode": "INVALID_RESPONSE"})

    return Handler


def run_stdio(allow_live: bool = False) -> int:
    provider = fetch_with_youtube_transcript_api if allow_live else disabled_live_provider
    for line in sys.stdin:
        try:
            payload = json.loads(line)
            output = process_request(payload, provider)
        except HelperError as error:
            output = {"ok": False, "errorCode": error.code, "message": str(error)}
        except json.JSONDecodeError:
            output = {"ok": False, "errorCode": "INVALID_RESPONSE"}
        print(json.dumps(output, ensure_ascii=False), flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stdio", action="store_true")
    parser.add_argument("--allow-live", action="store_true")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if args.stdio:
        return run_stdio(args.allow_live)
    token = os.environ.get("DIGESTDOCK_TRANSCRIPT_HELPER_TOKEN", "")
    origin = os.environ.get("DIGESTDOCK_TRANSCRIPT_HELPER_ORIGIN", "")
    try:
        provider = fetch_with_youtube_transcript_api if args.allow_live else disabled_live_provider
        handler = make_handler(token, origin, provider)
    except HelperError as error:
        print(f"Cannot start helper: {error.code}: {error}", file=sys.stderr)
        return 2
    server = HTTPServer(("127.0.0.1", args.port), handler)
    print(f"Transcript helper listening on 127.0.0.1:{args.port} for one fixed extension origin.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
