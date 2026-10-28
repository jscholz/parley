// Field 2026-10-28: dragging the right panel cost 46 ms per frame (78 max)
// with 1,097 transcript rows in the DOM — every frame re-wrapped every row
// because the transcript's width followed the panel live. Now the
// transcript's offset is frozen for the drag (--pin-drawer-pad) and it
// re-wraps once on release: per-frame cost no longer scales with rows.
import { waitForReady, assert } from './lib.mjs';

export const NAME = 'drawer-drag-defers-reflow';
export const DESCRIPTION = 'Right-panel drag: the panel resizes live, the transcript keeps its width until release, then takes the new width once';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'parley:drawer-drag-defers-reflow';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, { title: 'drag', lastActiveAt: Date.now() - 1000, messages: Array.from({ length: 120 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `message ${i} ` + 'lorem ipsum dolor sit amet '.repeat(10), parley_id: `m${i}`, timestamp: Date.now() / 1000 - 6000 + i * 5 })) });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT_ID, title: 'Alpha', content: '# Alpha\n\nA', format: 'markdown', path: '/w/a.md' });
  await page.waitForFunction(() => document.querySelectorAll('#doc-rail-tabs .doc-rail-tab').length === 1, null, { timeout: 5000 });
  await page.waitForTimeout(500);
  const geom = () => page.evaluate(() => ({
    drawer: Math.round(document.getElementById('pin-drawer').getBoundingClientRect().width),
    pad: Math.round(parseFloat(getComputedStyle(document.body).paddingRight)),
    transcriptW: Math.round(document.getElementById('transcript').getBoundingClientRect().width),
    widthVar: Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pin-drawer-width')) || 0),
  }));
  const before = await geom();
  const hb = await (await page.$('#pin-drawer-resizer')).boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(hb.x - i * 6, hb.y + hb.height / 2);
  await page.waitForTimeout(100);
  const mid = await geom();
  assert(mid.drawer > before.drawer + 60, `panel resizes live during the drag: ${JSON.stringify({ before, mid })}`);
  assert(mid.pad === before.pad && mid.transcriptW === before.transcriptW, `transcript keeps its width during the drag: ${JSON.stringify({ before, mid })}`);
  log(`mid-drag: panel ${before.drawer}→${mid.drawer}px, transcript unchanged at ${mid.transcriptW}px ✓`);
  await page.mouse.up();
  // No easing: the transcript takes its new width in the first frame after
  // release (an eased padding re-wrapped every row on every frame).
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const after = await geom();
  assert(Math.abs(after.pad - after.widthVar) <= 1 && after.transcriptW < before.transcriptW - 60, `release: transcript takes the new width once: ${JSON.stringify({ before, after })}`);
  const padVar = await page.evaluate(() => document.documentElement.style.getPropertyValue('--pin-drawer-pad'));
  assert(padVar === '', `the freeze is cleared on release: "${padVar}"`);
  log(`release: transcript ${before.transcriptW}→${after.transcriptW}px, padding follows the panel ✓`);
}
