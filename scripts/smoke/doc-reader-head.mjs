// FIELD, Jonathan 2026-11-06: "If I'm in a doc I have to scroll all the
// way to the top to close it … you float that row with the open chat and
// the expand and download. You just don't do it with the X. Also, that
// header is a bit ugly … cobbled together."
//
// The reader head is ONE sticky block, two lines, first in the body:
//   H1  structure — exactly one head; it holds the title row (title, ✕)
//       and the action row (tag · file · age · chat · expand · download);
//       nothing but the head precedes the document
//   H2  the ✕ is reachable at ANY scroll position: scrolled deep into the
//       document the head still sits at the top of the viewport, the ✕ is
//       the element under its own centre, and clicking it closes the doc
//   H3  a leading `# <title>` heading is not printed twice; a different
//       heading is kept
//   H4  the list rows: close shows on hover where a pointer can hover and
//       is always visible on touch; the active row carries the accent bar
//   H5  full screen: the same head sticks inside the reading column
//
// Polls, never one-shot samples (feedback_smokes_poll_dont_sample).

import { waitForReady, assert, pollUntil } from './lib.mjs';

export const NAME = 'doc-reader-head';
export const DESCRIPTION = 'Doc reader head: one sticky two-line block, close reachable at any scroll, no duplicated title heading, hover-only row controls on desktop';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = 'both';

const CHAT = 'parley:doc-head';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, { title: 'Doc head', messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_dh', timestamp: Date.now() / 1000 - 60 }], lastActiveAt: Date.now() });
}

