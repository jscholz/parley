/**
 * Shared helpers for the barge smoke rig.
 *
 * The rig orchestrates four processes:
 *   - stub agent on port 4022 (mock hermes; AGENT_LLM=fixed)
 *   - audio-bridge on port 8650 (fixture TTS; noop STT)
 *   - sidekick proxy on port 3022 (points at the above)
 *   - chromium (playwright)
 *
 * All on 127.0.0.1, no Tailscale, no real Deepgram. End-to-end audio
 * flows through real WebRTC; only the upstream synthesis is mocked.
 *
 * Public API:
 *   bootRig({ wavPath, deepgramKey? })  — start services, return URLs + cleanup
 *   injectMic(page, micWavPath)          — replace getUserMedia with a fixture
 *                                          WAV stream (looped); call before goto
 *   countBargeFires(page)                — count [barge-detector] fire events
 *                                          in the in-page log buffer
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

export const PORTS = {
  stub: 4022,
  bridge: 8650,
  proxy: 3022,
};

export const PROXY_URL = `http://127.0.0.1:${PORTS.proxy}`;

/** Wait up to `timeoutMs` for a TCP port to accept a connection. */
async function waitForPort(port, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await tryConnect(port)) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`port ${port} not ready after ${timeoutMs}ms`);
}
function tryConnect(port) {
  return new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => { sock.end(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

/** Boot stub agent + audio-bridge + sidekick proxy with smoke env.
 *  Resolves once all three are ready. Returns a teardown fn. */
export async function bootRig({ wavPath }) {
  if (!wavPath) throw new Error('bootRig requires wavPath (TTS fixture)');
  const absWav = resolve(wavPath);

  const procs = [];
  function spawnLogged(name, cmd, args, env, cwd) {
    const p = spawn(cmd, args, {
      env: { ...process.env, ...env },
      cwd: cwd || REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout.on('data', d => process.stdout.write(`[${name}] ${d}`));
    p.stderr.on('data', d => process.stderr.write(`[${name}] ${d}`));
    p.on('exit', code => {
      if (code !== 0 && code !== null) console.error(`[${name}] exited ${code}`);
    });
    procs.push({ name, proc: p });
    return p;
  }

  // 1. Stub agent (mock hermes) — fixed-reply LLM matching the WAV.
  spawnLogged('stub', 'node', ['backends/stub/bin/start.mjs'], {
    AGENT_HOST: '127.0.0.1',
    AGENT_PORT: String(PORTS.stub),
    AGENT_LLM: 'fixed',
    AGENT_LLM_FIXED_REPLY: '1, 2, 3, 4, 5, 6, 7, 8, 9, 10.',
    AGENT_DATA_DIR: '/tmp/sidekick-smoke-barge-stub',
  });
  await waitForPort(PORTS.stub);

  // 2. Audio-bridge — fixture TTS, noop STT.
  const bridgePython = resolve(REPO_ROOT, 'audio-bridge/.venv/bin/python');
  spawnLogged('bridge', bridgePython, ['bridge.py'], {
    PARLEY_AUDIO_HOST: '127.0.0.1',
    PARLEY_AUDIO_PORT: String(PORTS.bridge),
    PARLEY_AUDIO_TTS_PROVIDER: 'fixture',
    PARLEY_AUDIO_TTS_WAV_PATH: absWav,
    PARLEY_AUDIO_STT_PROVIDER: 'noop',
    PARLEY_PROXY_URL: PROXY_URL,
    PARLEY_AUDIO_LOG_FILE: '',
  }, resolve(REPO_ROOT, 'audio-bridge'));
  await waitForPort(PORTS.bridge);

  // 3. Sidekick proxy — points at the stub + bridge above.
  //
  // The proxy reads frontend settings (realtime, tts, etc.) from a
  // yaml file. The smoke needs realtime=true so the call button opens
  // a WebRTC peer (the path the iOS self-barge bug lives in), and
  // tts=true so the bridge is asked to TTS the reply (where the
  // fixture provider replays our pre-recorded WAV). Write a tiny
  // smoke-mode yaml and point the proxy at it.
  const smokeConfigPath = '/tmp/sidekick-smoke-barge-config.yaml';
  mkdirSync(dirname(smokeConfigPath), { recursive: true });
  // Ports + provider come from env; the yaml carries the FRONTEND
  // settings the smoke needs (realtime mode, TTS-on-call, default
  // bargeVadThreshold which scenarios can override per-test).
  writeFileSync(smokeConfigPath,
    'frontend:\n' +
    '  composer:\n' +
    '    realtime: true\n' +
    '  streaming:\n' +
    '    tts: true\n' +
    '  interaction:\n' +
    '    bargeIn: true\n' +
    '    bargeVadThreshold: 0.5\n');
  spawnLogged('proxy', 'node',
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server.ts'],
    {
      PORT: String(PORTS.proxy),
      PARLEY_PLATFORM_URL: `http://127.0.0.1:${PORTS.stub}`,
      PARLEY_PLATFORM_TOKEN: '',
      PARLEY_AUDIO_BRIDGE_URL: `http://127.0.0.1:${PORTS.bridge}`,
      PARLEY_CONFIG: smokeConfigPath,
    });
  await waitForPort(PORTS.proxy);

  return async function teardown() {
    for (const { name, proc } of procs.reverse()) {
      try { proc.kill('SIGTERM'); } catch {}
    }
    // Give them a beat to exit cleanly.
    await new Promise(r => setTimeout(r, 500));
    for (const { proc } of procs) {
      try { if (!proc.killed) proc.kill('SIGKILL'); } catch {}
    }
  };
}

/** Replace `navigator.mediaDevices.getUserMedia` with a stream sourced
 *  from a fixture WAV (looped). Call BEFORE page.goto so the override
 *  beats any production code that captures a reference at module load.
 *
 *  The injected stream produces real PCM frames on a real
 *  MediaStreamAudioDestinationNode, so WebRTC's encoder, our
 *  BargeDetector's Silero VAD, and the AudioContext-based AnalyserNodes
 *  all see normal audio — same as if the user had a microphone. The
 *  `track.getSettings()` won't report echoCancellation: this is a
 *  synthetic capture path, not a real mic, so AEC engagement isn't
 *  testable here. (See docs/BARGE.md for what this rig can/can't catch.) */
export async function injectMic(page, micWavPath) {
  const bytes = readFileSync(micWavPath);
  const b64 = bytes.toString('base64');
  await page.addInitScript(({ b64 }) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const wavBuffer = buf.buffer.slice(0);

    if (!navigator.mediaDevices) (navigator).mediaDevices = {};
    const Original = navigator.mediaDevices.getUserMedia?.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async (_constraints) => {
      // Fresh AudioContext per call — production code may getUserMedia
      // multiple times across a session (mic acquisition + release
      // cycles). Each call gets its own loop so we don't share buffer-
      // source-node state across tracks.
      const Ctx = (window.AudioContext || window.webkitAudioContext);
      const ctx = new Ctx({ sampleRate: 16000 });
      const ab = await ctx.decodeAudioData(wavBuffer.slice(0));
      const src = ctx.createBufferSource();
      src.buffer = ab;
      src.loop = true;
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest);
      src.start();
      return dest.stream;
    };
  }, { b64 });
}

/** Attach a node-side log buffer to a playwright page. The PWA's
 *  src/util/log.ts emits via console.log('[dbg]', …) and the browser's
 *  page.on('console') event catches every such call regardless of
 *  whether the page reassigns its own console proxies. Returns helpers
 *  bound to the buffer so scenarios can poll for specific lines. */
export function attachLogCapture(page) {
  const lines = [];
  page.on('console', msg => {
    try { lines.push(msg.text()); } catch {}
  });
  return {
    all: () => lines.slice(),
    matching: (re) => lines.filter(l => re.test(l)),
    count: (re) => lines.filter(l => re.test(l)).length,
    /** Resolve once `regex` matches any captured line (or reject after
     *  `timeoutMs`). Polls every 100 ms — cheap, no event hookery. */
    waitFor: async (regex, timeoutMs = 30_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (lines.some(l => regex.test(l))) return;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error(`waitFor: pattern not seen in ${timeoutMs}ms: ${regex}`);
    },
  };
}

export const FIXTURE_DIR = resolve(REPO_ROOT, 'test/fixtures/audio');
export const FIXTURES = {
  agentCounts: join(FIXTURE_DIR, 'agent-counts-1-10.wav'),
  userStop: join(FIXTURE_DIR, 'user-says-stop.wav'),
  silence: join(FIXTURE_DIR, 'silence-5s.wav'),
};
