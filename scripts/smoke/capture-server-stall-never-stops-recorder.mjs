// The server's stall verdict is information, never an order (2026-11-16).
//
// Incident: the LocalGlobe meeting. The phone went to the background for
// three minutes, uploads paused, the server flagged a stall (a FALSE
// alarm — the recorder was fine, the audio was waiting to upload). When
// the phone woke, the client asked the server for its verdict, saw
// `stalled_since`, flipped itself to 'interrupted', and the next segment
// seal refused to chain in that state. The recorder was dead for the
// remaining 39 minutes while the mic light stayed on and the pill said
// "Reconnecting…".
//
// Now the orchestrator obeys only TERMINAL verdicts (failed / discarded /
// complete) and a stall flag — or a stale-heal, which is the server
// giving up waiting, not a verdict on the meeting — leaves the engine
// exactly as it was: recording, with a live recorder.
import { waitForReady, assert, pollUntil } from './lib.mjs';

export const NAME = 'capture-server-stall-never-stops-recorder';
export const DESCRIPTION = 'a server stall flag / stale-heal reconciled on resume leaves the recorder recording (2026-11-16 regression)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:capture-stall-verdict';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, {
    title: 'Stall verdict chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'seed-1', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 60_000,
  });
}

const snapshot = (page) => page.evaluate(async () => {
  const mod = await import('/build/capture/recorder.mjs');
  const st = mod.getCaptureState();
  const h = mod.getEngineHealth() || {};
  return { active: st.active, phase: st.phase, engine: st.engine, recorder: h.recorder_state, engineState: h.engine_state, sealed: st.sealedSegments };
});

async function reconcile(page, id, kind) {
  // Both reconcile triggers the orchestrator wires: the capture_changed
  // envelope naming our id, and the visibility resume.
  await page.evaluate(({ cid, k }) => {
    window.dispatchEvent(new CustomEvent('parley:capture-changed-remote', {
      detail: { kind: k, capture: { id: cid, status: 'recording' } },
    }));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, { cid: id, k: kind });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  const id = await page.evaluate(async () => {
    const mod = await import('/build/capture/recorder.mjs');
    const st = await mod.startMeetingCapture({ linkedChat: 'new' });
    return st.captureId;
  });
  assert(id, 'capture should have started');
  await pollUntil(page, async () => {
    const mod = await import('/build/capture/recorder.mjs');
    return mod.getCaptureState().registered === true;
  }, undefined, { label: 'capture registered with the (mock) server' });
  const before = await snapshot(page);
  assert(before.active && before.phase === 'recording' && before.recorder === 'recording',
    `recording before the verdict (${JSON.stringify(before)})`);

  // ── 1. The false alarm: status recording + stalled_since ──
  mock.setCaptureStatus(id, 'recording', { stalled_since: Date.now() - 120_000 });
  await reconcile(page, id, 'stalled');
  await page.waitForTimeout(600);   // long enough for the GET to land and be (not) obeyed
  const afterStall = await snapshot(page);
  assert(afterStall.active && afterStall.phase === 'recording' && afterStall.recorder === 'recording' && afterStall.engineState === 'recording',
    `a stall flag must not touch the recorder (${JSON.stringify(afterStall)})`);
  log('stall flag reconciled → still recording, recorder live ✓');

  // ── 2. The stale-heal: complete + healed_by_sweep ──
  mock.setCaptureStatus(id, 'complete', { healed_by_sweep: true, stalled_since: null });
  await reconcile(page, id, 'stopped');
  await page.waitForTimeout(600);
  const afterHeal = await snapshot(page);
  assert(afterHeal.active && afterHeal.phase === 'recording' && afterHeal.recorder === 'recording',
    `a stale-heal is the server giving up waiting, not a verdict — keep recording (${JSON.stringify(afterHeal)})`);
  log('stale-heal reconciled → still recording ✓');

  // ── 3. A TERMINAL verdict still stands the recorder down ──
  mock.setCaptureStatus(id, 'discarded', { healed_by_sweep: false });
  await reconcile(page, id, 'discarded');
  await pollUntil(page, async () => {
    const mod = await import('/build/capture/recorder.mjs');
    return mod.getCaptureState().active === false;
  }, undefined, { label: 'a discard elsewhere stands the recorder down' });
  const after = await snapshot(page);
  assert(after.phase === 'failed' && after.recorder === 'none', `terminal verdict → failed pill, recorder released (${JSON.stringify(after)})`);
  log('terminal verdict still obeyed ✓');
}
