/**
 * @fileoverview VadSource selection for the unified BargeDetector.
 *
 * `chooseVadStrategy()` returns 'bridge' by default everywhere, with
 * per-user / per-call overrides via URL param `?vad=client|bridge` and
 * the localStorage-backed call-mode-menu setting (Auto / Client / Bridge).
 *
 * History:
 *   - The original default was per-device (iOS=client, others=bridge),
 *     driven by client-side Silero working on iOS and Mac client-side
 *     ONNX cold-start being structurally broken
 *     (microsoft/onnxruntime#19177). After confirming bridge-side Silero
 *     fires correctly on real speech without false-firing on AEC residual
 *     at normal volume, the default flipped to bridge everywhere.
 *     ClientSideVadSource stays compiled in as an escape hatch.
 *   - The override row in the call-mode menu allows A/B comparison
 *     without redeploying.
 */

import { detectDeviceClass } from '../../voiceTuning.ts';
import { ClientSideVadSource, FallbackVadSource, type VadSource } from './vadSource.ts';

/** Floor applied to the user's barge threshold on the built-in
 *  speaker route. CURRENTLY DISABLED (=0) — full slider range remains
 *  tunable. Once AEC residual data is collected at speaker volume, set
 *  this to a positive value (likely 0.5-0.7 based on residual research)
 *  and re-enable the clamp. The wiring + tests remain so flipping the
 *  constant is a one-line change. */
export const SPEAKER_BARGE_THRESHOLD_FLOOR = 0;

export type VadStrategy = 'client' | 'bridge';

/** UI-facing setting value: 'auto' means defer to per-route default. */
export type VadStrategySetting = 'auto' | VadStrategy;

/** localStorage key for the user-facing VAD override (call-mode menu's
 *  Auto / Client / Bridge row). Persistent so iOS-installed PWAs survive
 *  reloads — the URL ?vad= override is unreachable inside an installed
 *  PWA because the browser caches the entry URL. */
const VAD_OVERRIDE_STORAGE_KEY = 'parley_vad_override';

/** Returns the URL-param override if present and valid, else null. */
export function getVadStrategyOverride(): VadStrategy | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('vad');
    if (v === 'client' || v === 'bridge') return v;
  } catch {
    /* SSR / non-browser env */
  }
  return null;
}

/** Read the user-facing VAD-strategy override from localStorage.
 *  Returns 'auto' on missing key / invalid value / read error. */
export function getVadStrategyOverrideSetting(): VadStrategySetting {
  if (typeof localStorage === 'undefined') return 'auto';
  try {
    const v = localStorage.getItem(VAD_OVERRIDE_STORAGE_KEY);
    if (v === 'client' || v === 'bridge') return v;
  } catch { /* deny / SSR */ }
  return 'auto';
}

/** Persist the user-facing VAD-strategy override. 'auto' clears the
 *  override entirely (key removed) so chooseVadStrategy() falls back
 *  to the per-route default. */
export function setVadStrategyOverrideSetting(s: VadStrategySetting): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (s === 'auto') localStorage.removeItem(VAD_OVERRIDE_STORAGE_KEY);
    else localStorage.setItem(VAD_OVERRIDE_STORAGE_KEY, s);
  } catch { /* deny / SSR */ }
}

/** Resolve the active strategy.
 *
 *  Precedence: URL `?vad=` (one-off dev/CI testing) > localStorage
 *  setting (PWA-installed user testing) > default (`bridge` everywhere).
 *
 *  Bridge is the default everywhere: bridge-side Silero fires correctly
 *  on real speech without false-firing on AEC residual. Client path
 *  remains reachable via `?vad=client` as an escape hatch. */
export function chooseVadStrategy(): VadStrategy {
  const urlOverride = getVadStrategyOverride();
  if (urlOverride) return urlOverride;
  const settingOverride = getVadStrategyOverrideSetting();
  if (settingOverride !== 'auto') return settingOverride;
  return 'bridge';
}

/** Construct a VadSource for the active strategy. Optionally pass an
 *  explicit strategy (used by tests + future per-call overrides).
 *
 *  'bridge' returns a FallbackVadSource: it prefers bridge VAD but falls
 *  back to client-side Silero when the bridge reports no server-side VAD
 *  (fresh install with no torch). 'client' forces pure client-side. The
 *  fallback is harmless for a provisioned bridge — it stays on bridge once
 *  the capability handshake confirms availability. */
export function makeVadSource(strategy?: VadStrategy): VadSource {
  const s = strategy ?? chooseVadStrategy();
  return s === 'bridge' ? new FallbackVadSource() : new ClientSideVadSource();
}

/** Compute the effective barge VAD threshold given the user's setting
 *  and the active output route. On the built-in speaker the floor is
 *  enforced (only sensitivities below the floor get clamped); on other
 *  routes the user value passes through unchanged. Pure function for
 *  testability. */
export function effectiveBargeThreshold(
  userThreshold: number,
  onSpeaker: boolean,
): number {
  if (!onSpeaker) return userThreshold;
  return Math.max(userThreshold, SPEAKER_BARGE_THRESHOLD_FLOOR);
}
