# Contributing to Parley

Thanks for wanting to contribute.

## Dev setup

```bash
npm install
cp .env.example .env    # fill in DEEPGRAM_API_KEY, and backend-specific vars
npm test
npm run typecheck
npm start
```

Open `http://localhost:3001`. If you don't have an agent backend running, most of the UI still loads — the backend-status pill just stays red.

### System deps

The hermes parley plugin (`backends/hermes/plugin/`) shells out to
`pdftoppm` (poppler-utils) when a PDF attachment arrives, so the
hermes host needs poppler installed. Without it the plugin logs an
error and drops the PDF; the rest of the turn proceeds.

```bash
# Debian / Ubuntu / Raspberry Pi OS
sudo apt install poppler-utils
# macOS
brew install poppler
```

Knobs (`~/.hermes/.env`): `PARLEY_PDF_DPI` (150),
`PARLEY_PDF_MAX_PAGES` (50), `PARLEY_PDF_RASTERIZE_TIMEOUT_S` (30),
`PARLEY_PDF_MAX_BYTES` (20 MiB). See
`docs/archive/PDF_RASTERIZATION_PROPOSAL.md` for design notes.

## Tests

Parley has **five** gates, not one. A change is "green" only when the ones
it can plausibly touch have actually been run — and a gate you skipped is
reported as skipped, never folded into a pass:

```
npm test                  # node unit suite — *.test.ts under test/, src/, proxy/
npm run typecheck         # tsc --noEmit over TypeScript sources
npm run smoke:isolated    # Playwright scenarios (see "Smoke tests" below)
pytest backends/hermes/plugin/tests   # hermes plugin — needs the venv hermes is installed into
pytest audio-bridge/tests             # STT/TTS bridge
```

The two Python suites are easy to forget because `npm test` says nothing
about them: the plugin owns push dispatch, unread counts, the transcript
read paths and chat migration, and the bridge owns the whole voice path.
Neither has any overlap with the node suite. Run them from the repo root
with an interpreter that has `pytest` — usually the venv you installed
hermes into, since the plugin imports gateway modules that `conftest.py`
stubs.

A repo-root `pytest.ini` blocks pytest plugins that arrive from an ambient
`PYTHONPATH` rather than this repo's environment. Don't remove it: on a
workstation that also sources a ROS 2 setup, ROS's seven `pytest11`
plugins autoload into these suites and either hook log capture (producing
failures that look like real ones) or abort collection outright. If some
*other* toolchain leaks in, prefer `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` over
extending the blocklist — these suites need no third-party pytest plugin.

Source is TypeScript compiled to `.mjs` via esbuild (`scripts/build.mjs`) — the
browser loads the compiled output, no runtime bundler.

### Test layout convention

Generic / backend-agnostic tests live in `test/`:
- `markdown.test.ts`, `validate.test.ts`, `pipeline.test.ts` (card pipeline)
- `commit-word.test.ts`, `voice-interim-promote.test.ts` (voice state machines)
- `tts-clean.test.ts`, `fallback.test.ts`, `sessionFilter.test.ts`

Backend-specific tests are co-located with the proxy module under
`proxy/parley/__tests__/` (`proxy.test.ts` + harness, `settings.test.ts`).
A fork swapping hermes for another backend deletes
`proxy/parley/` + `backends/hermes/plugin/` and loses no tests
elsewhere.

UX tests (browser-DOM scenarios) belong in `test/` because they test the
PWA shell, not a backend. See `docs/UX_TEST_PLAN.md` for the proposed
Tier 1/2/3 test plan and which seams are worth pinning.

### Test-writing principles

- **Test the seam, not the symptom.** When a bug reproduces, write the
  test at the lowest layer where the misbehavior is observable. The
  proxy contract suite was written this way: 8 tests pin contract
  invariants (orphan-list filtering, chat_id-tagged SSE, atomic
  delete) so any future regression has a name.
- **Hermetic by default.** Tests for the proxy or any backend
  abstraction MUST run without a live hermes / network / LLM. The
  `proxy/parley/__tests__/proxy-harness.ts` pattern (mock upstream
  + scratch state) is the template — copy it for new backends.
