const CLIENTS = Object.freeze({
  IOS: {
    name: 'IOS',
    version: '20.10.4',
    header: '5',
    context: {
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      platform: 'MOBILE',
      osName: 'iOS',
      osVersion: '18.3.2.22D82'
    }
  },
  ANDROID_VR: {
    name: 'ANDROID_VR',
    version: '1.62.20',
    header: '28',
    context: {
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      platform: 'MOBILE',
      osName: 'Android',
      osVersion: '12L',
      androidSdkVersion: 32
    }
  },
  MWEB: {
    name: 'MWEB',
    version: '2.20251209.01.00',
    header: '2',
    context: {
      platform: 'MOBILE',
      osName: 'iOS',
      osVersion: '17.5.1'
    }
  }
});

const PLAYER_ENDPOINT = 'https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false';

function round(value) {
  return Math.round(value * 100) / 100;
}

function safeError(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 80),
    message: String(error?.message || error)
      .replace(/https?:\/\/[^\s"')]+/gu, '<redacted-url>')
      .slice(0, 240)
  };
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function timedFetch(input, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Probe timeout', 'TimeoutError')), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(input, {
      ...init,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      durationMs: round(performance.now() - started),
      responseBytes: new TextEncoder().encode(text).byteLength,
      text
    };
  } finally {
    clearTimeout(timer);
  }
}

function pickTrack(tracks, language) {
  return tracks.find((track) => track.vssId === `.${language}`)
    || tracks.find((track) => track.vssId === `a.${language}`)
    || tracks.find((track) => track.languageCode === language)
    || null;
}

function captionSummary(payload) {
  const segments = [];
  for (const event of payload?.events || []) {
    if (!event.segs || event.aAppend === 1) continue;
    const text = event.segs.map((segment) => segment.utf8 || '').join('').replace(/<[^>]+>/gu, '').trim();
    if (text) segments.push(text);
  }
  const canonical = segments.join(' ').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return { segments, canonical };
}

async function probeAttempt(testCase, profileName, timeoutMs) {
  const profile = CLIENTS[profileName];
  const started = performance.now();
  const result = {
    caseId: testCase.id,
    videoId: testCase.videoId,
    requestedLanguage: testCase.language,
    profile: profileName,
    credentialsMode: 'omit',
    apiKeyUsed: false,
    userAgentOrOriginSpoofed: false
  };

  try {
    const player = await timedFetch(PLAYER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'X-YouTube-Client-Name': profile.header,
        'X-YouTube-Client-Version': profile.version
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: profile.name,
            clientVersion: profile.version,
            hl: 'en',
            gl: 'US',
            ...profile.context
          },
          user: { lockedSafetyMode: false },
          request: { useSsl: true }
        },
        videoId: testCase.videoId,
        contentCheckOk: true,
        racyCheckOk: true
      })
    }, timeoutMs);
    result.playerRequest = {
      status: player.status,
      durationMs: player.durationMs,
      responseBytes: player.responseBytes
    };
    if (!player.ok) {
      result.outcome = 'player-http-error';
      return result;
    }

    const data = JSON.parse(player.text);
    result.playabilityStatus = data?.playabilityStatus?.status || null;
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    result.trackCount = tracks.length;
    result.manualTrackCount = tracks.filter((track) => track.kind !== 'asr').length;
    result.asrTrackCount = tracks.filter((track) => track.kind === 'asr').length;
    result.languageCodes = [...new Set(tracks.map((track) => track.languageCode).filter(Boolean))].sort();

    const track = pickTrack(tracks, testCase.language);
    if (!track?.baseUrl) {
      result.outcome = tracks.length === 0 ? 'no-caption' : 'requested-language-unavailable';
      return result;
    }
    result.selectedTrack = {
      languageCode: track.languageCode || null,
      kind: track.kind || 'manual-or-unspecified',
      vssId: track.vssId || null
    };

    const captionUrl = new URL(track.baseUrl);
    captionUrl.searchParams.set('fmt', 'json3');
    const caption = await timedFetch(captionUrl.toString(), { method: 'GET' }, timeoutMs);
    result.timedtextRequest = {
      status: caption.status,
      durationMs: caption.durationMs,
      responseBytes: caption.responseBytes
    };
    if (!caption.ok) {
      result.outcome = 'timedtext-http-error';
      return result;
    }
    if (!caption.text.trim()) {
      result.outcome = 'empty-timedtext';
      result.segmentCount = 0;
      return result;
    }

    const summary = captionSummary(JSON.parse(caption.text));
    result.segmentCount = summary.segments.length;
    result.canonicalCharacterCount = summary.canonical.length;
    result.canonicalContentSha256 = summary.canonical ? await sha256(summary.canonical) : null;
    result.outcome = summary.segments.length > 0 ? 'transcript' : 'empty-timedtext';
    return result;
  } catch (error) {
    result.outcome = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'error';
    result.error = safeError(error);
    return result;
  } finally {
    result.totalDurationMs = round(performance.now() - started);
  }
}

globalThis.runTranscriptProbe = async ({ cases, profiles, timeoutMs }) => {
  const attempts = [];
  for (const testCase of cases) {
    for (const profile of profiles) {
      attempts.push(await probeAttempt(testCase, profile, timeoutMs));
    }
  }
  return {
    runtime: {
      extensionName: chrome.runtime.getManifest().name,
      manifestVersion: chrome.runtime.getManifest().manifest_version,
      hostPermissions: chrome.runtime.getManifest().host_permissions,
      cookiePermissionDeclared: false
    },
    attempts
  };
};
