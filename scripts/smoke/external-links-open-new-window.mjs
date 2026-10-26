// Field 2026-10-26: "When I click on links in Parley … it navigates the
// Chrome window in my desktop PWA to that, and I can't press back. And
// when I click X, it refreshes the page." Off-origin links must leave the
// app in a NEW window: the doc reader stamps target=_blank on them and a
// web-only capture-phase guard (externalLinkGuard.ts) catches any anchor
// a renderer forgot. Same-origin and in-app links are untouched.
import { waitForReady, assert } from './lib.mjs';

export const NAME = 'external-links-open-new-window';
export const DESCRIPTION = 'Off-origin links (doc reader, chat, stray anchors) open a new window and never navigate the app; same-origin links stay in-app';
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
  await page.waitForTimeout(150);
  let o = await opened();
  assert(o.length === 1 && o[0].url === 'https://example.org/x' && o[0].target === '_blank', `doc link → window.open: ${JSON.stringify(o)}`);
  assert(page.url() === startUrl, `app must not navigate (was ${startUrl}, now ${page.url()})`);
  log('doc reader: off-origin link opens a new window, app stays ✓');

  // 2. A stray anchor with NO target (what a forgotten renderer produces)
  //    is caught by the delegated guard.
  await page.evaluate(() => {
    const a = document.createElement('a'); a.id = 'stray-ext'; a.href = 'https://example.net/stray'; a.textContent = 'stray';
    const b = document.createElement('a'); b.id = 'stray-same'; b.href = '/settings'; b.textContent = 'same';
    b.addEventListener('click', (e) => { e.preventDefault(); window.__sameClicked = true; });
    document.body.append(a, b);
  });
  await page.click('#stray-ext');
  await page.waitForTimeout(150);
  o = await opened();
  assert(o.length === 2 && o[1].url === 'https://example.net/stray', `stray off-origin anchor → window.open: ${JSON.stringify(o)}`);
  assert(page.url() === startUrl, 'stray link must not navigate the app');
  await page.click('#stray-same');
  await page.waitForTimeout(100);
  o = await opened();
  assert(o.length === 2 && await page.evaluate(() => window.__sameClicked === true), `same-origin anchor is left to its own handler: ${JSON.stringify(o)}`);
  log('guard: stray off-origin anchor → new window; same-origin untouched ✓');
}
