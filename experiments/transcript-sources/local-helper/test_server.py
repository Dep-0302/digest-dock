import importlib.util
import http.client
import json
import pathlib
import threading
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("local_helper_server", MODULE_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(SERVER)


class LocalHelperContractTests(unittest.TestCase):
    def valid_request(self):
        return {
            "schemaVersion": 1,
            "requestId": "fixture-1",
            "providerId": "local-helper",
            "providerVariant": "youtube-transcript-api",
            "runId": "fixture-run",
            "videoId": "jNQXAC9IVRw",
            "preferredLanguage": "en-US",
            "trackKind": "manual-first",
        }

    def test_validates_and_normalizes_request(self):
        request = SERVER.validate_request(self.valid_request())
        self.assertEqual(request["videoId"], "jNQXAC9IVRw")
        self.assertEqual(request["preferredLanguage"], "en-US")

    def test_rejects_unknown_fields_and_bad_versions(self):
        payload = self.valid_request()
        payload["url"] = "https://example.test/private"
        with self.assertRaises(SERVER.HelperError) as context:
            SERVER.validate_request(payload)
        self.assertEqual(context.exception.code, "INVALID_RESPONSE")

        payload = self.valid_request()
        payload["schemaVersion"] = 2
        with self.assertRaises(SERVER.HelperError) as context:
            SERVER.validate_request(payload)
        self.assertEqual(context.exception.code, "HELPER_VERSION_MISMATCH")

    def test_normalizes_fixture_segments_without_importing_live_dependencies(self):
        rows = [
            {"text": "First", "start": 0, "duration": 1.5},
            {"text": " Second ", "start": 2, "duration": 1},
        ]
        result = SERVER.normalize_segments(rows, "en")
        self.assertEqual([segment["text"] for segment in result], ["First", "Second"])

        with self.assertRaises(SERVER.HelperError):
            SERVER.normalize_segments(list(reversed(rows)), "en")
        with self.assertRaises(SERVER.HelperError):
            SERVER.normalize_segments(
                [{"text": "bad", "start": float("nan"), "duration": 1}],
                "en",
            )

    def test_process_request_accepts_an_injected_fixture_provider(self):
        def fixture_provider(request):
            self.assertEqual(request["providerId"], "local-helper")
            return {
                "ok": True,
                "schemaVersion": 1,
                "segments": [{"text": "Fixture", "start": 0, "duration": 1}],
                "language": "en",
            }

        result = SERVER.process_request(self.valid_request(), fixture_provider)
        self.assertTrue(result["ok"])
        self.assertEqual(result["runId"], "fixture-run")
        self.assertEqual(result["videoId"], "jNQXAC9IVRw")

    def test_pairing_and_origin_are_exact(self):
        self.assertEqual(
            SERVER.validate_pairing_token("x" * 32),
            "x" * 32,
        )
        with self.assertRaises(SERVER.HelperError):
            SERVER.validate_pairing_token("short")
        self.assertEqual(
            SERVER.validate_extension_origin("chrome-extension://" + "a" * 32),
            "chrome-extension://" + "a" * 32,
        )
        with self.assertRaises(SERVER.HelperError):
            SERVER.validate_extension_origin("*")


class LocalHelperHttpTests(unittest.TestCase):
    token = "x" * 32
    origin = "chrome-extension://" + "a" * 32

    def setUp(self):
        def fixture_provider(_request):
            return {
                "ok": True,
                "schemaVersion": 1,
                "segments": [
                    {"text": "Fixture", "start": 0, "duration": 1, "language": "en"}
                ],
                "language": "en",
                "selectedTrack": {"language": "en", "kind": "manual"},
            }

        handler = SERVER.make_handler(self.token, self.origin, fixture_provider)
        self.httpd = SERVER.HTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)

    def payload(self):
        return {
            "schemaVersion": 1,
            "requestId": "fixture-request",
            "runId": "fixture-run",
            "providerId": "local-helper",
            "providerVariant": "youtube-transcript-api",
            "videoId": "jNQXAC9IVRw",
            "preferredLanguage": "en",
            "trackKind": "manual-first",
        }

    def post(self, *, token=None, origin=None):
        body = json.dumps(self.payload()).encode("utf-8")
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.httpd.server_port, timeout=2
        )
        connection.request(
            "POST",
            "/v1/transcript",
            body=body,
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
                "Origin": origin if origin is not None else self.origin,
                "X-DigestDock-Helper-Token": token if token is not None else self.token,
            },
        )
        response = connection.getresponse()
        payload = json.loads(response.read().decode("utf-8"))
        connection.close()
        return response.status, payload

    def test_loopback_http_accepts_exact_origin_and_token(self):
        status, payload = self.post()
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["segments"][0]["text"], "Fixture")

    def test_loopback_http_rejects_wrong_origin_or_token(self):
        status, payload = self.post(origin="chrome-extension://" + "b" * 32)
        self.assertEqual(status, 403)
        self.assertEqual(payload["errorCode"], "HELPER_UNAUTHORIZED")

        status, payload = self.post(token="y" * 32)
        self.assertEqual(status, 401)
        self.assertEqual(payload["errorCode"], "HELPER_UNAUTHORIZED")

    def test_health_is_authenticated_and_performs_no_provider_request(self):
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.httpd.server_port, timeout=2
        )
        connection.request(
            "GET",
            "/health",
            headers={
                "Origin": self.origin,
                "X-DigestDock-Helper-Token": self.token,
            },
        )
        response = connection.getresponse()
        payload = json.loads(response.read().decode("utf-8"))
        connection.close()
        self.assertEqual(response.status, 200)
        self.assertEqual(payload["networkRequests"], 0)



if __name__ == "__main__":
    unittest.main()
