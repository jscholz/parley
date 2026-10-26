// Field 2026-10-26 (CAP screenshot: a capture doc open in the reader, pins
// badge "2", and "Clear" in the drawer header). The drawer header's Clear
// button is ONE element shared by every module; the Pins module re-renders
// on every `parley:sessions-cached` (session list reload) and wrote
// `hidden = pins.length === 0` straight into it — over whatever panel was
// on screen. The host now owns the button and applies only the ACTIVE
// module's wishes.
import { waitForReady, assert } from './lib.mjs';

export const NAME = 'doc-reader-clear-with-pins';
export const DESCRIPTION = 'With pinned messages, a Pins re-render while the Docs reader is open must not surface "Clear"';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'parley:doc-reader-clear-with-pins';

export function MOCK_SETUP(mock) {
  const now = Date.now();
  mock.seedPin(CHAT_ID, 'msg-1', { role: 'user', text: 'first pinned', timestamp: now / 1000 - 60, pinnedAt: now - 60_000 });
  mock.seedPin(CHAT_ID, 'msg-2', { role: 'user', text: 'second pinned', timestamp: now / 1000 - 30, pinnedAt: now - 30_000 });
  mock.addChat(CHAT_ID, { title: 'Pins and docs', lastActiveAt: now - 1000, messages: [
    { role: 'user', content: 'first pinned', parley_id: 'msg-1', timestamp: now / 1000 - 60 },
    { role: 'user', content: 'second pinned', parley_id: 'msg-2', timestamp: now / 1000 - 30 },
  ]});
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await page.waitForFunction(() => window.__pinsDebug && window.__pinsDebug.size() >= 2, null, { timeout: 4000, polling: 50 });
  const clearBtn = () => page.evaluate(() => { const b = document.getElementById('pin-drawer-clear'); return { hidden: !b || b.hidden, display: b ? getComputedStyle(b).display : 'none', label: b?.getAttribute('aria-label') ?? '' }; });
  const shows = (m) => page.waitForFunction((mark) => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes(mark), m, { timeout: 6000, polling: 50 });

  // A pushed doc opens the reader.
  mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT_ID, title: 'Notes', content: '# Notes\n\nNOTES-MARK', format: 'markdown', path: '/w/notes.md' });
  await shows('NOTES-MARK');
  await page.waitForFunction(() => !document.getElementById('doc-drawer-panel')?.hidden, null, { timeout: 4000, polling: 50 });
  let c = await clearBtn();
  assert(c.hidden, `reader: Clear hidden before any background render: ${JSON.stringify(c)}`);

  // Background Pins re-renders: the session list reload AND a cross-device
  // pins_changed. Neither may touch the header while Docs is on screen.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('parley:sessions-cached')));
  mock.pushEnvelope({ type: 'pins_changed', chat_id: CHAT_ID });
  await page.waitForTimeout(1200);   // pins_changed re-fetch debounce is 800 ms
  c = await clearBtn();
  assert(c.hidden && c.display === 'none', `reader: Clear must stay hidden after Pins re-rendered in the background: ${JSON.stringify(c)}`);
  log('reader: Clear stays hidden through background Pins renders ✓');

  // Switching to Pins shows ITS Clear, with its own label.
  await page.click('#btn-pin-drawer-rail');
  await page.waitForFunction(() => !document.getElementById('pin-drawer-panel')?.hidden, null, { timeout: 4000, polling: 50 });
  c = await clearBtn();
  assert(!c.hidden && /pinned/i.test(c.label), `pins: Clear shows with the pins label: ${JSON.stringify(c)}`);
  log('pins: Clear shows ✓');

  // Back to Docs → the reader again → hidden again (no stale state leaks).
  await page.click('#btn-doc-drawer-rail');
  await page.waitForFunction(() => !document.getElementById('doc-drawer-panel')?.hidden, null, { timeout: 4000, polling: 50 });
  const inList = await clearBtn();
  assert(!inList.hidden && /document/i.test(inList.label), `docs list: Clear all shows with the docs label: ${JSON.stringify(inList)}`);
  await page.evaluate(() => document.querySelector('#doc-drawer-body .doc-shelf-item .doc-shelf-item-main')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await shows('NOTES-MARK');
  await page.waitForTimeout(100);
  c = await clearBtn();
  assert(c.hidden, `reader again: Clear hidden: ${JSON.stringify(c)}`);
  log('docs list shows Clear all, reader hides it ✓');
}
