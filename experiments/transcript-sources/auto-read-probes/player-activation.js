(function installProbe(root, factory) {
  const api = factory();
  if (root) root.DIGESTDOCK_PLAYER_ACTIVATION_PROBE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  "use strict";

  function safeTrack(track) {
    if (!track || typeof track !== "object") return null;
    const language = String(track.languageCode || track.language || "")
      .trim()
      .replace(/_/g, "-")
      .slice(0, 35);
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(language)) {
      return null;
    }
    return {
      language,
      kind:
        track.kind === "asr" || /^a\./i.test(String(track.vssId || ""))
          ? "asr"
          : "manual",
    };
  }

  function sameTrack(left, right) {
    const a = safeTrack(left);
    const b = safeTrack(right);
    return Boolean(a && b && a.language === b.language && a.kind === b.kind);
  }

  async function run(request = {}, deps = {}) {
    const expectedVideoId = String(request.videoId || "");
    const selection =
      deps.selection || globalThis.DIGESTDOCK_AUTO_READ_SELECTION;
    const getPlayer =
      deps.getPlayer || (() => document.getElementById("movie_player"));
    const getCcButton =
      deps.getCcButton || (() => document.querySelector(".ytp-subtitles-button"));
    const wait =
      deps.wait ||
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const waitMs = Math.min(3000, Math.max(0, Number(request.waitMs) || 3000));
    const actualVideoId = () => {
      const response = getPlayer()?.getPlayerResponse?.();
      return String(response?.videoDetails?.videoId || "");
    };
    const pressed = () => {
      const value = getCcButton()?.getAttribute?.("aria-pressed");
      return value === "true" ? true : value === "false" ? false : null;
    };
    const currentTrack = () => {
      try {
        return getPlayer()?.getOption?.("captions", "track") || null;
      } catch (_error) {
        return null;
      }
    };

    if (!/^[0-9A-Za-z_-]{11}$/.test(expectedVideoId)) {
      return { status: "INVALID_REQUEST", activated: false };
    }
    const player = getPlayer();
    if (!player || actualVideoId() !== expectedVideoId) {
      return { status: "PAGE_CONTEXT_CHANGED", activated: false };
    }
    const originalPressed = pressed();
    if (originalPressed === null) {
      return { status: "CC_STATE_UNKNOWN", activated: false };
    }
    let options;
    let optionTracks;
    try {
      options = player.getOptions?.("captions") || [];
      optionTracks = player.getOption?.("captions", "tracklist") || [];
    } catch (_error) {
      return { status: "CAPTIONS_MODULE_UNAVAILABLE", activated: false };
    }
    if (
      !Array.isArray(options) ||
      !options.includes("track") ||
      !Array.isArray(optionTracks)
    ) {
      return { status: "CAPTIONS_MODULE_UNAVAILABLE", activated: false };
    }

    const responseTracks =
      player.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer
        ?.captionTracks || [];
    const target = selection?.chooseAutoReadTrack?.(responseTracks);
    if (!target) return { status: "NO_AUTO_TARGET", activated: false };
    const targetTrack =
      optionTracks.find((track) => sameTrack(track, target)) ||
      responseTracks.find((track) => sameTrack(track, target)) ||
      null;
    if (!targetTrack) return { status: "TARGET_NOT_IN_MODULE", activated: false };

    const originalTrack = currentTrack();
    let activated = false;
    let restoreAttempted = false;
    let restoration = "not-needed";
    let activationError = "";
    try {
      player.loadModule?.("captions");
      player.setOption("captions", "track", targetTrack);
      activated = true;
      await wait(waitMs);
    } catch (_error) {
      activationError = "ACTIVATION_FAILED";
    } finally {
      if (activated) {
        if (actualVideoId() !== expectedVideoId) {
          restoration = "identity-changed-noop";
        } else {
          restoreAttempted = true;
          try {
            if (originalPressed) {
              if (!originalTrack) throw new Error("original track unknown");
              player.setOption("captions", "track", originalTrack);
            } else {
              player.setOption("captions", "track", {});
              player.unloadModule?.("captions");
            }
            await wait(50);
            const restoredPressed = pressed();
            const restoredTrack = currentTrack();
            restoration =
              restoredPressed === originalPressed &&
              (!originalPressed || sameTrack(restoredTrack, originalTrack))
                ? "confirmed"
                : "failed";
          } catch (_error) {
            restoration = "failed";
          }
        }
      }
    }

    return {
      status: activationError || (restoration === "failed" ? "RESTORE_FAILED" : "DONE"),
      videoId: expectedVideoId,
      target,
      activated,
      originalPressed,
      restoreAttempted,
      restoration,
    };
  }

  return Object.freeze({ apiVersion: 1, safeTrack, sameTrack, run });
});
