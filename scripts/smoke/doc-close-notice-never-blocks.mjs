// Closing a doc must not hold the next doc's controls hostage (field
// 2026-10-12: "the banner that comes up masks the heading of the next
// message, and isn't dismissable, and doesn't let me click the x of the
// window below"). The "Closed …" notice is the doc panel's Undo pop-up
// (.doc-undo-bar). It floats near the close click (2026-10-27) but stops
// short of the right edge, so the next doc's × stays clickable; both its
// ✕ and a click on its body dismiss it.
import { waitForReady, assert } from './lib.mjs';

export const NAME = 'doc-close-notice-never-blocks';
export const DESCRIPTION = 'After closing a doc, the next doc\'s × is tappable at once; the floating Undo pop-up sits clear of it and its ✕ dismisses it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = 'both';

const CHAT_ID = 'mock-doc-close-notice';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Doc close notice', lastActiveAt: Date.now() - 1000,
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_dcn_seed', timestamp: Date.now() / 1000 - 60 }],
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  const push = (title, mark, path) => mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT_ID, title, content: `# ${title}\n\n${mark}`, format: 'markdown', path });
  const shows = (mark) => page.waitForFunction((m) => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes(m), mark, { timeout: 6000, polling: 50 });
  push('First doc', 'FIRST-MARK', '/w/first.md');  await shows('FIRST-MARK');
  push('Second doc', 'SECOND-MARK', '/w/second.md'); await shows('SECOND-MARK');
  // Put the drawer on screen on the Second doc (its rail tab opens the reader).
  for (let i = 0; i < 3; i++) {
    const open = await page.evaluate(() => document.body.classList.contains('pin-drawer-open'));
    if (open) break;
    await page.evaluate(() => [...document.querySelectorAll('#doc-rail-tabs .doc-rail-tab')].pop()?.click());
    await page.waitForTimeout(300);
  }
  await page.waitForFunction(() => document.body.classList.contains('pin-drawer-open')
    && document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('SECOND-MARK'), null, { timeout: 4000 });
  await page.waitForTimeout(350);   // drawer slide-in

  // Close the reader's doc; the reader falls back to the other one.
  await page.evaluate(() => document.querySelector('#doc-drawer-body .doc-drawer-remove').click());
  await shows('FIRST-MARK');
  const geo = await page.evaluate(() => {
    const st = document.querySelector('#doc-drawer-panel .doc-undo-bar');
    const x = document.querySelector('#doc-drawer-body .doc-drawer-remove');
    const s = st.getBoundingClientRect(), r = x.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    return { hit: top ? (top.id || top.tagName + '.' + (top.className?.baseVal ?? top.className)) : null, x: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], vw: innerWidth, vh: innerHeight, visible: !st.hidden && s.height > 0, text: st.textContent, overlaps: !(s.bottom <= r.top || s.top >= r.bottom || s.right <= r.left || s.left >= r.right), xOnTop: !!top?.closest('.doc-drawer-remove') };
  });
  assert(geo.visible && /Closed/.test(geo.text), `the close notice should show: ${JSON.stringify(geo)}`);
  assert(!geo.overlaps && geo.xOnTop, `the notice must not cover the next doc's ×: ${JSON.stringify(geo)}`);
  log('close notice shows, clear of the next doc\'s × ✓');

  // The next × works immediately — no waiting out the notice.
  await page.evaluate(() => {
    const x = document.querySelector('#doc-drawer-body .doc-drawer-remove');
    const r = x.getBoundingClientRect();
    document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).closest('button').click();
  });
  await page.waitForFunction(() => !document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('FIRST-MARK'), null, { timeout: 3000 });
  log('next doc\'s × closes it right away ✓');

  // Its ✕ → gone.
  await page.evaluate(() => document.querySelector('#doc-drawer-panel .doc-undo-dismiss').click());
  const gone = await page.evaluate(() => document.querySelector('#doc-drawer-panel .doc-undo-bar').hidden);
  assert(gone, 'the ✕ must dismiss the Undo bar');
  log('✕ dismisses the Undo bar ✓');
}
