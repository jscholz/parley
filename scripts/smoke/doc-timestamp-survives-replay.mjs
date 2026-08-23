// Doc shelf timestamps must mean "time since the agent DISPLAYED the
// doc" — one server clock, constant across devices and across SSE ring
// replays (field bug 2026-07-08: every boot/reconnect replayed the ring's
// doc_show envelopes and the client re-stamped them with Date.now(), so
// docs pushed hours earlier reset to "0s ago" each morning).
//
// Contract under test:
//   1. A doc_show envelope carrying `displayed_at` (server epoch ms)
//      renders that time — NOT the client's receipt time.
//   2. A ring replay (`_replay: true`, same envelope) leaves the stamp
//      untouched AND does not light the unread dot (nothing is new).
//   3. Old-backend fallback (no displayed_at): a byte-identical re-push
//      keeps the prior stamp; only genuinely new content moves the clock.

import { waitForReady } from './lib.mjs';

export const NAME = 'doc-timestamp-survives-replay';
export const DESCRIPTION = 'Doc timestamps come from the server displayed_at and survive SSE ring replay';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-doc-ts-chat';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Doc timestamp chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_docts_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  const HOUR = 3_600_000;
  const displayedAt = Date.now() - HOUR;   // the agent displayed it 1h ago
  const envelope = {
    type: 'doc_show', chat_id: CHAT_ID,
    title: 'Build report', content: '# Report\n\nTS-MARK', format: 'markdown',
    path: '/w/build-report.md',
    displayed_at: displayedAt,
  };

  // 1. Server-clock rendering: pushed now, displayed 1h ago → "1h ago".
  mock.pushEnvelope(envelope);
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('TS-MARK'),
    null, { timeout: 6000, polling: 50 },
  );
  const meta1 = await page.evaluate(
    () => document.querySelector('.doc-drawer-meta')?.textContent,
  );
  if (meta1 !== '1h ago') {
    throw new Error(`reader meta must show the SERVER display time (1h ago), got: ${meta1}`);
  }
  log('reader shows server displayed_at (1h ago), not client receipt time');

  // 2. Ring replay of the SAME envelope (what boot/reconnect does):
  //    stamp unchanged, unread dot stays dark.
  mock.pushEnvelope({ ...envelope, _replay: true });
  await new Promise(r => setTimeout(r, 300));   // let the event land
  const meta2 = await page.evaluate(
    () => document.querySelector('.doc-drawer-meta')?.textContent,
  );
  if (meta2 !== '1h ago') {
    throw new Error(`ring replay must not reset the stamp — got: ${meta2}`);
  }
  const dotOn = await page.evaluate(
    () => document.getElementById('doc-drawer-dot-rail')?.hidden === false,
  );
  if (dotOn) throw new Error('replay of unchanged content must not light the unread dot');
  log('ring replay: stamp intact, no false unread dot');

  // 3. Old-backend fallback: no displayed_at at all. First push stamps
  //    with receipt time; an identical re-push must KEEP that stamp
  //    (replay-proof even without the field)…
  const legacy = {
    type: 'doc_show', chat_id: CHAT_ID,
    title: 'Legacy doc', content: 'LEGACY-V1', format: 'text',
    path: '/w/legacy.txt',
  };
  mock.pushEnvelope(legacy);
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content, #doc-drawer-body .doc-drawer-plain')?.textContent?.includes('LEGACY-V1'),
    null, { timeout: 6000, polling: 50 },
  );
  const stamp1 = await page.evaluate(() => {
    const raw = localStorage.getItem('parley.docs.v2');
    const d = JSON.parse(raw).docs.find(x => x.path === '/w/legacy.txt');
    return d?.updatedAt;
  });
  await new Promise(r => setTimeout(r, 1200));
  mock.pushEnvelope({ ...legacy, _replay: true });
  await new Promise(r => setTimeout(r, 300));
  const stamp2 = await page.evaluate(() => {
    const raw = localStorage.getItem('parley.docs.v2');
    const d = JSON.parse(raw).docs.find(x => x.path === '/w/legacy.txt');
    return d?.updatedAt;
  });
  if (stamp2 !== stamp1) {
    throw new Error(`identical legacy re-push must keep the stamp: ${stamp1} → ${stamp2}`);
  }
  log('legacy fallback: identical re-push keeps the stamp');

  // …4. while genuinely NEW content moves the clock forward.
  mock.pushEnvelope({ ...legacy, content: 'LEGACY-V2' });
  await page.waitForFunction(
    () => document.querySelector('#doc-drawer-body .doc-drawer-content, #doc-drawer-body .doc-drawer-plain')?.textContent?.includes('LEGACY-V2'),
    null, { timeout: 6000, polling: 50 },
  );
  const stamp3 = await page.evaluate(() => {
    const raw = localStorage.getItem('parley.docs.v2');
    const d = JSON.parse(raw).docs.find(x => x.path === '/w/legacy.txt');
    return d?.updatedAt;
  });
  if (!(stamp3 > stamp2)) {
    throw new Error(`new content must advance the stamp: ${stamp2} → ${stamp3}`);
  }
  log('new content advances the stamp');
}
