// A meeting's transcript is one click away from its chat (2026-10-09:
// "I click back to meeting sessions after closing the meeting notes and
// don't know how to get the transcript back up again").
//
//   1. The header shows "◉ Transcript" in a chat that has a meeting, and
//      NOT in a chat without one.
//   2. With the doc CLOSED (shelf empty), the button rebuilds it from
//      GET /captures/{id}/transcript and opens the reader; the doc shows
//      the capture title (time-suffixed placeholder) and carries the
//      captureId/path identity.
//   3. The "Recording started … transcript.md" notification bubble's path
//      is a #doc: link — clicking it opens the same doc (no twin).
//   4. ✎ in the reader renames the meeting + chat via PATCH rename_session.

import { waitForReady, openSidebar, clickRow, pollUntil, assert } from './lib.mjs';

export const NAME = 'transcript-reopen-from-session';
export const DESCRIPTION = 'Meeting chats get a header Transcript button that reopens a closed transcript; the start notice links to it; ✎ renames meeting + chat';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const MEET_CHAT = 'mock-meeting-chat';
const PLAIN_CHAT = 'mock-plain-chat';
const CAP = 'cap_1759936000000_abc123';
const PATH = `/home/x/.parley/captures/${CAP}/transcript.md`;

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  mock.addChat(MEET_CHAT, {
    title: 'Meeting 2026-10-08',
    messages: [
      { role: 'user', content: 'seed', parley_id: 'umsg_meet_seed', timestamp: t0 },
      { role: 'assistant', content: `📼 Recording "Meeting 2026-10-08" started. Live transcript (updates ~every minute): ${PATH}\n\nYou can read it mid-meeting if I ask about something.`, message_id: 'm-rec-start', timestamp: t0 + 1 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
  mock.addChat(PLAIN_CHAT, {
    title: 'No meeting here',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_plain_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 2000,
  });
  mock.addCapture(MEET_CHAT, {
    id: CAP, title: 'Meeting 2026-10-08 15:03', status: 'complete',
    transcript: '# Meeting 2026-10-08\n\n_Recorded 2026-10-08 15:03 · 1:12:00_\n\n**[+0:00]** REOPEN-MARKER the words of the meeting.',
    transcript_path: PATH,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  // Shelf empty: the user closed everything earlier.
  await page.evaluate(async () => {
    const ds = await import('/build/rightDrawer/docStore.mjs');
    ds.clearDocs();
  });
  await openSidebar(page);

  // 1. plain chat → no button; meeting chat → button
  await clickRow(page, PLAIN_CHAT);
  await page.waitForTimeout(600);
  let btn = await page.$('#header-transcript-btn');
  assert(!btn, 'a chat with no meeting must not show the Transcript button');
  await clickRow(page, MEET_CHAT);
  await pollUntil(page, () => !!document.getElementById('header-transcript-btn'), undefined,
    { timeout: 8_000, label: 'Transcript button did not appear for the meeting chat' });
  const btnInfo = await page.evaluate(() => {
    const b = document.getElementById('header-transcript-btn');
    return { text: b?.textContent, cap: b?.dataset.captureId };
  });
  assert(btnInfo.cap === CAP, `button should target the chat's capture; got ${JSON.stringify(btnInfo)}`);
  assert(/Transcript/.test(btnInfo.text || ''), `button label wrong: ${btnInfo.text}`);
  log('header button present only on the meeting chat ✓');

  // 2. click → doc rebuilt from the server and opened in the reader
  await page.click('#header-transcript-btn');
  await pollUntil(page, async () => {
    const ds = await import('/build/rightDrawer/docStore.mjs');
    const d = ds.currentDoc();
    return !!(d && d.captureId === 'cap_1759936000000_abc123' && /REOPEN-MARKER/.test(d.content));
  }, undefined, { timeout: 8_000, label: 'transcript did not reopen from the server' });
  const opened = await page.evaluate(async () => {
    const ds = await import('/build/rightDrawer/docStore.mjs');
    const d = ds.currentDoc();
    const drawer = document.getElementById('pin-drawer');
    return { title: d?.title, path: d?.path, count: ds.docCount(), drawerOpen: !!drawer && !drawer.classList.contains('collapsed'),
      readerText: document.querySelector('#doc-drawer-panel, [data-panel="doc"]')?.textContent || '' };
  });
  assert(opened.title === 'Meeting 2026-10-08 15:03', `doc title should be the capture title; got ${opened.title}`);
  assert(opened.path === PATH, `doc should carry the transcript path identity; got ${opened.path}`);
  assert(opened.count === 1, `exactly one doc expected, got ${opened.count}`);
  assert(opened.drawerOpen, 'the right drawer should open on the reader');
  log('closed transcript reopened from the server ✓');

  // 3. the start notice's path is a #doc: link that opens the SAME doc
  const linkOk = await page.evaluate(() => {
    const a = document.querySelector('#transcript a.doc-open-link');
    if (!a) return { found: false };
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { found: true, href: a.getAttribute('href') };
  });
  assert(linkOk.found, 'the Recording-started notice must linkify the transcript path');
  await page.waitForTimeout(400);
  const after = await page.evaluate(async () => {
    const ds = await import('/build/rightDrawer/docStore.mjs');
    return { count: ds.docCount(), cap: ds.currentDoc()?.captureId };
  });
  assert(after.count === 1 && after.cap === CAP, `notice link should select the same doc, not add one: ${JSON.stringify(after)}`);
  log('notice path link opens the same doc ✓');

  // 4. ✎ renames meeting + chat
  await page.click('.doc-drawer-rename');
  await page.waitForSelector('.doc-drawer-title-input', { timeout: 3_000 });
  await page.fill('.doc-drawer-title-input', 'Riot investor call');
  await page.keyboard.press('Enter');
  await pollUntil(page, async () => {
    const ds = await import('/build/rightDrawer/docStore.mjs');
    return ds.currentDoc()?.title === 'Riot investor call';
  }, undefined, { timeout: 5_000, label: 'rename did not land on the doc' });
  const patch = mock.getCaptureLifecycle().find((e) => e.action === 'patch' && e.id === CAP);
  assert(patch && patch.body.title === 'Riot investor call' && patch.body.rename_session === true,
    `expected a PATCH with rename_session; got ${JSON.stringify(patch)}`);
  assert(mock.getCaptures().find((c) => c.id === CAP)?.title === 'Riot investor call', 'mock capture title should update');
  log('✎ renamed the meeting and asked for the chat rename ✓');
}
