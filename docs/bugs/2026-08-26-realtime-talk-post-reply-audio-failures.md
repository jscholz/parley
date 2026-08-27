# Field bug: Realtime Talk stops accepting audio after assistant replies

**Reported:** 2026-08-26, approximately 16:15–16:23 BST  
**Surface:** Parley native Capacitor client, Realtime **Talk** mode  
**Severity:** High — breaks hands-free conversation after nearly every assistant turn  
**Status:** Reproduced repeatedly in the field; root cause unknown  
**Safety constraint:** Diagnose first. Do not make broad audio-state changes. Only ship a narrowly scoped fix with a focused regression test and verified build.

## Summary

While cycling with a hands-free Parley Talk session, the user observed two closely related failures after assistant TTS replies:

1. **Post-reply input wedge:** when assistant playback ends, Parley appears to return to listening, but subsequent user speech does not stream/transcribe. The user has to re-enter or restart the call before speech works again.
2. **Spontaneous call termination:** the call sometimes appears to hang up or leave the active-call state without the user pressing the hang-up button. Bridge logs confirm at least one unsolicited data-channel/ICE close followed by a new Talk peer being created.

These may share one root cause, but keep them separate during diagnosis: a session can remain visually alive while the post-TTS capture path is wedged, whereas another path appears to close the peer entirely.

This is **Realtime Talk/WebRTC**, not turn-based Listen. The field bridge logs show `offer-received mode=talk`. Do not begin in `src/audio/turn-based/turnbased.ts` unless later evidence points there.

## User reports

First report after reconnecting:

> “What happened? It seems like it hung up. If that happens again without me pressing the hang up button, I'm gonna ask you to investigate.”

Second report after the next assistant response:

> “Okay. It happened again. I think every time you reply, some state gets flipped; it doesn't stream from me anymore. Might be some blocked or wedged barge mechanism.”

The “barge mechanism” wording is a hypothesis, not an established cause. The reliable observation is: **assistant reply completes → user speaks again → audio no longer reaches the conversation, or the call has ended, despite no explicit hang-up.**

The failure repeated across consecutive turns during the same ride.

## Reproduction

Environment details not yet confirmed beyond the native Capacitor origin and Realtime Talk bridge route. Confirm the exact device, OS version and app build during diagnosis.

1. Open Parley’s native Capacitor client.
2. Start a voice call with Realtime enabled and spoken replies enabled, producing `mode=talk` at the bridge.
3. Speak a normal or long user turn and let it dispatch.
4. Wait for the assistant’s TTS reply to finish naturally.
5. Without tapping the microphone or restarting the call, begin speaking the next turn.
6. Observe one of two failures:
   - the call still looks active/listening, but no live transcript or user turn arrives; or
   - the call appears to hang up and must be opened again.
7. Reopen the call. Speech works again until the next assistant reply, after which the failure recurs.

## Expected behavior

After every assistant TTS reply:

- the same WebRTC peer remains connected;
- the outbound mic track remains live and enabled;
- any client-side TTS suppression/barge gate is released;
- the bridge resumes forwarding mic audio into STT;
- the client receives an honest `listening` state;
- the next user utterance streams/transcribes without another tap or call restart.

## Actual behavior

The bridge can log that TTS ended and STT resumed, while the user still cannot get the next utterance through. In another observed cycle, the peer’s data channel and ICE connection close without an intentional hang-up, and the client creates a new peer only after the user reopens/reconnects.

## Correlated server evidence

Relevant logs are in the user journal for `parley-audio.service` and `parley.service` on Galatea.

### Clean-looking TTS → STT transition, followed by peer close

For peer `2bc84609…`:

- `16:20:21` — TTS bridge logs `reply round complete` (`frames_fed=4028`, `first_pcm=True`).
- `16:20:26` — barge policy logs `tts window ended`, `fired=False`.
- `16:20:26` — STT bridge logs `resuming mic→Deepgram (TTS done)`.
- `16:20:26` — STT bridge logs `announced listening (dc open)`.
- `16:20:53` — data channel closes.
- `16:20:53` — ICE and peer connection transition to `closed`.
- `16:20:53` — Parley stream subscriber exits.
- `16:20:57` — a new Talk peer, `45886518…`, is offered and accepted after the user reconnects.

This sequence is important: the server-side state machine believes it resumed correctly. The missing evidence is whether the client mic sender continued producing RTP and whether the client itself initiated the close.

