// Field 2026-10-23: "just got a spoken message without asking for it —
// '👁️ Hindsight — recalled 44 memories'". The playback audit showed a
// pointer-down on that bubble's play bar. Hindsight's recall/retain
// indicators are persisted by hermes as ordinary assistant messages, so
// they rendered as full agent bubbles with a play button and bar. Now
// they are status notes: no play button, no play bar, not a media-key
// skip target — while a real reply right after keeps all of it.

import { waitForReady, assert, openSidebar, clickRow } from './lib.mjs';

export const NAME = 'status-note-not-speakable';
export const DESCRIPTION = 'Hindsight recall notes render without play controls and are skipped by reply navigation; real replies keep theirs';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-status-note-chat';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 120;
  mock.addChat(CHAT_ID, {
    title: 'Dinner w/ Seref',
    lastActiveAt: Date.now() - 1000,
    messages: [
      { role: 'user', content: 'Are you up for making that change now?', parley_id: 'umsg_sn_1', timestamp: t0 },
      // Persisted exactly as hermes stores it: a plain assistant row.
      { role: 'assistant', content: '👁️ Hindsight — recalled 44 memories', parley_id: 'msg_sn_recall', timestamp: t0 + 1 },
      { role: 'assistant', content: 'Yes — I can make that change now. Give me a minute.', parley_id: 'msg_sn_reply', timestamp: t0 + 60 },
    ],
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(() => document.querySelectorAll('#transcript .line.agent').length >= 2, null, { timeout: 8000, polling: 50 });
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#transcript .line.agent')).map((l) => ({
    text: (l.dataset.text || l.textContent || '').slice(0, 40),
    statusNote: l.classList.contains('status-note'),
    playBtn: !!l.querySelector('.play-btn'),
    playBar: !!l.querySelector('.play-bar'),
  })));
  const note = rows.find((r) => /Hindsight/.test(r.text));
  const reply = rows.find((r) => /make that change/.test(r.text));
  assert(note, `recall note must render as a line (${JSON.stringify(rows)})`);
  assert(note.statusNote && !note.playBtn && !note.playBar, `recall note must carry no playback controls: ${JSON.stringify(note)}`);
  assert(reply && !reply.statusNote && reply.playBtn && reply.playBar, `a real reply keeps its controls: ${JSON.stringify(reply)}`);
  log('history: recall note has no play button/bar; real reply does ✓');

  // Live: the same note arriving as a reply_final renders the same way.
  mock.pushEnvelope({ type: 'reply_final', chat_id: CHAT_ID, message_id: 'msg_sn_live', text: '👁️ Hindsight — recalled 12 memories' });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#transcript .line.agent')).some((l) => /recalled 12/.test(l.textContent || '')), null, { timeout: 6000, polling: 50 });
  const live = await page.evaluate(() => {
    const l = Array.from(document.querySelectorAll('#transcript .line.agent')).find((x) => /recalled 12/.test(x.textContent || ''));
    return { statusNote: l.classList.contains('status-note'), playBtn: !!l.querySelector('.play-btn'), playBar: !!l.querySelector('.play-bar') };
  });
  assert(live.statusNote && !live.playBtn && !live.playBar, `live recall note must carry no playback controls: ${JSON.stringify(live)}`);
  log('live: recall note has no play button/bar ✓');

  // Navigation never lands on a note: the navigator's candidate list
  // excludes status notes.
  const candidates = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line.agent:not(.status-note)')).map((l) => (l.dataset.text || '').slice(0, 30)));
  assert(candidates.length === 1 && /make that change/.test(candidates[0]), `only the real reply is a skip target: ${JSON.stringify(candidates)}`);
  log('navigation candidates exclude the note ✓');
}