const long = (h) => `# ${h}\n\n${Array.from({ length: 24 }, (_, i) => `## Section ${i + 1}\n\n${'Prose that fills the reading column and keeps going for a while. '.repeat(8)}\n`).join('\n')}`;

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  const phone = await page.evaluate(() => window.innerWidth < 700);
  // Alpha's body opens with its own title; Bravo's with a different heading.
  mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT, title: 'Alpha brief', content: long('Alpha brief'), format: 'markdown', path: '/w/alpha-brief.md', displayed_at: Date.now() - 2000 });
  mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT, title: 'Bravo memo', content: long('Different heading'), format: 'markdown', path: '/w/bravo-memo.md', displayed_at: Date.now() - 1000 });
  await pollUntil(page, () => document.querySelectorAll('.doc-rail-tab, .doc-fullscreen-tab').length >= 2 || !!document.querySelector('#doc-drawer-body .doc-drawer-header'), null, { timeout: 5_000, label: 'docs did not arrive' });
  // Make sure the reader is showing (desktop: pushes auto-open; phone: open the drawer).
  // On-screen = the head's ✕ sits inside the viewport (on a phone the
  // drawer is an overlay that a push does not open by itself).
  const onScreen = () => page.evaluate(() => { const r = document.querySelector('#doc-drawer-body .doc-drawer-remove')?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= window.innerWidth && !document.getElementById('doc-drawer-body')?.hidden; });
  // Same recipe as doc-close-notice-never-blocks: the newest doc's rail
  // tab opens the reader (and, on a phone, the overlay drawer).
  for (let i = 0; i < 3 && !(await onScreen()); i++) {
    await page.evaluate(() => [...document.querySelectorAll('#doc-rail-tabs .doc-rail-tab')].pop()?.click());
    await page.waitForTimeout(400);
  }
  await pollUntil(page, () => { const r = document.querySelector('#doc-drawer-body .doc-drawer-remove')?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= window.innerWidth; }, null, { timeout: 4_000, label: 'reader did not come on screen' });
  await page.waitForTimeout(350);   // drawer slide-in
  // Read Bravo first (newest), switch to Alpha for the title check later.
  const current = () => page.evaluate(() => import('/build/rightDrawer/docStore.mjs').then((m) => m.currentDoc()?.title || null));

  // ── H1 — structure ──────────────────────────────────────────────────
  const s1 = await page.evaluate(() => {
    const body = document.getElementById('doc-drawer-body');
    const heads = body.querySelectorAll('.doc-drawer-header');
    const h = heads[0];
    const kids = Array.from(body.children).map((el) => el.className.split(' ')[0]);
    return {
      heads: heads.length,
      first: kids[0],
      titleInHead: !!h?.querySelector('.doc-drawer-title .doc-drawer-title-text'),
      closeInHead: !!h?.querySelector('.doc-drawer-title .doc-drawer-remove'),
      actions: ['doc-drawer-tag', 'doc-drawer-file', 'doc-drawer-meta', 'doc-drawer-openchat', 'doc-drawer-expand', 'doc-drawer-download'].filter((c) => !h?.querySelector(`.doc-drawer-actions .${c}`)),
      strayRows: kids.filter((c) => c === 'doc-drawer-title' || c === 'doc-drawer-actions').length,
      sticky: h ? getComputedStyle(h).position : null,
      bg: h ? getComputedStyle(h).backgroundColor : null,
    };
  });
  log(`H1 ${JSON.stringify(s1)}`);
  assert(s1.heads === 1 && s1.first === 'doc-drawer-header', `H1: expected one head first in the body, got ${s1.heads} / first ${s1.first}`);
  assert(s1.titleInHead && s1.closeInHead, 'H1: title row must hold the title text and the ✕');
  assert(s1.actions.length === 0, `H1: action row is missing ${s1.actions.join(', ')}`);
  assert(s1.strayRows === 0, 'H1: title/action rows must live inside the head, not loose in the body');
  assert(s1.sticky === 'sticky' && s1.bg !== 'rgba(0, 0, 0, 0)', `H1: head must be sticky and opaque (${s1.sticky}, ${s1.bg})`);

  // ── H2 — ✕ reachable deep in the document ───────────────────────────
  await page.evaluate(() => { const b = document.getElementById('doc-drawer-body'); b.scrollTop = 1500; });
  await pollUntil(page, () => document.getElementById('doc-drawer-body').scrollTop > 1000, null, { timeout: 2_000, label: 'H2: body did not scroll' });
  const s2 = await page.evaluate(() => {
    const b = document.getElementById('doc-drawer-body');
    const h = b.querySelector('.doc-drawer-header');
    const x = h.querySelector('.doc-drawer-remove');
    const br = b.getBoundingClientRect(); const hr = h.getBoundingClientRect(); const xr = x.getBoundingClientRect();
    const hit = document.elementFromPoint(xr.left + xr.width / 2, xr.top + xr.height / 2);
    const desc = (el) => el ? `${el.tagName.toLowerCase()}#${el.id || ''}.${String(el.className?.baseVal ?? el.className ?? '').split(' ')[0]}` : 'null';
    return { scrollTop: b.scrollTop, headTop: Math.round(hr.top - br.top), xVisible: xr.top >= br.top && xr.bottom <= br.bottom, hitIsX: !!hit?.closest('.doc-drawer-remove'), hit: desc(hit), x: [Math.round(xr.left), Math.round(xr.top), Math.round(xr.width), Math.round(xr.height)], vw: window.innerWidth };
  });
  log(`H2 scrolled ${s2.scrollTop}: head top ${s2.headTop}px from body top, ✕ visible ${s2.xVisible}, hit ${s2.hitIsX}`);
  assert(s2.headTop <= 1 && s2.xVisible && s2.hitIsX, `H2: the ✕ is not at hand when scrolled: ${JSON.stringify(s2)}`);
  const before = await current();
  await page.click('#doc-drawer-body .doc-drawer-remove');
  await pollUntil(page, (t) => import('/build/rightDrawer/docStore.mjs').then((m) => m.currentDoc()?.title !== t), before, { timeout: 3_000, label: 'H2: click on the scrolled ✕ did not close the doc' });
  const after = await current();
  log(`H2 ✕ at scroll closed "${before}" → now "${after}" ✓`);

  // ── H3 — no duplicated title heading ────────────────────────────────
  // After closing Bravo (newest, read first) Alpha is up: its body opened
  // with "# Alpha brief", which the head already says.
  const s3 = await page.evaluate(() => {
    const c = document.querySelector('#doc-drawer-body .doc-drawer-content');
    const h1s = Array.from(c?.querySelectorAll('h1') || []).map((h) => h.textContent.trim());
    const title = document.querySelector('#doc-drawer-body .doc-drawer-title-text')?.textContent.trim();
    return { title, h1s, firstHeading: c?.querySelector('h1, h2')?.textContent.trim() };
  });
  log(`H3 ${JSON.stringify(s3)}`);
  assert(s3.title === 'Alpha brief', `H3: expected Alpha up, got ${s3.title}`);
  assert(!s3.h1s.includes('Alpha brief'), 'H3: the title heading is printed twice');
  assert(s3.firstHeading === 'Section 1', `H3: the document should open at its first real heading, got ${s3.firstHeading}`);
  // Re-push Bravo (different heading) and confirm it is kept.
  mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT, title: 'Bravo memo', content: long('Different heading'), format: 'markdown', path: '/w/bravo-memo.md', displayed_at: Date.now() });
  await pollUntil(page, () => document.querySelector('#doc-drawer-body .doc-drawer-title-text')?.textContent.includes('Bravo'), null, { timeout: 3_000, label: 'H3: Bravo did not come back' });
  const kept = await page.evaluate(() => Array.from(document.querySelectorAll('#doc-drawer-body .doc-drawer-content h1')).map((h) => h.textContent.trim()));
  assert(kept.includes('Different heading'), `H3: a heading that differs from the title must stay (${kept.join(', ')})`);
  log('H3 duplicate title dropped, different heading kept ✓');

  // ── H4 — list rows ──────────────────────────────────────────────────
  await page.evaluate(() => document.getElementById('btn-doc-drawer-rail')?.click());
  await pollUntil(page, () => document.querySelectorAll('.doc-shelf-item').length >= 2, null, { timeout: 3_000, label: 'H4: list did not show' });
  const rowState = () => page.evaluate(() => Array.from(document.querySelectorAll('.doc-shelf-item')).map((li) => ({
    active: li.classList.contains('active'),
    bar: getComputedStyle(li, '::before').width,
    closeOpacity: Number(getComputedStyle(li.querySelector('.doc-shelf-item-close')).opacity),
  })));
  const rest = await rowState();
  log(`H4 at rest ${JSON.stringify(rest)}`);
  const activeRows = rest.filter((r) => r.active);
  assert(activeRows.length === 1 && activeRows[0].bar === '3px', `H4: exactly one active row with the accent bar: ${JSON.stringify(rest)}`);
  if (phone) {
    assert(rest.every((r) => r.closeOpacity === 1), 'H4 phone: row close must be always visible on touch');
  } else {
    assert(rest.every((r) => r.closeOpacity === 0), 'H4: row close should be hidden until hover');
    await page.hover('.doc-shelf-item:not(.active)');
    await pollUntil(page, () => Number(getComputedStyle(document.querySelector('.doc-shelf-item:not(.active) .doc-shelf-item-close')).opacity) === 1, null, { timeout: 2_000, label: 'H4: hover did not reveal the row close' });
    await page.click('.doc-shelf-item:not(.active) .doc-shelf-item-close');
    await pollUntil(page, () => document.querySelectorAll('.doc-shelf-item').length === 1, null, { timeout: 3_000, label: 'H4: the hover-revealed close did not close the row' });
    log('H4 hover reveals the row close; it works ✓');
  }

  // ── H5 — full screen keeps the sticky head ──────────────────────────
  await page.evaluate(() => document.querySelector('.doc-shelf-item-main')?.click());
  await pollUntil(page, () => !!document.querySelector('#doc-drawer-body .doc-drawer-expand'), null, { timeout: 3_000, label: 'H5: reader did not return' });
  await page.click('#doc-drawer-body .doc-drawer-expand');
  await pollUntil(page, () => !!document.querySelector('.doc-fullscreen .doc-drawer-header'), null, { timeout: 3_000, label: 'H5: full screen did not open' });
  await page.evaluate(() => { document.querySelector('.doc-fullscreen-column').scrollTop = 1500; });
  await pollUntil(page, () => document.querySelector('.doc-fullscreen-column').scrollTop > 1000, null, { timeout: 2_000, label: 'H5: column did not scroll' });
  const s5 = await page.evaluate(() => {
    const col = document.querySelector('.doc-fullscreen-column');
    const h = col.querySelector('.doc-drawer-header');
    const x = h.querySelector('.doc-drawer-remove');
    const cr = col.getBoundingClientRect(); const hr = h.getBoundingClientRect(); const xr = x.getBoundingClientRect();
    return { headTop: Math.round(hr.top - cr.top), hitIsX: !!document.elementFromPoint(xr.left + xr.width / 2, xr.top + xr.height / 2)?.closest('.doc-drawer-remove') };
  });
  log(`H5 full screen scrolled: head ${s5.headTop}px from column top, ✕ hit ${s5.hitIsX}`);
  assert(s5.headTop <= 1 && s5.hitIsX, `H5: head does not stick in full screen: ${JSON.stringify(s5)}`);
  await page.click('.doc-fullscreen-close');
  await pollUntil(page, () => !document.querySelector('.doc-fullscreen'), null, { timeout: 3_000, label: 'H5: did not exit' });
  log('reader head: one sticky block, close at any scroll, no double title ✓');
}
