// Field 2026-10-26: "When I click on links in Parley … it navigates the
// Chrome window in my desktop PWA to that, and I can't press back. And
// when I click X, it refreshes the page." Off-origin links must leave the
// app in a NEW window: the doc reader stamps target=_blank on them and a
// web-only capture-phase guard (externalLinkGuard.ts) catches any anchor
// a renderer forgot. Same-origin and in-app links are untouched.
import { waitForReady, assert } from './lib.mjs';

export const NAME = 'external-links-open-new-window';
export const DESCRIPTION = 'Off-origin links (doc reader, chat, stray anchors) open the in-app link viewer (Parley header, ×/Esc, Open in browser) and never navigate the app; same-origin links stay in-app';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'parley:external-links';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, { title: 'Links', lastActiveAt: Date.now() - 1000, messages: [
    { role: 'assistant', content: 'See [the site](https://example.com/page) for details.', parley_id: 'msg-1', timestamp: Date.now() / 1000 - 60 },
  ]});
}

export default async function run({ page, log, mock }) {
  await page.addInitScript(() => {
    window.__opened = [];
    const orig = window.open.bind(window);
    window.open = (url, target, features) => { window.__opened.push({ url: String(url), target, features }); return { closed: false }; };
  });
  await waitForReady(page);
  const startUrl = page.url();
  const opened = () => page.evaluate(() => window.__opened);

  // 1. Doc reader: an off-origin link carries target=_blank and opens a window.
  mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT_ID, title: 'Links doc', content: '# Links\n\nLINKS-MARK [outside](https://example.org/x) and [inside](/settings) and [doc](#doc:abc)', format: 'markdown', path: '/w/links.md' });
  await page.waitForFunction(() => document.querySelector('#doc-drawer-body .doc-drawer-content')?.textContent?.includes('LINKS-MARK'), null, { timeout: 6000, polling: 50 });
  const attrs = await page.evaluate(() => [...document.querySelectorAll('#doc-drawer-body .doc-drawer-content a')].map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel })));
  const ext = attrs.find((a) => a.href === 'https://example.org/x');
  assert(ext && ext.target === '_blank' && /noopener/.test(ext.rel), `doc reader: off-origin anchor gets target=_blank rel=noopener: ${JSON.stringify(attrs)}`);
  assert(attrs.filter((a) => a.href !== 'https://example.org/x').every((a) => a.target !== '_blank'), `doc reader: in-app anchors are untouched: ${JSON.stringify(attrs)}`);
  await page.evaluate(() => document.querySelector('#doc-drawer-body .doc-drawer-content a[href="https://example.org/x"]').click());
  await page.waitForSelector('#link-viewer', { timeout: 3_000 });
  const viewer = await page.$eval('#link-viewer', (v) => ({ brand: v.querySelector('.link-viewer-brand')?.textContent, host: v.querySelector('.link-viewer-host')?.textContent, src: v.querySelector('iframe')?.getAttribute('src'), open: v.querySelector('.link-viewer-open')?.textContent }));
  assert(viewer.brand === 'Parley' && viewer.host === 'example.org' && viewer.src === 'https://example.org/x' && /Open in browser/.test(viewer.open), `viewer: ${JSON.stringify(viewer)}`);
  let o = await opened();
  assert(o.length === 0, `no tab opens by itself: ${JSON.stringify(o)}`);
  assert(page.url() === startUrl, `app must not navigate (was ${startUrl}, now ${page.url()})`);
  // "Open in browser" is the explicit way out: a real tab, no noopener feature (that returns null).
  await page.click('#link-viewer .link-viewer-open');
  o = await opened();
  assert(o.length === 1 && o[0].url === 'https://example.org/x' && o[0].target === '_blank' && !/noopener/.test(o[0].features || ''), `Open in browser → window.open: ${JSON.stringify(o)}`);
  assert(page.url() === startUrl, 'app still not navigated');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('link-viewer'), null, { timeout: 2_000 });
  log('doc reader: off-origin link → in-app viewer; Open in browser → tab; Esc closes; app stays ✓');

  // 2. A stray anchor with NO target (what a forgotten renderer produces)
  //    is caught by the delegated guard.
  await page.evaluate(() => {
    const a = document.createElement('a'); a.id = 'stray-ext'; a.href = 'https://example.net/stray'; a.textContent = 'stray';
    const b = document.createElement('a'); b.id = 'stray-same'; b.href = '/settings'; b.textContent = 'same';
    b.addEventListener('click', (e) => { e.preventDefault(); window.__sameClicked = true; });
    document.body.append(a, b);
  });
  await page.click('#stray-ext');
  await page.waitForSelector('#link-viewer iframe[src="https://example.net/stray"]', { timeout: 3_000 });
  o = await opened();
  assert(o.length === 1, `stray off-origin anchor → viewer, no new tab: ${JSON.stringify(o)}`);
  assert(page.url() === startUrl, 'stray link must not navigate the app');
  await page.click('#link-viewer .lightbox-close');
  await page.waitForFunction(() => !document.getElementById('link-viewer'), null, { timeout: 2_000 });
  await page.click('#stray-same');
  await page.waitForTimeout(100);
  assert(!(await page.$('#link-viewer')) && await page.evaluate(() => window.__sameClicked === true), 'same-origin anchor is left to its own handler');
  log('guard: stray off-origin anchor → viewer, × closes; same-origin untouched ✓');
}
