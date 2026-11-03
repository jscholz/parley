// FIELD NIT, Jonathan 2026-11-03: "can you retain the scroll position when
// I switch docs? currently it gets lost."
//
//   S1  scroll doc B, switch to A, scroll A, switch back → B is where it was
//   S2  …and back again → A is where it was
//   S3  entering full screen keeps the position; scrolling there and
//       switching docs in the strip keeps each doc's own position
//   S4  leaving full screen hands the position back to the panel

import { waitForReady, pollUntil, assert } from './lib.mjs';

export const NAME = 'doc-scroll-position-retained';
export const DESCRIPTION = 'Docs reader: each document keeps its own scroll position across switches, into and out of full screen';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:doc-scroll';
const para = (tag) => Array.from({ length: 40 }, (_, i) => `${tag} paragraph ${i + 1}: ${'enough words to make the document tall. '.repeat(4)}`).join('\n\n');

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, { title: 'Scroll room', messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_sc', timestamp: Date.now() / 1000 - 60 }], lastActiveAt: Date.now() });
}

const ids = (page) => page.evaluate(() => import('/build/rightDrawer/docStore.mjs').then((m) => Object.fromEntries(m.listDocs().map((d) => [d.title, d.id]))));
const select = (page, id) => page.evaluate((i) => import('/build/rightDrawer/docStore.mjs').then((m) => m.selectDoc(i)), id);
const shown = async (page, mark) => {
  await pollUntil(page, (mk) => new RegExp(mk).test(document.getElementById('doc-drawer-body')?.textContent || ''), mark, { timeout: 4_000, label: `${mark} never rendered` });
  await page.waitForTimeout(700);   // the restore re-applies while the panel's layout settles (~600 ms)
};
const scrollerTop = (page) => page.evaluate(() => {
  const body = document.getElementById('doc-drawer-body');
  const col = document.querySelector('.doc-fullscreen-column');
  return col && col.contains(body) ? col.scrollTop : body.scrollTop;
});
const scrollTo = (page, y) => page.evaluate((v) => {
  const body = document.getElementById('doc-drawer-body');
  const col = document.querySelector('.doc-fullscreen-column');
  const el = col && col.contains(body) ? col : body;
  el.scrollTop = v;
  el.dispatchEvent(new Event('scroll'));
  return el.scrollTop;
}, y);
const near = (a, b) => Math.abs(a - b) <= 40;

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT, title: 'Alpha', content: `# Alpha\n\nALPHA-MARK\n\n${para('Alpha')}`, format: 'markdown', path: '/w/sa.md', displayed_at: Date.now() - 1000 });
  mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT, title: 'Bravo', content: `# Bravo\n\nBRAVO-MARK\n\n${para('Bravo')}`, format: 'markdown', path: '/w/sb.md', displayed_at: Date.now() });
  await shown(page, 'BRAVO-MARK');
  const { Alpha, Bravo } = await ids(page);

  // ── S1 / S2 — panel switches ────────────────────────────────────────
  const bSet = await scrollTo(page, 600);
  assert(bSet > 500, `Bravo did not scroll (got ${bSet}) — document too short for the test`);
  await select(page, Alpha); await shown(page, 'ALPHA-MARK');
  const aFresh = await scrollerTop(page);
  assert(aFresh === 0, `a never-scrolled doc should open at the top, got ${aFresh}`);
  await scrollTo(page, 300);
  await select(page, Bravo); await shown(page, 'BRAVO-MARK');
  const bBack = await scrollerTop(page);
  log(`S1 Bravo after switching away and back: ${bBack} (was 600)`);
  assert(near(bBack, 600), `S1: Bravo lost its position (${bBack} vs 600)`);
  await select(page, Alpha); await shown(page, 'ALPHA-MARK');
  const aBack = await scrollerTop(page);
  log(`S2 Alpha back: ${aBack} (was 300)`);
  assert(near(aBack, 300), `S2: Alpha lost its position (${aBack} vs 300)`);

  // ── S3 — full screen keeps and tracks positions ─────────────────────
  await page.click('#doc-drawer-body .doc-drawer-expand');
  await pollUntil(page, () => !!document.querySelector('.doc-fullscreen'), null, { timeout: 2_000, label: 'S3: full screen did not open' });
  const aFs = await scrollerTop(page);
  log(`S3 Alpha on entering full screen: ${aFs} (was 300)`);
  assert(near(aFs, 300), `S3: entering full screen lost Alpha's position (${aFs})`);
  await scrollTo(page, 900);
  await page.click('.doc-fullscreen-tab[data-doc-id]:not([aria-selected="true"])');
  await shown(page, 'BRAVO-MARK');
  await page.waitForTimeout(100);
  const bFs = await scrollerTop(page);
  log(`S3 Bravo in full screen: ${bFs} (was 600)`);
  assert(near(bFs, 600), `S3: Bravo's position not kept in full screen (${bFs})`);
  await page.click('.doc-fullscreen-tab[data-doc-id]:not([aria-selected="true"])');
  await shown(page, 'ALPHA-MARK');
  await page.waitForTimeout(100);
  const aFs2 = await scrollerTop(page);
  assert(near(aFs2, 900), `S3: Alpha's full-screen scroll not kept (${aFs2} vs 900)`);

  // ── S4 — leaving full screen hands the position back ───────────────
  await page.keyboard.press('Escape');
  await pollUntil(page, () => !document.querySelector('.doc-fullscreen'), null, { timeout: 2_000, label: 'S4: did not close' });
  const aPanel = await scrollerTop(page);
  log(`S4 Alpha in the panel after leaving full screen: ${aPanel} (was 900)`);
  assert(near(aPanel, 900), `S4: leaving full screen lost the position (${aPanel})`);
}