- **UX tests should never depend on a specific backend.** If a UX test
  fails one way against hermes-gateway and another way against
  another backend, the test is wrong. Use the mock backend
  (`scripts/smoke/mock-backend.mjs`) by default; real-backend runs are
  on-demand when touching adjacent code.

### When extending the proxy contract

The agent-side wire format lives in `docs/ABSTRACT_AGENT_PROTOCOL.md`
(the `/v1/*` surface that the proxy speaks to upstream agents). If you
change any of the `/api/parley/*` HTTP+SSE surface or the upstream
agent contract:
1. Update `docs/ABSTRACT_AGENT_PROTOCOL.md` if the upstream contract
   shifted.
2. Add a contract test under `proxy/parley/__tests__/proxy.test.ts`
   that pins the new behavior.
3. Run the suite (`npm test -- proxy/parley/__tests__/proxy.test.ts`)
   before committing.

### Diagnostic recipes (when a UX bug repros)

Triage at the right layer FIRST. If `curl` reproduces the bug, it's
the proxy or downstream; if only the PWA repros, it's the PWA.

```bash
# Watch one chat's live envelope stream
curl -N "http://127.0.0.1:3001/api/parley/stream?chat_id=$CHAT"

# Drawer source-of-truth (should match state.db)
curl http://127.0.0.1:3001/api/parley/sessions | jq

# state.db ground truth
sqlite3 ~/.hermes/state.db \
  "SELECT id, title, message_count FROM sessions WHERE source='parley' ORDER BY started_at DESC LIMIT 20"

# Drive a turn from CLI (no PWA needed)
curl -X POST http://127.0.0.1:3001/api/parley/messages \
  -H 'content-type: application/json' \
  -d '{"chat_id":"test-cli","text":"hi"}'

# Run the proxy contract suite
npm test -- proxy/parley/__tests__/proxy.test.ts
```

### Smoke tests (Playwright)

**Run them with `npm run smoke:isolated`.** It picks a free port, starts a
server on a throwaway `PARLEY_HOME` seeded with a deployment config, runs
the suite against that, and tears the whole thing down — including on
Ctrl-C and on crash. Flags and name filters pass straight through:

```
npm run smoke:isolated                        # whole suite
npm run smoke:isolated -- drill-window-cache  # one scenario
npm run smoke:isolated -- --mocked-only       # skip BACKEND='real'
```

Three things this protects you from, all of which have already cost real
time:

**Never point the suite at the live server.** Scenarios call
`resetServerSettings`, which POSTs to `/api/parley/config/<key>` on
whatever host `SMOKE_URL` names. Aimed at the live proxy that rewrites
the user's actual voice settings — tts, realtime, bargeIn, commitPhrase,
streamingEngine. The runner snapshots and restores them, but that is
best-effort and does not survive a crash or a `kill`. `run-smoke.mjs`
therefore refuses to start unless `/health` reports
`data_home: "isolated"`; a server that doesn't report the sentinel at all
is also refused, because it cannot prove it is a sandbox. Override with
`--allow-live-server` only when you actually mean to drive the live stack
(the `BACKEND='real'` scenarios), and accept that it rewrites settings.

**A sandbox needs a config file.** With no `parley.config.yaml`, every
settings write returns `no parley.config.yaml configured` — and
`resetServerSettings` treats write failures as non-fatal. The suite then
runs on whatever defaults the server booted with, and the damage shows up
much later as a scenario asserting the product is broken when it isn't.
`smoke:isolated` seeds `example.parley.config.yaml` for you; a hand-rolled
server needs `PARLEY_CONFIG` pointed somewhere real.

**No browser means no run — say so.** These need Chromium. If it's
missing, install Playwright's own build (userspace, no sudo):

```
npx playwright install chromium
```

The runner now fails with that instruction instead of a raw
"executable doesn't exist". This matters because a host once ran for five
days with no browser at all, every browser test failed at launch, and the
suite was recorded as green when it had never executed once. **If a suite
did not run, report it as "did not run" — never as passing.**

