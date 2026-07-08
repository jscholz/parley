// Durable-uploader contract (capture plan §3.2, Phase 1 gate): a
// network outage mid-meeting must lose ZERO audio. Segments persist to
// IDB before their first upload attempt; the serial uploader backs off
// through the outage and drains exactly-once when the server returns.
//
// Timeline (compressed vs the plan's 90s — the uploader's backoff is
// what's under test, not wall-clock):
//   start capture → outage ON (mock 503s segments) → recorder keeps
//   sealing → outage OFF → stop → every segment acked exactly once,
//   IDB buffer drained, capture complete.

import { waitForReady } from './lib.mjs';

export const NAME = 'capture-segments-survive-outage';
export const DESCRIPTION = 'Capture uploader: IDB-buffered segments survive a server outage and drain exactly-once on recovery';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-capture-outage-chat';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Outage chat',
    messages: [{ role: 'user', content: 'seed', sidekick_id: 'umsg_cap_outage', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // Start capture via the mic menu.
  await page.evaluate(() => {
    const menu = document.getElementById('mic-mode-menu');
    if (menu) { menu.hidden = false; menu.setAttribute('aria-hidden', 'false'); }
    document.getElementById('mic-menu-record-meeting')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForFunction(
    () => !document.getElementById('capture-pill')?.hidden,
    null, { timeout: 8000, polling: 50 },
  );
  log('capture started');

  // Outage begins IMMEDIATELY — every segment sealed from here on
  // buffers in IDB and gets 503s on upload.
  mock.setCaptureOutage(true);

  // Record a few seconds, then STOP while the outage is still on: the
  // stop-flow seal (same seal+persist+kick path as the 45s timer)
  // pushes the segment into IDB and the uploader starts eating 503s.
  await new Promise((r) => setTimeout(r, 3000));
  await page.click('#capture-pill-stop');

  // Mid-outage: uploader is retrying with backoff; nothing may ack,
  // and the durable copy must be sitting in IDB.
  await new Promise((r) => setTimeout(r, 2500));
  const ackedDuringOutage = mock.getCaptures()[0]?.segments?.length ?? 0;
  if (ackedDuringOutage !== 0) {
    throw new Error(`segments acked during outage: ${ackedDuringOutage} (503s should refuse them)`);
  }
  const buffered = await page.evaluate(async () => {
    const mod = await import('/build/capture/segmentStore.mjs');
    return (await mod.listPending()).length;
  });
  if (buffered < 1) throw new Error('sealed segment not found in the IDB buffer during outage');
  log(`outage: server refused everything; ${buffered} segment(s) held durably in IDB`);

  // Recovery — the uploader's next backoff retry drains the buffer and
  // the stop flow completes.
  mock.setCaptureOutage(false);
  await page.waitForFunction(
    () => document.getElementById('capture-pill')?.hidden,
    null, { timeout: 25_000, polling: 100 },
  );

  const cap = mock.getCaptures()[0];
  if (cap.status !== 'complete') throw new Error(`capture should be complete, got ${cap.status}`);
  if (!cap.segments.length) throw new Error('recovery produced zero uploaded segments');
  // Exactly-once: seqs unique.
  const seqs = cap.segments.map((s) => s.seq);
  if (new Set(seqs).size !== seqs.length) {
    throw new Error(`duplicate seq acks after recovery: ${JSON.stringify(seqs)}`);
  }
  // IDB buffer fully drained.
  const pending = await page.evaluate(async () => {
    const mod = await import('/build/capture/segmentStore.mjs');
    return (await mod.listPending()).length;
  });
  if (pending !== 0) throw new Error(`IDB buffer not drained: ${pending} pending`);
  log(`recovery: ${cap.segments.length} segment(s) acked exactly once, buffer drained`);
}
