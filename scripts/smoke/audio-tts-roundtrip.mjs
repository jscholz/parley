// Scenario: text → real audio bytes through the TTS pipe.
//
// PWA → POST /tts { text, model } → proxy forwards to audio-bridge
// /v1/tts → bridge calls Deepgram Aura → mp3 blob returns. The
// turn-based player (src/audio/turn-based/tts.ts) does exactly this
// fetch then plays the blob in #player. This canary proves the
// server half (auth + format + non-empty audio) WITHOUT a browser, so
// the more expensive spoken-turn E2E can assume /tts works and focus
// on the playback wiring.
//
// What this catches that audio-bridge-health doesn't:
//  - Bridge ↔ Deepgram Aura auth (key actually set, not just declared).
//  - /tts returning JSON-error-with-200 instead of audio (the exact
//    shape behind the 2026-05-09 "tap dead, state stuck loading" bug).
//  - Empty / truncated blob (silent playback).
//
// Marked BACKEND='real' — one short Aura synth call. Skip with
// `npm run smoke -- --mocked-only`.

export const NAME = 'audio-tts-roundtrip';
export const DESCRIPTION = '/tts round-trips text through the audio bridge to Deepgram Aura, returning real audio bytes';
export const STATUS = 'install-only';
export const BACKEND = 'real';

const VOICE = 'aura-2-thalia-en';

// mp3 (ID3 or MPEG frame sync 0xFFEx) or WAV (RIFF) — accept either so
// we don't break if the bridge's container default changes.
function looksLikeAudio(buf) {
  if (buf.length < 4) return false;
  const b = buf;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true;          // "ID3"
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true;                   // MPEG frame sync
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return true; // "RIFF"
  return false;
}

export default async function run({ url, log }) {
  const target = `${url.replace(/\/+$/, '')}/tts`;
  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hello from the parley smoke test.', model: VOICE }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`/tts fetch failed: ${e?.message ?? e}`);
  }
  if (!res.ok) {
    throw new Error(`/tts HTTP ${res.status}`);
  }

  const ctype = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  log(`/tts → ${buf.length} bytes, content-type "${ctype}"`);

  // The 2026-05-09 bug returned a JSON error body with a 200 — guard it.
  if (ctype.includes('application/json')) {
    throw new Error(`/tts returned JSON (not audio): ${buf.toString('utf8').slice(0, 240)}`);
  }
  if (buf.length < 512) {
    throw new Error(`/tts blob suspiciously small (${buf.length} bytes) — likely empty/truncated synth`);
  }
  if (!looksLikeAudio(buf)) {
    throw new Error(`/tts blob is not recognizable audio (first bytes: ${buf.subarray(0, 8).toString('hex')})`);
  }
  log(`/tts OK; ${buf.length} bytes of audio (model ${VOICE})`);
}
