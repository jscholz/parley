// cmd+K stable repaint (2026-11-08): "it would do a local search first,
// generate results, and then hit the server, and it would shift, and it
// was like a clickjacking thing."
//
// The rule: rows move only on the user's own input — a keystroke, Tab,
// or the → pill. A late server answer:
//   S1  with the pointer OVER the results: nothing changes; a pill says
//       results are waiting; moving the pointer (or →) applies them
//   S2  with the pointer away: painted rows keep their index; newcomers
//       append below; the sections' status lines keep their slots so
//       nothing jumps into existence above the cursor
//   S3  the instant local paint is capped small in All (3) so the
//       server's answer is never buried under local rows

import { waitForReady, assert, pollUntil } from './lib.mjs';

export const NAME = 'cmdk-stable-repaint';
export const DESCRIPTION = 'cmd+K: a late server answer never moves rows under the pointer (pill + deferral), painted rows keep their position, local instant rows are capped';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  const t = Date.now();
  for (let i = 0; i < 6; i++) {
    mock.addChat(`parley:stable-${i}`, { title: `Stable plan ${i}`, messages: [{ role: 'user', content: `stable body ${i}`, parley_id: `umsg_st${i}`, timestamp: t / 1000 - 1000 + i }], lastActiveAt: t - (10 - i) * 60_000 });
  }
}

const sessionIds = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.cmdk-row[data-kind="session"]')).map((li) => li.dataset.id));
const pill = (page) => page.evaluate(() => { const p = document.querySelector('.cmdk-pill'); return p && !p.hidden ? p.textContent : ''; });

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  mock.setSearchDelay('stable', 900);

  // ── S1 — pointer over the results when the answer lands ───────────
  await page.keyboard.press('Control+K');
  await page.waitForSelector('.cmdk-dialog[open]', { timeout: 5_000 });
  await page.type('.cmdk-input', 'stable');
  await pollUntil(page, () => document.querySelectorAll('.cmdk-row[data-kind="session"]').length > 0, null, { timeout: 3_000, label: 'instant local rows did not paint' });
  const instant = await sessionIds(page);
  log(`instant local rows: ${JSON.stringify(instant)}`);
  assert(instant.length <= 3, `S3: the instant paint in All is capped at 3, got ${instant.length}`);
  // Park the pointer on the first row before the (900 ms) answer arrives.
  const box = await page.locator('.cmdk-row[data-kind="session"]').first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1500);
  const held = await sessionIds(page);
  const pillText = await pill(page);
  log(`S1 after the answer with the pointer parked: rows ${JSON.stringify(held)}, pill "${pillText}"`);
  assert(JSON.stringify(held) === JSON.stringify(instant), 'S1: rows changed under the parked pointer');
  assert(/Results updated/.test(pillText), `S1: the pill should announce the waiting answer, got "${pillText}"`);
  // Moving the pointer applies it; rows that were painted keep their index.
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 2);
  await pollUntil(page, () => document.querySelectorAll('.cmdk-row[data-kind="session"]').length > 3, null, { timeout: 3_000, label: 'S1: moving the pointer did not apply the answer' });
  const applied = await sessionIds(page);
  log(`S1 applied: ${JSON.stringify(applied)}`);
  for (let i = 0; i < instant.length; i++) assert(applied[i] === instant[i], `S2: painted row ${i} moved (${instant[i]} → ${applied[i]})`);
  assert(applied.length === 6, `S2: the server's rows should all be there, got ${applied.length}`);
  assert((await pill(page)) === '' || !/Results updated/.test(await pill(page)), 'S1: the "updated" pill must clear once applied');

  // ── S2 — pointer away: stable paint without the pill ─────────────
  await page.mouse.move(5, 5);
  await page.fill('.cmdk-input', '');
  await page.type('.cmdk-input', 'stable plan');
  await pollUntil(page, () => document.querySelectorAll('.cmdk-row[data-kind="session"]').length > 0, null, { timeout: 3_000, label: 'S2: no instant rows' });
  const before = await sessionIds(page);
  const statusBefore = await page.evaluate(() => document.querySelector('.cmdk-messages-status')?.textContent || '');
  assert(statusBefore === '…', `S2: the Messages section should hold its slot with a pending status, got "${statusBefore}"`);
  await pollUntil(page, () => document.querySelectorAll('.cmdk-row[data-kind="session"]').length > 3, null, { timeout: 4_000, label: 'S2: the answer did not paint' });
  const after = await sessionIds(page);
  for (let i = 0; i < before.length; i++) assert(after[i] === before[i], `S2: painted row ${i} moved (${before[i]} → ${after[i]})`);
  const p2 = await pill(page);
  assert(!/Results updated/.test(p2), `S2: no deferral pill when the pointer is away, got "${p2}"`);
  log(`S2 stable append: ${JSON.stringify(before)} → ${JSON.stringify(after)}, pill "${p2}" ✓`);
  mock.setSearchDelay('stable', 0);
}
