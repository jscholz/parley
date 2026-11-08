// FIELD 2026-11-08: "not on desktop it's not" — a change the live server
// already served was invisible in his open tab. A plain deploy rebuilds
// /build/* but leaves sw.js byte-identical, so the service-worker
// update detector never fires and nothing says a reload is waiting.
//
// The build-stamp watch (swLifecycle.initBuildStampWatch) re-reads
// build/version.json when the tab becomes visible and on a timer:
//   B1  the first read establishes the baseline — no hint
//   B2  a re-read with the SAME stamp — still no hint
//   B4  a failed read — no hint
//   B3  a NEWER builtAt — "· update ready" appears on the version label
//       (the same hint the SW detector uses), once
//
// Stamps are fed through checkBuildStamp's reader seam: the real fetch
// is answered by the service worker, which Playwright's routing never
// sees. The boot-time read establishes the real baseline first.

import { waitForReady, assert, pollUntil } from './lib.mjs';

export const NAME = 'build-update-hint';
export const DESCRIPTION = 'A newer build/version.json on the server puts "· update ready" on the version label; same stamp or a failed read never does';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  await waitForReady(page);
  const check = (stamp) => page.evaluate((s) => import('/build/swLifecycle.mjs').then((m) =>
    m.checkBuildStamp(async () => { if (s === 'FAIL') throw new Error('nope'); return s; })), stamp);
  const hint = () => page.evaluate(() => document.querySelector('#app-version .version-update-hint')?.textContent || '');

  // B1 — baseline. Boot read the real stamp already; reset so the first
  // read below IS the baseline and B3 is the one that trips the hint.
  await page.evaluate(() => import('/build/swLifecycle.mjs').then((m) => m.__resetBuildStampForTests()));
  const base = { sha: 'abc1234', builtAt: '2026-11-08T10:00:00.000Z' };
  const r1 = await check(base);
  log(`B1 → ${JSON.stringify(r1)}, hint "${await hint()}"`);
  assert(r1 === false && (await hint()) === '', 'B1: the first read is the baseline — no change, no hint');
  const hintAfterBase = '';
  // B2 — same stamp.
  const r2 = await check(base);
  assert(r2 === false && (await hint()) === hintAfterBase, 'B2: an unchanged stamp must not change anything');
  // B4 — failure.
  const r4 = await check('FAIL');
  assert(r4 === false && (await hint()) === hintAfterBase, 'B4: a failed read must not change anything');
  // B3 — newer build.
  const newer = { sha: 'def5678', builtAt: '2026-11-08T10:05:00.000Z' };
  const changed = await check(newer);
  assert(changed === true, 'B3: a newer stamp should report a change');
  await pollUntil(page, () => /update ready/.test(document.querySelector('#app-version .version-update-hint')?.textContent || ''), null, { timeout: 2_000, label: 'B3: the update-ready hint did not appear' });
  // Once: a further change adds no second hint.
  await check({ sha: 'fff', builtAt: '2026-11-08T10:10:00.000Z' });
  const hints = await page.evaluate(() => document.querySelectorAll('#app-version .version-update-hint').length);
  assert(hints === 1, `B3: the hint must appear once, found ${hints}`);
  log(`build stamp watch: same / failure → nothing; newer → "${await hint()}" ✓`);
}
