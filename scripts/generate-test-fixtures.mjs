#!/usr/bin/env node
// Regenerate the audio fixtures used by the barge smokes. Idempotent —
// safe to re-run; overwrites the WAVs in test/fixtures/audio/.
//
// Outputs (16 kHz mono signed-int16 PCM WAV — the format audio-bridge's
// fixture-replay TTS provider and the chromium mic-injection helper
// both consume directly):
//
//   test/fixtures/audio/agent-counts-1-10.wav  — agent voice (Aura
//                                                Thalia) saying "1, 2,
//                                                3, 4, 5, 6, 7, 8, 9,
//                                                10". Used as the
//                                                replayed TTS reply
//                                                from the mock bridge.
//   test/fixtures/audio/user-says-stop.wav     — a non-agent voice (Aura
//                                                Zeus) saying "stop".
//                                                Used as the user-speaks
//                                                signal in the
//                                                speech-during-TTS
//                                                scenario.
//   test/fixtures/audio/silence-5s.wav         — 5 s of digital silence.
//                                                Used as the mic input
//                                                in the silence-during-
//                                                TTS scenario (asserts
//                                                no self-barge).
//
// Source voices come from the live parley proxy on localhost:3001 via
// the existing /tts endpoint, so we get exactly the same Deepgram Aura
// voices that ship in production. Cached to fixtures so the smokes
// don't depend on network or Deepgram credentials.

import { writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const FIXTURE_DIR = join(REPO_ROOT, 'test/fixtures/audio');
const PROXY_URL = process.env.PARLEY_PROXY_URL || process.env.PARLEY_PROXY_URL || 'http://localhost:3001';

const FIXTURES = [
  {
    out: 'agent-counts-1-10.wav',
    text: '1, 2, 3, 4, 5, 6, 7, 8, 9, 10.',
    model: 'aura-2-thalia-en',  // matches DEFAULT_TTS_MODEL in production
  },
  {
    out: 'user-says-stop.wav',
    text: 'stop.',
    model: 'aura-2-zeus-en',     // different voice, contrasts with agent
  },
];

async function fetchTts(text, model) {
  const r = await fetch(`${PROXY_URL}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, model }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`/tts ${r.status}: ${err.slice(0, 200)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

function mp3ToWav(mp3Path, wavPath) {
  // 16 kHz mono signed-int16 PCM — what the bridge's PCMTrack expects
  // (see audio-bridge/providers/tts.py docstring) and what Silero VAD
  // wants. -y to overwrite.
  execSync(
    `ffmpeg -y -i "${mp3Path}" -ar 16000 -ac 1 -sample_fmt s16 -f wav "${wavPath}"`,
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
}

function generateSilence(wavPath, seconds) {
  execSync(
    `ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000" ` +
    `-t ${seconds} -sample_fmt s16 "${wavPath}"`,
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
}

const tmpDir = '/tmp/parley-fixture-gen';
execSync(`mkdir -p "${tmpDir}"`);

for (const f of FIXTURES) {
  const mp3 = join(tmpDir, f.out.replace('.wav', '.mp3'));
  const wav = join(FIXTURE_DIR, f.out);
  console.log(`fetching ${f.text.slice(0, 30)}… (${f.model}) → ${f.out}`);
  const mp3Bytes = await fetchTts(f.text, f.model);
  writeFileSync(mp3, mp3Bytes);
  mp3ToWav(mp3, wav);
  const size = execSync(`stat -c %s "${wav}"`).toString().trim();
  console.log(`  ✓ ${wav} (${size} bytes)`);
}

const silenceOut = join(FIXTURE_DIR, 'silence-5s.wav');
console.log(`generating 5 s silence → silence-5s.wav`);
generateSilence(silenceOut, 5);
const silenceSize = execSync(`stat -c %s "${silenceOut}"`).toString().trim();
console.log(`  ✓ ${silenceOut} (${silenceSize} bytes)`);

console.log('\nDone. Commit test/fixtures/audio/ to ship.');
