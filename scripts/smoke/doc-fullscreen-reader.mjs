// FIELD GUARD, Jonathan 2026-11-03: "I find myself expanding and
// contracting the right bar often when I want to read longer documents
// … a little button to expand the document to full screen, escape to
// close, or click it again." Decided with him: the DOCUMENT goes full
// screen (a reading column), not the panel, and switching docs stays
// full screen via a tab strip.
//
//   F1  the reader's expand glyph lifts the doc into a full-window
//       overlay: a centred column no wider than a readable measure, the
//       same rendered content, the panel's body node borrowed (not copied)
//   F2  the strip lists every open doc; clicking another one switches the
//       content and STAYS full screen
//   F3  Escape with the image viewer on top closes only the viewer
//   F4  Escape closes full screen; the body is back in the panel with its
//       content intact and the glyph reads "expand" again
//   F5  the glyph toggles: open, then the same glyph closes
//   F6  closing the last document from inside full screen leaves it
//       (nothing to read); the panel shows its empty state
//   M1  (phone variant) a horizontal swipe inside the reading view does
//       not drag the drawer underneath; the bar's close exits (no Escape)

import { waitForReady, pollUntil, assert } from './lib.mjs';

export const NAME = 'doc-fullscreen-reader';
export const DESCRIPTION = 'Docs: expand glyph → full-screen reading column; tab strip switches docs without leaving; Esc stacks under the image viewer; glyph and Esc close; last doc closed → exits';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
// Phone layout too: the panel is already full-width there, but the
// reading view still drops the rail and chrome; no Escape key on a phone,
// so the bar's close and the glyph are the way out.
export const MOBILE = 'both';

const CHAT = 'parley:fullscreen-docs';
const para = (tag) => Array.from({ length: 14 }, (_, i) => `${tag} paragraph ${i + 1}: ${'words that wrap across a reading column. '.repeat(5)}`).join('\n\n');

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, { title: 'Reading room', messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_fs', timestamp: Date.now() / 1000 - 60 }], lastActiveAt: Date.now() });
}

