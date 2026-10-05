// Offline-first meeting mode (field ask 2026-10-05: "record arbitrarily
// long audio without an internet connection that syncs when it's ready").
//
// Before: startMeetingCapture POSTed /captures BEFORE touching the mic,
// so with no network nothing ever recorded. Now the recorder mints the
// capture id, records immediately, and the uploader registers the
// capture (create → activate) when the network returns, drains the
// buffered segments behind it and posts the deferred /stop.
//
// Timeline: network OFF → start capture (must go live; pill says so) →
// record → STOP while still offline (pill finishes; ledger owes a stop)
// → network ON → create, activate, every segment, stop land in that
// order on the server; IDB buffer + ledger are empty afterwards.

import { waitForReady, pollUntil } from './lib.mjs';

export const NAME = 'capture-offline-start-syncs-later';
export const DESCRIPTION = 'Meeting capture starts with no network, buffers locally, and syncs create→segments→stop when the network returns';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-capture-offline-chat';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Offline room',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_cap_offline', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // The room has no network before the meeting even starts.
  mock.setCaptureOffline(true);

  await page.evaluate(() => {
    const menu = document.getElementById('mic-mode-menu');
    if (menu) { menu.hidden = false; menu.setAttribute('aria-hidden', 'false'); }
    document.getElementById('mic-menu-record-meeting')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }));
  });
  // The capture must go LIVE without the server: the pill leaves
  // 'starting' on the strength of mic + MediaRecorder alone.
  await page.waitForFunction(
    () => {
      const pill = document.getElementById('capture-pill');
      return !!(pill && !pill.hidden && !pill.classList.contains('starting'));
    },
    null, { timeout: 8000, polling: 50 },
  );
  const live = await page.evaluate(async () => {
    const mod = await import('/build/capture/recorder.mjs');
    const s = mod.getCaptureState();
    return { active: s.active, phase: s.phase, registered: s.registered, captureId: s.captureId };
  });
  if (!live.active || live.phase !== 'recording') throw new Error(`capture not recording offline: ${JSON.stringify(live)}`);
  if (live.registered) throw new Error('capture claims to be registered with a server it cannot reach');
  if (!/^cap_[0-9]+_[0-9a-f]{6}$/.test(live.captureId || '')) throw new Error(`client-minted id has the wrong shape: ${live.captureId}`);
  if (mock.getCaptures().length !== 0) throw new Error('server saw a create while offline');
  log(`offline: recording live as ${live.captureId}, server untouched`);

  // The pill tells the truth once the first upload attempt fails.
  await page.waitForFunction(
    () => /offline/i.test(document.getElementById('capture-pill-state')?.textContent || ''),
    null, { timeout: 12_000, polling: 100 },
  );
  log('pill: "Offline — saving locally"');

  // Record a little, then stop WHILE STILL OFFLINE.
  await new Promise((r) => setTimeout(r, 2500));
  await page.click('#capture-pill-stop');
  // Finishing is UI-capped at 15s; the pill may stay up ("Offline — will
  // sync") or hide — either way the ledger must now owe a stop and the
  // audio must be in IDB.
  await new Promise((r) => setTimeout(r, 1500));
  const parked = await page.evaluate(async () => {
    const mod = await import('/build/capture/segmentStore.mjs');
    const ledger = await mod.listLedger();
    return { pending: (await mod.listPending()).length, ledger: ledger.map((e) => ({ id: e.id, registered: e.registered, stopRequested: e.stopRequested })) };
  });
  if (parked.pending < 1) throw new Error('no segment buffered in IDB after an offline stop');
  if (parked.ledger.length !== 1 || parked.ledger[0].id !== live.captureId) throw new Error(`ledger wrong: ${JSON.stringify(parked.ledger)}`);
  if (parked.ledger[0].registered || !parked.ledger[0].stopRequested) throw new Error(`ledger state wrong: ${JSON.stringify(parked.ledger[0])}`);
  if (mock.getCaptures().length !== 0) throw new Error('server saw traffic while offline');
  log(`stopped offline: ${parked.pending} segment(s) + a deferred stop held durably`);

  // Back in coverage. The uploader's backoff retry (or the `online`
  // event — fire it, as a real device would) syncs everything.
  mock.setCaptureOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await pollUntil(page, async () => {
    const mod = await import('/build/capture/segmentStore.mjs');
    return (await mod.listPending()).length === 0 && (await mod.listLedger()).length === 0;
  }, undefined, { timeout: 30_000, polling: 200, label: 'buffer + ledger did not drain after reconnect' });
  // The server side settles a beat after the client's last ack.
  const ts = Date.now();
  while (Date.now() - ts < 5000 && mock.getCaptures()[0]?.status !== 'complete') await new Promise((r) => setTimeout(r, 100));

  const caps = mock.getCaptures();
  if (caps.length !== 1) throw new Error(`expected exactly one server capture, got ${caps.length}`);
  const cap = caps[0];
  if (cap.id !== live.captureId) throw new Error(`server adopted a different id: ${cap.id} vs ${live.captureId}`);
  if (cap.status !== 'complete') throw new Error(`capture should be complete after the deferred stop, got ${cap.status}`);
  if (!cap.segments.length) throw new Error('no segments reached the server after reconnect');
  // Started from the composer mic menu → linked to the chat on screen
  // (placement semantics), carried through the offline create.
  if (cap.linked_chat !== CHAT_ID || cap.minted_session) {
    throw new Error(`linked chat not carried through the offline create: ${JSON.stringify({ chat: cap.linked_chat, minted: cap.minted_session })}`);
  }
  const order = mock.getCaptureLifecycle().filter((e) => e.id === cap.id).map((e) => e.action);
  const want = ['create', 'activate', 'stop'];
  const got = order.filter((a) => want.includes(a));
  if (got.join(',') !== want.join(',')) throw new Error(`lifecycle order wrong: ${JSON.stringify(order)}`);
  log(`synced: create → activate → ${cap.segments.length} segment(s) → stop, buffer + ledger empty`);
}
