/**
 * @fileoverview Shared handsfree-commit policy used by both audio modes.
 *
 * Both modes need to answer the same question: "is this user utterance
 * done?" Two triggers, identical semantics in both modes:
 *
 *   1. Sendword — utterance ends in a configured phrase (default "over").
 *      The phrase is stripped and what's left dispatches.
 *   2. Silence timeout — N seconds without detected speech ends the
 *      utterance.
 *
 * This module owns the *policy* (regex shape, threshold reading) only.
 * The *mechanism* for detecting speech stays per-mode — turn-based
 * runs an analyser-frame peak loop on the local mic; realtime gets
 * discrete `is_final` text events from the bridge. Different inputs,
 * same policy.
 *
 * See `src/audio/README.md` "Handsfree mechanisms (shared)".
 */

import * as settings from '../../settings.ts';

/** Result of `matchSendword`. `cleaned` is the input with the phrase
 *  + trailing whitespace/punctuation stripped (may be empty when the
 *  utterance was the bare phrase). */
export type SendwordMatch =
  | { matched: false }
  | { matched: true; cleaned: string };

/** Match the configured sendword at end-of-segment.
 *
 *  Regex shape (same as test/commit-word.test.ts canonical reference):
 *    ^(.*)\s*\b<phrase>\b[\s.,!?]*$   /i
 *
 *  Word-boundary anchored (so "moreover" / "takeover" don't false-fire),
 *  end-anchored with optional trailing punctuation, case-insensitive.
 *  The captured prefix is `cleaned` on a match.
 *
 *  Empty `phrase` always returns `{ matched: false }` — sendword
 *  trigger is disabled when the user clears the setting. */
export function matchSendword(text: string, phrase: string): SendwordMatch {
  const p = (phrase || '').trim();
  if (!p) return { matched: false };
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(.*)\\s*\\b${escaped}\\b[\\s.,!?]*$`, 'i');
  const m = (text || '').match(re);
  if (!m) return { matched: false };
  return { matched: true, cleaned: (m[1] || '').trim() };
}

/** Silence-timeout state holder. Just tracks `lastVoiceAt` against a
 *  threshold; the *mechanism* for noticing speech (analyser frame loop
 *  vs. is_final event) and for acting on expiry (poll vs. setTimeout)
 *  stays per-mode.
 *
 *  Both modes were doing this with ad-hoc state on module locals. The
 *  shared class makes the threshold a single read from settings and
 *  drops the duplicate "now - lastVoiceAt > threshold * 1000" math. */
export class SilenceWindow {
  private lastVoiceAt: number;
  private silenceSec: number;

  constructor(silenceSec: number, now: number = Date.now()) {
    this.silenceSec = Math.max(0, silenceSec);
    this.lastVoiceAt = now;
  }

  /** Caller detected speech — bump the clock. */
  noteVoice(now: number = Date.now()): void {
    this.lastVoiceAt = now;
  }

  /** Re-arm with a fresh clock (e.g. after dispatching). Same as
   *  noteVoice but reads better at callsites that aren't reacting to
   *  a speech event. */
  reset(now: number = Date.now()): void {
    this.lastVoiceAt = now;
  }

  /** Update the threshold live (e.g. user moved the silence slider). */
  setThreshold(silenceSec: number): void {
    this.silenceSec = Math.max(0, silenceSec);
  }

  /** Has the silence threshold elapsed since the last detected voice?
   *  silenceSec=0 always returns false (sendword-only mode). */
  expired(now: number = Date.now()): boolean {
    if (this.silenceSec <= 0) return false;
    return (now - this.lastVoiceAt) >= this.silenceSec * 1000;
  }

  /** Diagnostic — milliseconds since last detected voice. */
  msSinceVoice(now: number = Date.now()): number {
    return now - this.lastVoiceAt;
  }
}

/** Resolve canonical handsfree config from the settings module. Single
 *  point of truth — both modes call this rather than reading the keys
 *  directly. The legacy listenSilenceSec / listenSendword keys are
 *  migrated into silenceSec / commitPhrase by settings.load(); this
 *  helper just reads the canonical keys. */
export function getHandsfreeConfig(): {
  silenceSec: number;
  sendwordPhrase: string;
  commitDelaySec: number;
} {
  const s = settings.get();
  return {
    silenceSec: Number((s as any).silenceSec) || 0,
    sendwordPhrase: String(s.commitPhrase || '').trim(),
    // Grace window between hearing the sendword and committing, so a
    // "…over — wait, also" correction still lands in the same turn.
    // 0 = commit instantly. (Decorative-settings audit 2026-08-04: the
    // slider shipped in the initial release, its consumer died with the
    // classic pipeline; both handsfree modes now honor it again.)
    commitDelaySec: Math.max(0, Number((s as any).commitDelaySec) || 0),
  };
}
