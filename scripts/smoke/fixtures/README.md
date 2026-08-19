# Smoke fixtures

Inputs the smoke runner reads at runtime. Small + checked in so
the tests are reproducible and don't need to phone home for setup.

## Files

| File | Used by | Notes |
|---|---|---|
| `hello-parley.wav` | `audio-transcribe-roundtrip` | 16-bit mono 16kHz WAV (Aura `aura-2-thalia-en`). Says "hello parley". ~66KB. |
| `turn-prompt.wav` | `spoken-turn-tts` (mocked + real) | Spoken question "Tell me a short fun fact about the ocean." Drives a full turn. ~68KB. |
| `barge-speech.wav` | `realtime-barge-real` | ~8s sustained counting — used to trigger VAD speech-active for barge. ~245KB. |
| `reply-tts.wav` | mocked playback smokes | Real Aura 16-bit PCM WAV, stubbed into `/tts` so the `<audio>` element decodes (duration>0) + plays without Deepgram. PCM, not mp3, because Playwright's Chromium lacks the mp3 codec. ~164KB. |
| `manifest.mjs` | all of the above | Maps each WAV to its ground-truth transcript + expect substring. Lets mocked smokes stub `/transcribe`/`/tts` from versioned text — no DG key needed. |

The WAV transcripts in `manifest.mjs` are captured by transcribing each
file back through Deepgram, so they match what the STT pipe actually
emits (not the input text — Deepgram normalizes, e.g. counting → digits).

## Regenerating

WAV inputs (16-bit linear16 for `--use-file-for-fake-audio-capture`):

```bash
DK="$DEEPGRAM_API_KEY"
curl -s -X POST \
  "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=16000&container=wav" \
  -H "Authorization: Token $DK" -H "Content-Type: application/json" \
  -d '{"text":"hello parley"}' \
  -o scripts/smoke/fixtures/hello-parley.wav
```

The WAV reply fixture (PCM so Playwright's Chromium decodes it):

```bash
curl -s -X POST \
  "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=16000&container=wav" \
  -H "Authorization: Token $DK" -H "Content-Type: application/json" \
  -d '{"text":"Here is a short fun fact about the ocean. It covers most of the planet."}' \
  -o scripts/smoke/fixtures/reply-tts.wav
```

After regenerating any WAV, re-capture its ground truth and update
`manifest.mjs`:

```bash
curl -s -X POST "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true" \
  -H "Authorization: Token $DK" -H "Content-Type: audio/wav" \
  --data-binary @scripts/smoke/fixtures/<file>.wav | jq -r '.results.channels[0].alternatives[0].transcript'
```