### User-visible recurrence

- `16:18:47` — Parley proxy receives the first field report saying the call appeared to hang up without a button press.
- `16:23:15` — Parley proxy receives the second field report: “Okay. It happened again,” followed by the post-reply streaming/state-flip description.

### Confound to exclude

At `16:27:25`, a separate Claude job running from Fontbrain explicitly restarted `hermes-gateway.service`. That restart interrupted the live session later and must **not** be treated as evidence for the earlier 16:18–16:23 failures. The earlier failures and peer close predate the gateway restart.

### Possibly relevant but not yet causal

At `16:20:05`, Deepgram Aura logged an incomplete transfer payload error:

`Response payload is not completed: TransferEncodingError: Not enough data to satisfy transfer length header.`

A later TTS round still completed. Treat this as a separate signal until proven connected; the user’s primary complaint was the capture/call state after playback, not missing TTS audio.

## Investigation targets

Start with the Realtime Talk path and correlate one turn across client and bridge:

- `src/audio/realtime/realtime.ts`
- Realtime call controls/connection lifecycle and any reply-final or playback-ended handlers
- `src/audio/realtime/suppress.ts`
- `src/audio/shared/session.ts`
- `src/audio/shared/ios-specific.ts`
- `src/voiceController.ts`
- `audio-bridge/stt_bridge.py`
- `audio-bridge/tts_bridge.py`
- `audio-bridge/barge_policy.py`
- `audio-bridge/signaling.py`

At assistant TTS end, log or inspect all of the following on the **client** before accepting the bridge’s `listening` announcement as proof of recovery:

1. `RTCPeerConnection.connectionState`, `iceConnectionState` and signaling state.
2. Data-channel `readyState`.
3. Outbound `RTCRtpSender.track`: identity, `enabled`, `muted`, and `readyState`.
4. Whether outbound RTP `bytesSent` continues increasing after TTS ends and while the user speaks.
5. Every suppression/barge/TTS flag before and after the playback-end callback.
6. The exact caller and reason for `close()`, `closeIfOpen()`, peer teardown, or mic release.
7. Whether a `listening` envelope is ignored, applied to stale peer state, or immediately overwritten by another transition.
8. Native/Capacitor audio-session category before TTS, during TTS, and after TTS.

On the **bridge**, verify that “resuming mic→Deepgram” means actual audio frames resume, not merely that a Boolean gate was cleared. Log first post-TTS inbound RTP/audio frame and first post-TTS frame forwarded to Deepgram, keyed by peer and reply round.

## Working hypotheses — not conclusions

- A client capture/suppression flag is not released after TTS, even though the bridge’s corresponding gate is released.
- The client retains a nominally live mic track that has stopped producing RTP after the native audio-session category changes for playback.
- A playback-ended or reply-final handler closes/replaces the peer or releases capture as part of a stale state transition.
- The bridge announces `listening` before confirming post-TTS audio frames, creating a false healthy state.
- A stale callback from the previous reply/peer overwrites the newly resumed state.
- Capacitor/native lifecycle or route handling ends the data channel after playback.
- Recent Sidekick→Parley migration/deployment exposed a stale-shell/module mismatch. The examined rename commits made little intentional audio-state change, so do not assume the rename itself is causal without evidence.

## Acceptance criteria

1. In native Realtime Talk mode, complete at least five consecutive user → assistant-TTS → user cycles without tapping the call control between turns.
2. Every post-TTS user utterance produces fresh outbound RTP, reaches bridge STT, and appears as a user turn.
3. The data channel and peer remain connected unless the user explicitly hangs up or the network genuinely fails.
4. If the transport does fail, the UI must not claim to be listening; recovery must either reconnect automatically or present an honest reconnect state.
5. Add a focused regression test/smoke covering the identified state transition. Do not rely only on unit assertions that a Boolean changed; verify frame/track or transport behavior at the relevant seam.
6. Run the focused smoke, typecheck, and the relevant audio test set. Record the real outputs.
7. Verify on the affected native device before calling the bug fixed.

## Change-safety notes

- The working tree currently contains unrelated Docs/right-drawer changes. Do not overwrite, reset, stash or fold those into the audio fix.
- Avoid broad rewrites of the audio state machine.
- Do not restart the live Hermes gateway while an active Parley turn is running unless explicitly coordinated.
- If device evidence is insufficient, add diagnostics first and ask for one controlled reproduction rather than guessing at a patch.
