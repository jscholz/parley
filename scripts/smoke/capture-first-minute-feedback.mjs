// FIELD GUARD, Jonathan 2026-11-02 (laptop, meeting capture):
//
//   "when I start recording on laptop I should get a transcript
//    immediately, and an indicator that shows the status of the chunk
//    coming in (eg a pie icon filling out). I don't see anything."
//
// The first minute of a recording used to be blank: the transcript doc
// reached the Docs shelf only after the first 45 s chunk had uploaded
// and transcribed, and the pill said nothing about any of that.
//
//   D1  the live transcript doc is on the shelf within a second of the
//       recording going live, titled "(live)", bound to this capture,
//       and honest about waiting for the first words
//   P1  the pill shows a pie that is filling — two samples a second
//       apart differ, and the label counts seconds of the chunk
//   P2  pause seals the chunk at once: the ring says the chunk is
//       uploading / transcribing (the mock acks uploads instantly, so
//       'transcribing' is what sticks)
//   P3  the proxy's transcript push for this capture → ring 'landed',
//       landed count 1
//   P4  resume → a fresh chunk, pie restarts near zero, label says chunk 2

import { waitForReady, pollUntil } from './lib.mjs';

export const NAME = 'capture-first-minute-feedback';
export const DESCRIPTION = 'Recording: the live transcript doc appears at once; the pill pie fills over the chunk and its ring reports the last chunk uploading → transcribing → landed';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-capture-feedback-chat';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Feedback room',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_cap_fb', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 1000,
  });
}

const recorderState = (page) => page.evaluate(async () => {
  const mod = await import('/build/capture/recorder.mjs');
  const s = mod.getCaptureState();
  return { phase: s.phase, captureId: s.captureId, sealed: s.sealedSegments, uploaded: s.uploadedSegments, landed: s.landedSegments, segStart: s.segmentStartedAt };
});

const pie = (page) => page.evaluate(() => {
  const svg = document.getElementById('capture-pill-pie');
  const fill = svg?.querySelector('.pie-fill');
  const shown = !!svg && getComputedStyle(svg).display !== 'none';
  const dash = fill ? (fill.style.strokeDasharray || getComputedStyle(fill).strokeDasharray) : '';
  return { shown, chunk: svg?.getAttribute('data-chunk'), pct: parseFloat(String(dash)) || 0, label: svg?.querySelector('title')?.textContent || '' };
});

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await page.evaluate(() => {
    const menu = document.getElementById('mic-mode-menu');
    if (menu) { menu.hidden = false; menu.setAttribute('aria-hidden', 'false'); }
    document.getElementById('mic-menu-record-meeting')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const pill = document.getElementById('capture-pill');
    return !!(pill && !pill.hidden && !pill.classList.contains('starting'));
  }, null, { timeout: 8000, polling: 50 });
  const t0 = Date.now();
  const st0 = await recorderState(page);
  if (st0.phase !== 'recording') throw new Error(`capture not recording: ${JSON.stringify(st0)}`);
  const failures = [];

  // ── D1 — the live doc is there at once ─────────────────────────────
  const doc = await pollUntil(
    page,
    (capId) => import('/build/rightDrawer/docStore.mjs').then((m) => {
      const d = m.listDocs().find((x) => x.captureId === capId);
      return d ? { title: d.title, content: String(d.content || '').slice(0, 300) } : false;
    }),
    st0.captureId,
    { timeout: 4_000, label: 'D1: no live transcript doc on the shelf after the recording went live' },
  ).catch((e) => { failures.push(e.message); return null; });
  if (doc) {
    log(`D1 doc on the shelf ${Date.now() - t0} ms after live: ${JSON.stringify(doc.title)}`);
    if (!/\(live\)$/.test(doc.title)) failures.push(`D1: doc title is not marked live: ${doc.title}`);
    if (!/first words land/.test(doc.content)) failures.push(`D1: the empty doc does not say what it is waiting for: ${JSON.stringify(doc.content)}`);
  }

  // ── P1 — the pie is filling ────────────────────────────────────────
  await page.waitForTimeout(1_200);
  const a = await pie(page);
  await page.waitForTimeout(1_100);
  const b = await pie(page);
  log(`P1 pie: shown=${b.shown} ${a.pct}% → ${b.pct}% label=${JSON.stringify(b.label)}`);
  if (!b.shown) failures.push('P1: no pie on the pill while recording');
  if (!(b.pct > a.pct)) failures.push(`P1: the pie is not filling (${a.pct}% → ${b.pct}%)`);
  if (!/^Chunk 1: \d+ s of 45 s · first chunk$/.test(b.label)) failures.push(`P1: pie label ${JSON.stringify(b.label)}`);

  // ── P2 — pause seals the chunk; the ring reports its fate ──────────
  await page.click('#capture-pill-pause');
  const p2 = await pollUntil(
    page,
    () => document.getElementById('capture-pill-pie')?.getAttribute('data-chunk') === 'transcribing',
    null,
    { timeout: 6_000, label: 'P2: the sealed chunk never reached "transcribing"' },
  ).catch((e) => { failures.push(e.message); return false; });
  const st2 = await recorderState(page);
  log(`P2 after pause: ${JSON.stringify(st2)} ring=${(await pie(page)).chunk}`);
  if (p2 && (st2.sealed !== 1 || st2.uploaded !== 1)) failures.push(`P2: expected 1 sealed + uploaded chunk, got ${JSON.stringify(st2)}`);

  // ── P3 — the transcript push lands the chunk ───────────────────────
  mock.pushEnvelope({
    type: 'doc_show', chat_id: CHAT_ID, title: 'Meeting (live)', format: 'markdown',
    path: `/captures/${st0.captureId}/transcript.md`, source: 'capture', capture_id: st0.captureId,
    content: '# Meeting\n\n_Live transcript — recording in progress; updates roughly every minute._\n\n**[+0:00]** the first words.\n',
    displayed_at: Date.now(),
  });
  await pollUntil(
    page,
    () => import('/build/capture/recorder.mjs').then((m) => m.getCaptureState().landedSegments === 1),
    null,
    { timeout: 4_000, label: 'P3: the transcript push was not counted as a landed chunk' },
  ).catch((e) => failures.push(e.message));
  const ring3 = (await pie(page)).chunk;
  log(`P3 after the transcript push: ring=${ring3}`);
  if (ring3 !== 'landed') failures.push(`P3: ring should say landed, got ${ring3}`);

  // ── P4 — resume starts chunk 2 from empty ──────────────────────────
  await page.click('#capture-pill-pause');
  await pollUntil(page, () => import('/build/capture/recorder.mjs').then((m) => m.getCaptureState().phase === 'recording'), null,
    { timeout: 6_000, label: 'P4: resume never returned to recording' }).catch((e) => failures.push(e.message));
  await page.waitForTimeout(1_200);
  const c = await pie(page);
  log(`P4 after resume: ${c.pct}% label=${JSON.stringify(c.label)} ring=${c.chunk}`);
  if (!c.shown || c.pct > 10) failures.push(`P4: chunk 2 did not restart the pie (${c.pct}%)`);
  if (!/^Chunk 2: /.test(c.label)) failures.push(`P4: label should count chunk 2: ${JSON.stringify(c.label)}`);

  await page.click('#capture-pill-stop');
  if (failures.length) throw new Error(failures.join('\n'));
}