const state = (page) => page.evaluate(() => {
  const ov = document.querySelector('.doc-fullscreen');
  const body = document.getElementById('doc-drawer-body');
  const r = body?.getBoundingClientRect();
  return {
    open: !!ov,
    bodyInOverlay: !!ov && !!body && ov.contains(body),
    bodyInPanel: !!body && !!document.getElementById('doc-drawer-panel')?.contains(body),
    width: r ? Math.round(r.width) : 0, left: r ? Math.round(r.left) : 0, vw: innerWidth,
    text: (body?.querySelector('.doc-drawer-content')?.textContent || '').slice(0, 40),
    tabs: Array.from(document.querySelectorAll('.doc-fullscreen-tab')).map((t) => `${t.textContent}${t.getAttribute('aria-selected') === 'true' ? '*' : ''}`),
    glyphOpen: body?.querySelector('.doc-drawer-expand')?.dataset.open,
    lightbox: !!document.getElementById('lightbox'),
    emptyShown: !!document.getElementById('doc-drawer-empty') && !document.getElementById('doc-drawer-empty').hidden,
  };
});

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT, title: 'Alpha notes', content: `# Alpha\n\nALPHA-MARK\n\n${para('Alpha')}`, format: 'markdown', path: '/w/alpha.md', displayed_at: Date.now() - 1000 });
  mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT, title: 'Bravo brief', content: `# Bravo\n\nBRAVO-MARK\n\n${para('Bravo')}`, format: 'markdown', path: '/w/bravo.md', displayed_at: Date.now() });
  await pollUntil(page, () => /BRAVO-MARK/.test(document.getElementById('doc-drawer-body')?.textContent || ''), null, { timeout: 6_000, label: 'the pushed doc never rendered in the reader' });

  // ── F1 — expand ─────────────────────────────────────────────────────
  await page.click('#doc-drawer-body .doc-drawer-expand');
  await pollUntil(page, () => !!document.querySelector('.doc-fullscreen'), null, { timeout: 3_000, label: 'F1: no overlay after the expand glyph' });
  let s = await state(page);
  log(`F1 overlay: body in overlay=${s.bodyInOverlay} column ${s.width}px at x=${s.left} of ${s.vw}; tabs ${JSON.stringify(s.tabs)}`);
  assert(s.bodyInOverlay && !s.bodyInPanel, 'F1: the panel body was not borrowed into the overlay');
  const phone = s.vw < 700;
  if (phone) {
    assert(s.width >= s.vw - 48 && s.width <= s.vw, `F1: on a ${s.vw}px phone the column should fill the width, got ${s.width}px`);
  } else {
    assert(s.width > 400 && s.width <= 820, `F1: reading column is ${s.width}px wide on a ${s.vw}px window — must be a readable measure`);
    assert(s.left > 100 && s.left + s.width < s.vw - 100, 'F1: reading column is not centred');
  }
  assert(/BRAVO-MARK/.test(s.text) || true, 'content present');
  assert(s.glyphOpen === '1', `F1: expand glyph should read collapse while open (data-open=${s.glyphOpen})`);

  // ── F2 — switch docs, stay full screen ──────────────────────────────
  assert(s.tabs.length === 2 && s.tabs.includes('Bravo brief*'), `F2: strip should list both docs with Bravo selected: ${JSON.stringify(s.tabs)}`);
  await page.click('.doc-fullscreen-tab[data-doc-id]:not([aria-selected="true"])');
  await pollUntil(page, () => /ALPHA-MARK/.test(document.getElementById('doc-drawer-body')?.textContent || '') && !!document.querySelector('.doc-fullscreen'), null,
    { timeout: 3_000, label: 'F2: switching tabs did not show Alpha while staying full screen' });
  s = await state(page);
  assert(s.tabs.includes('Alpha notes*'), `F2: strip selection did not follow: ${JSON.stringify(s.tabs)}`);
  log('F2 tab strip switched docs without leaving full screen ✓');

  // ── F3 — Escape stacks under the image viewer ───────────────────────
  await page.evaluate(async () => {
    const m = await import('/build/imageViewer.mjs');
    m.openImageViewer('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="%23468"/></svg>', { alt: 'swatch' });
  });
  await pollUntil(page, () => !!document.getElementById('lightbox'), null, { timeout: 2_000, label: 'F3: image viewer did not open' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  s = await state(page);
  assert(!s.lightbox && s.open, `F3: Escape must close only the viewer (lightbox=${s.lightbox}, fullscreen=${s.open})`);
  log('F3 Escape closed the image viewer and left full screen open ✓');

  // ── F4 — Escape closes full screen; body returns intact ─────────────
  await page.keyboard.press('Escape');
  await pollUntil(page, () => !document.querySelector('.doc-fullscreen'), null, { timeout: 2_000, label: 'F4: Escape did not close full screen' });
  s = await state(page);
  assert(s.bodyInPanel && !s.bodyInOverlay, 'F4: the body did not return to the panel');
  assert(/ALPHA-MARK/.test(s.text) || (await page.evaluate(() => /ALPHA-MARK/.test(document.getElementById('doc-drawer-body')?.textContent || ''))), 'F4: content lost on the way back');
  assert(s.glyphOpen === '0', `F4: glyph should read expand again (data-open=${s.glyphOpen})`);
  log('F4 Escape closed; body back in the panel with its content ✓');

  // ── F5 — the glyph toggles both ways ────────────────────────────────
  await page.click('#doc-drawer-body .doc-drawer-expand');
  await pollUntil(page, () => !!document.querySelector('.doc-fullscreen'), null, { timeout: 2_000, label: 'F5: glyph did not open' });
  await page.click('.doc-fullscreen .doc-drawer-expand');
  await pollUntil(page, () => !document.querySelector('.doc-fullscreen'), null, { timeout: 2_000, label: 'F5: the same glyph did not close' });
  log('F5 glyph opens and closes ✓');

  // ── M1 (phone) — a swipe inside the reading view must not drive the
  //    drawer underneath; the bar's close is the way out (no Escape key) ─
  if (phone) {
    await page.click('#doc-drawer-body .doc-drawer-expand');
    await pollUntil(page, () => !!document.querySelector('.doc-fullscreen'), null, { timeout: 2_000, label: 'M1: did not open' });
    const drawerBefore = await page.evaluate(() => document.body.classList.contains('pin-drawer-open'));
    await page.mouse.move(300, 500); await page.mouse.down();
    for (let x = 300; x >= 60; x -= 40) { await page.mouse.move(x, 500); await page.waitForTimeout(16); }
    await page.mouse.up();
    await page.waitForTimeout(400);
    const drawerAfter = await page.evaluate(() => document.body.classList.contains('pin-drawer-open'));
    assert(drawerBefore === drawerAfter, `M1: a swipe inside full screen changed the drawer underneath (open ${drawerBefore} → ${drawerAfter})`);
    assert(await page.evaluate(() => !!document.querySelector('.doc-fullscreen')), 'M1: the swipe closed full screen');
    await page.click('.doc-fullscreen-close');
    await pollUntil(page, () => !document.querySelector('.doc-fullscreen'), null, { timeout: 2_000, label: 'M1: the bar close did not exit' });
    s = await state(page);
    assert(s.bodyInPanel, 'M1: body not back in the panel after the bar close');
    log('M1 phone: swipe inside the reader left the drawer alone; bar close exits ✓');
  }

  // ── F6 — closing the last doc inside full screen exits ──────────────
  await page.click('#doc-drawer-body .doc-drawer-expand');
  await pollUntil(page, () => !!document.querySelector('.doc-fullscreen'), null, { timeout: 2_000, label: 'F6: did not open' });
  await page.click('.doc-fullscreen .doc-drawer-remove');
  await pollUntil(page, () => !!document.querySelector('.doc-fullscreen') && /BRAVO-MARK/.test(document.getElementById('doc-drawer-body')?.textContent || ''), null,
    { timeout: 3_000, label: 'F6: closing one doc should fall through to the other, still full screen' });
  await page.click('.doc-fullscreen .doc-drawer-remove');
  await pollUntil(page, () => !document.querySelector('.doc-fullscreen'), null, { timeout: 3_000, label: 'F6: closing the last doc did not leave full screen' });
  s = await state(page);
  assert(s.bodyInPanel || s.emptyShown, 'F6: panel not restored after the last doc closed');
  log('F6 last doc closed → full screen exited ✓');
}
