const test = require("node:test");
const assert = require("node:assert/strict");

const youtube = require("../youtube-transcript.js");

test("core stops on HTTP 429 before reading an oversized or unreadable body", async () => {
  let calls = 0;
  let bodyReads = 0;
  const adapter = youtube.create({
    clients: youtube.CLIENT_PROFILES.slice(0, 2),
    timeoutMs: 0,
    maxResponseBytes: 10,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => name === "content-length" ? "999" : null },
        text: async () => {
          bodyReads += 1;
          throw new Error("429 body must not be read");
        },
      };
    },
  });

  await assert.rejects(
    adapter.fetchTranscript("jNQXAC9IVRw"),
    (error) => error.code === "RATE_LIMITED" && error.status === 429,
  );
  assert.equal(calls, 1);
  assert.equal(bodyReads, 0);
});

test("core stops on timedtext HTTP 429 before reading its body", async () => {
  let calls = 0;
  let bodyReads = 0;
  const adapter = youtube.create({
    clients: youtube.CLIENT_PROFILES.slice(0, 1),
    timeoutMs: 0,
    maxResponseBytes: 1024,
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).includes("/youtubei/v1/player")) {
        const body = JSON.stringify({
          playabilityStatus: { status: "OK" },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  languageCode: "en",
                  vssId: ".en",
                  baseUrl:
                    "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw",
                },
              ],
            },
          },
        });
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => body,
        };
      }
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => name === "content-length" ? "9999" : null },
        text: async () => {
          bodyReads += 1;
          throw new Error("429 body must not be read");
        },
      };
    },
  });

  await assert.rejects(
    adapter.fetchTranscript("jNQXAC9IVRw", {
      preferredLanguage: "en",
      kind: "manual",
    }),
    (error) => error.code === "RATE_LIMITED" && error.status === 429,
  );
  assert.equal(calls, 2);
  assert.equal(bodyReads, 0);
});
