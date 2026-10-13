// Agent image links and inline images open in an in-app viewer that can
// be dismissed — never a new window (field 2026-10-13: an image link
// spawned a bare PWA window with "no way to dismiss it or go back to the
// chat").
import { waitForReady, pollUntil, assert } from './lib.mjs';

export const NAME = 'image-link-opens-in-app-viewer';
export const DESCRIPTION = 'Image links and inline images open an in-app viewer (×, Esc, backdrop close; Download + Open original), never a new window';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = 'both';

const CHAT = 'parley:mock-image-viewer';
import { readFileSync } from 'node:fs';
const PNG = (() => { try { return readFileSync('/tmp/real.png'); } catch { return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'); } })();

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 120;
  mock.addChat(CHAT, { title: 'Image viewer', lastActiveAt: Date.now() - 1000, messages: [
    { role: 'user', content: 'draw it', parley_id: 'umsg_iv1', timestamp: t0 },
    { role: 'assistant', content: 'Here is the [annotated diagram](/api/parley/media/44fdeb4546d96f55.png).', message_id: 'msg_iv1', timestamp: t0 + 5 },
    { role: 'assistant', content: '![inline render](/api/parley/media/aaaabbbbccccdddd.png)\n\nand a [pdf](/api/parley/media/eeeeffff00001111.pdf)', message_id: 'msg_iv2', timestamp: t0 + 9 },
  ]});
}

export default async function run({ page, log }) {
  await page.route('**/api/parley/media/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.endsWith('.pdf')) return route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4' });
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  let popups = 0;
  page.context().on('page', () => { popups += 1; });

  await waitForReady(page);
  await pollUntil(page, (cid) => !!document.querySelector(`#sessions-list li[data-chat-id="${cid}"]`), CHAT, { timeout: 8000, label: 'chat not listed' });
  await page.evaluate((cid) => { document.body.classList.add('sidebar-expanded'); document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`)?.dispatchEvent(new MouseEvent('click', { bubbles: true })); }, CHAT);
  await pollUntil(page, () => !!document.querySelector('#transcript .line[data-message-id="msg_iv1"] a'), null, { timeout: 8000, label: 'link bubble did not render' });

  const viewer = () => page.evaluate(() => {
    const lb = document.getElementById('lightbox');
    if (!lb) return null;
    return { src: lb.querySelector('img')?.getAttribute('src') || '', close: !!lb.querySelector('.lightbox-close'), dl: !!lb.querySelector('a[download]'), orig: !!lb.querySelector('a[target="_blank"]') };
  });

  // 1. Image LINK → viewer, no new window; × closes.
  await page.evaluate(() => document.querySelector('#transcript .line[data-message-id="msg_iv1"] a').click());
  await page.waitForTimeout(300);
  let v = await viewer();
  assert(v && /44fdeb4546d96f55\.png$/.test(v.src) && v.close && v.dl && v.orig, `link should open the viewer: ${JSON.stringify(v)}`);
  assert(popups === 0, `no new window may open (popups=${popups})`);
  await page.screenshot({ path: '/tmp/image-viewer.png' });
  await page.evaluate(() => document.querySelector('#lightbox .lightbox-close').click());
  assert(!(await viewer()), '× must close the viewer');
  log('image link → in-app viewer with ×/Download/Open original; × closes; no new window ✓');

  // 2. Inline image → viewer; Esc closes.
  await pollUntil(page, () => !!document.querySelector('#transcript .line[data-message-id="msg_iv2"] img'), null, { timeout: 5000, label: 'inline image did not render' });
  await page.evaluate(() => document.querySelector('#transcript .line[data-message-id="msg_iv2"] img').click());
  v = await viewer();
  assert(v && /aaaabbbbccccdddd\.png$/.test(v.src), `inline image should open the viewer: ${JSON.stringify(v)}`);
  await page.keyboard.press('Escape');
  assert(!(await viewer()), 'Esc must close the viewer');
  log('inline image → viewer; Esc closes ✓');

  // 3. Backdrop tap closes; a tap on the image itself does not.
  await page.evaluate(() => document.querySelector('#transcript .line[data-message-id="msg_iv1"] a').click());
  await page.evaluate(() => document.querySelector('#lightbox img').click());
  assert(!!(await viewer()), 'a tap on the image must not close it');
  await page.evaluate(() => document.getElementById('lightbox').click());
  assert(!(await viewer()), 'a backdrop tap must close it');
  log('backdrop closes, image tap does not ✓');

  // 4. Non-image links are untouched (still a normal link).
  const pdf = await page.evaluate(() => {
    const a = [...document.querySelectorAll('#transcript .line[data-message-id="msg_iv2"] a')].find((x) => /\.pdf$/.test(x.getAttribute('href') || ''));
    let prevented = null;
    const probe = (e) => { prevented = e.defaultPrevented; e.preventDefault(); };
    document.addEventListener('click', probe, { once: true });
    a.click();
    return { prevented, viewer: !!document.getElementById('lightbox') };
  });
  assert(pdf.prevented === false && !pdf.viewer, `pdf link must not be hijacked: ${JSON.stringify(pdf)}`);
  log('non-image links are left alone ✓');
}