Scenarios opt into mock or real backend via `BACKEND` export:
- `BACKEND='mocked'` — uses `scripts/smoke/mock-backend.mjs` route
  interception. Fast, hermetic, no chat pollution. **Default for new
  scenarios.**
- `BACKEND='real'` — hits a running hermes. Slower, flakier; reserve
  for cases that genuinely depend on live LLM behavior.
- `BACKEND='either'` — runs against whichever is available.

Override per-run with `--real-backend` to force every scenario through
hermes (used when validating that mock matches reality).

## Code style

- ES modules, native `import` graph, no bundler. Browser loads `build/` directly.
- TypeScript sources under `src/`; JSDoc casts where inference falls short.
- Minimal comments; prefer well-named identifiers. Comments explain *why* not *what*.
- No emoji in committed code unless the feature is explicitly about emoji.

## PR guidelines

- Small, focused PRs.
- Include a short rationale in the description — what's the user-visible effect, and what trade-off does it make.
- Update `sw.js` `CACHE_NAME` if you change any file in the `APP_SHELL` list.
- If you add a new source file under `src/`, add it to `APP_SHELL` too.

## Reporting bugs

Please include:
- Browser + OS + whether you're running as an installed PWA
- The `?debug=1` panel output or `localStorage.parley_debug='1'` log dump covering the failure
- Which backend you're pointing at (hermes, openclaw, openai-compat, zeroclaw) and its version

## Scope

Parley is a voice-first PWA for agent backends. New backends plug in via the
adapter interface — see `src/proxyClientTypes.ts` and the existing adapters in
`src/`. Per-provider quirks (e.g. Deepgram wedge detection) stay in
their provider modules.

## Audio platform — single point rule

All consumer-side audio interactions go through `src/audio/platform.ts`. Do
NOT reach for `new AudioContext`, `navigator.mediaDevices.getUserMedia`,
`createMediaStreamSource`, or `AudioContext.decodeAudioData` directly from
feature code. iOS Safari quirks (gesture-bound context creation, route-stale
rebuild on devicechange, suspended-context behavior, MediaStream exclusivity)
all live in `platform.ts`. New iOS fixes land in ONE function there, not
scattered across modules.

The shim's API:
- `primeAudio(player)` — gesture-bound prime (was iOS audio-unlock); call
  inside a click/touchstart handler.
- `isPrimed()`, `getSharedAudioCtx()`, `onRouteChange(fn)`, `resetAudioCtx()`
- `getMicStream(owner, constraints)`, `releaseMicStream(owner)` — shared
  capture with single-owner mutual exclusion.
- `getMicAnalyser(stream, fftSize)` — analyser node, returns null if the
  platform/stream combo can't yield frames.
- `playChime(name)` — feedback chime playback.
- `decodeAudioBlob(blob)` — one-shot non-realtime decode.

Documented exceptions (audited 2026-05-01):
1. `src/audio/feedback.ts` — implementation file; imports `getAudioCtx`
   directly from `src/ios/audio-unlock.ts` to avoid a circular import with
   the shim. Consumers still use `playChime` from the shim.
2. `src/audio/capture.ts`, `src/ios/audio-unlock.ts` — implementation files
   the shim delegates to. They own the only raw `getUserMedia` /
   `AudioContext` constructions in `src/`.

Grep audit (run before adding new audio code):
```bash
grep -rnE 'new (window\.)?AudioContext|navigator\.mediaDevices\.getUserMedia|createMediaStreamSource' src/ --include='*.ts' \
  | grep -vE 'src/audio/(platform|feedback|capture)\.ts|src/ios/audio-unlock\.ts|src/types/'
```
Should return ZERO hits. Any hit is a regression — route through the
platform shim instead.

Mic-stream owner tags currently in use: `'memo'` (voice memo recording,
browser AEC on), `'webrtc'` (WebRTC peer for talk/stream mode, browser
AEC off — bridge handles AEC server-side). Single-owner: `getMicStream`
throws if another owner currently holds the stream; callers coordinate
via `releaseCaptureIfActive` in `main.ts`.

## License

By contributing you agree that your contributions will be licensed under the
Apache License 2.0 (see `LICENSE`).
