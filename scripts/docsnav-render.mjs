// One-off render harness for the docs-nav pass (2026-08-26): breadcrumb
// removal, rail honesty in list view, Open-chat companion link, ⌘0.
// Run against an ISOLATED server (never :3001):
//   PORT=3211 PARLEY_HOME=/tmp/docsnav-home PARLEY_CONFIG=... node server.ts &
//   SMOKE_URL=http://127.0.0.1:3211 node scripts/docsnav-render.mjs <label>
import { launchSharedBrowser, launchBrowser, waitForReady } from './smoke/lib.mjs';
import { installMockBackend } from './smoke/mock-backend.mjs';
import { mkdirSync } from 'node:fs';

const LABEL = process.argv[2] || 'docsnav';
const OUT = `/tmp/ux-renders/${LABEL}`;
mkdirSync(OUT, { recursive: true });

const MEETING_CHAT = 'docsnav-meeting';
const VIEWED_CHAT = 'docsnav-viewed';
const tSec = Date.now() / 1000;

function seed(mock) {
  mock.addChat(MEETING_CHAT, {
    title: 'Launch planning sync',
    source: 'parley',
    messages: [
      { role: 'user', content: 'Summarize the decisions from the sync.', message_id: 'mm1', parley_id: 'mm1', timestamp: tSec - 3000 },
      { role: 'assistant', content: 'Three decisions: gate the HN post on the demo instance, keep the shared Deepgram key with a quota alarm, and ship the CDN move next sprint.', message_id: 'mm2', parley_id: 'mm2', timestamp: tSec - 2980 },
    ],
    lastActiveAt: Date.now() - 3_000_000,
  });
  mock.addChat(VIEWED_CHAT, {
    title: 'Current work chat',
    source: 'parley',
    messages: [
      { role: 'user', content: 'What is left on the docs-nav pass?', message_id: 'mv1', parley_id: 'mv1', timestamp: tSec - 300 },
      { role: 'assistant', content: 'Renders and the smoke updates — the breadcrumb is gone and the rail tint now follows the view.', message_id: 'mv2', parley_id: 'mv2', timestamp: tSec - 280 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

async function shoot(browser, { theme }) {
  const { page, cleanup } = await launchBrowser(browser, { mobile: false });
  const mock = await installMockBackend(page);
  seed(mock);
  await waitForReady(page);
  await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);

  // Three plain docs + the capture doc last (auto-opens its reader).
  await mock.pushEnvelope({
    type: 'doc_show', chat_id: VIEWED_CHAT,
    title: 'Launch plan draft', format: 'markdown', path: '/w/launch-plan.md',
    content: '# Launch plan\n\nPhases, owners, and the demo-instance gate.',
  });
  await mock.pushEnvelope({
    type: 'doc_show', chat_id: VIEWED_CHAT,
    title: 'Funnel dashboard', format: 'html', path: '/w/funnel.html',
    content: '<h1>Funnel</h1><p>video → demo → show-hn</p>',
  });
  await mock.pushEnvelope({
    type: 'doc_show', chat_id: VIEWED_CHAT,
    title: 'Server log excerpt', format: 'text', path: '/w/server.log.txt',
    content: 'boot ok\nssl ok\nquota warn: deepgram shared key at 71%',
  });
  await mock.pushEnvelope({
    type: 'doc_show', chat_id: MEETING_CHAT,
    title: 'Meeting: Launch planning sync',
    format: 'markdown', path: '/captures/launch-sync.md',
    source: 'capture', capture_id: 'cap-docsnav',
    displayed_at: Date.now() - 25 * 60_000,
    content: [
      '_Recorded 2026-08-25 10:35 · 1:34:39 · diarized_',
      '',
      '**Jonathan:** Walk me through where the demo instance stands.',
      '',
      '**Sam:** HTTPS cert is live; mic permission tested on iOS and desktop Safari. The only open risk is Deepgram quota on the shared key.',
      '',
      '**Jonathan:** Gate the HN post on that.',
    ].join('\n'),
  });

  // Frame 1 (money): capture-doc READER — no `‹ All docs` breadcrumb,
  // Open-chat link in the nav row, capture tab tinted in the rail.
  await page.waitForFunction(
    () => {
      const panel = document.getElementById('doc-drawer-panel');
      return !!panel && !panel.hidden && panel.getClientRects().length > 0
        && !!document.querySelector('#doc-drawer-body .doc-drawer-openchat');
    },
    null, { timeout: 6000, polling: 50 },
  );
  const readerState = await page.evaluate(() => ({
    breadcrumb: !!document.querySelector('.doc-drawer-listbtn'),
    openChat: !!document.querySelector('#doc-drawer-body .doc-drawer-openchat'),
    tinted: document.querySelectorAll('#doc-rail-tabs .doc-rail-tab[aria-selected="true"]').length,
  }));
  if (readerState.breadcrumb) throw new Error('breadcrumb rendered — frame would show the removed chrome');
  if (!readerState.openChat) throw new Error('Open-chat link missing — frame has no subject');
  if (readerState.tinted !== 1) throw new Error(`reader frame: expected exactly 1 tinted tab, got ${readerState.tinted}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${theme}-reader-capture.png`, fullPage: false });
  console.log('shot', `${theme}-reader-capture.png`);

  // Frame 2 (money): LIST view via Ctrl+0 — Docs rail button tinted,
  // ZERO doc tabs tinted (rail honesty).
  await page.keyboard.press('Control+Digit0');
  await page.waitForFunction(
    () => document.querySelectorAll('#doc-drawer-body .doc-shelf-item').length === 4,
    null, { timeout: 4000, polling: 50 },
  );
  const listState = await page.evaluate(() => ({
    docsBtnSelected: document.getElementById('btn-doc-drawer-rail')?.getAttribute('aria-selected'),
    tinted: document.querySelectorAll('#doc-rail-tabs .doc-rail-tab[aria-selected="true"]').length,
  }));
  if (listState.docsBtnSelected !== 'true') throw new Error('list frame: Docs button must be selected');
  if (listState.tinted !== 0) throw new Error(`list frame: expected 0 tinted tabs, got ${listState.tinted}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${theme}-list-view.png`, fullPage: false });
  console.log('shot', `${theme}-list-view.png`);

  // Frame 3: after clicking Open chat — companion session in the main
  // view, drawer still open.
  await page.keyboard.press('Control+Digit0');   // close list
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+Digit4');   // capture doc reader (tab 4)
  await page.waitForFunction(
    () => !!document.querySelector('#doc-drawer-body .doc-drawer-openchat'),
    null, { timeout: 4000, polling: 50 },
  );
  await page.click('#doc-drawer-body .doc-drawer-openchat');
  await page.waitForFunction(
    () => /Three decisions/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 6000, polling: 50 },
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${theme}-openchat-landed.png`, fullPage: false });
  console.log('shot', `${theme}-openchat-landed.png`);

  await cleanup();
}

const { browser, closeShared } = await launchSharedBrowser({});
for (const theme of ['dark', 'light']) {
  await shoot(browser, { theme });
}
await closeShared();
console.log('DONE ->', OUT);
