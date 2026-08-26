// B2 pill-HUD legibility: the pill's non-recording states (paused /
// interrupted / uploading / starting) used to differ mostly by dot
// COLOR (gray vs gray vs gray) plus a state suffix buried in the
// title's ellipsis zone — a long meeting title truncated "— paused"
// clean off a phone-width pill. Pinned here:
//   1. A dedicated state chip (#capture-pill-state) carries the state
//      WORD; it is flex:none so a long title can never truncate it.
//   2. Plain recording shows NO chip (red pulsing dot + running timer
//      already say it) and the title stays the meeting's name.
//   3. Chip words: Paused / Reconnecting… / Uploading…; the starting
//      phase keeps its full-title "Starting microphone…" copy.
//   4. The B1 control row (mark/pause/···/Stop) is untouched — its own
//      smoke (capture-pill-destructive-ergonomics) pins geometry; this
//      one just asserts presence so a chip regression that eats a
//      button fails loudly here too.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-pill-state-labels';
export const DESCRIPTION = 'pill states are legible by TEXT: paused/interrupted/uploading carry a chip word the title cannot truncate; recording shows none';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

/** Read the pill's legibility surface in one evaluate. */
function pillState(page) {
  return page.evaluate(() => {
    const chip = document.getElementById('capture-pill-state');
    const pill = document.getElementById('capture-pill');
    return {
      hidden: !!pill?.hidden,
      classes: pill?.className || '',
      chipHidden: !chip || chip.hidden,
      chipText: chip?.textContent || '',
      title: document.getElementById('capture-pill-title')?.textContent || '',
      timer: document.getElementById('capture-pill-timer')?.textContent || '',
      buttons: ['capture-pill-flag', 'capture-pill-pause', 'capture-pill-more', 'capture-pill-stop']
        .filter((id) => !!document.getElementById(id)).length,
    };
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // Real path: start → recording → paused → resumed.
  await page.keyboard.press('Control+Shift+M');
  await page.waitForFunction(
    () => {
      const pill = document.getElementById('capture-pill');
      return !!(pill && !pill.hidden && !pill.classList.contains('starting'));
    },
    null, { timeout: 15_000, polling: 50 },
  );
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && mock.getCaptures()[0]?.status !== 'recording') {
    await new Promise((r) => setTimeout(r, 100));
  }
  const recording = await pillState(page);
  assert(recording.chipHidden, 'plain recording must show NO state chip (dot + timer say it)');
  assert(/^Meeting \d{4}-\d{2}-\d{2}$/.test(recording.title),
    `recording title must be the meeting's name, got "${recording.title}"`);
  assert(recording.buttons === 4, `B1 control row must be intact (got ${recording.buttons}/4 buttons)`);

  await page.click('#capture-pill-pause');
  await page.waitForFunction(
    () => document.getElementById('capture-pill')?.classList.contains('paused'),
    null, { timeout: 5000, polling: 50 },
  );
  const paused = await pillState(page);
  assert(!paused.chipHidden && paused.chipText === 'Paused',
    `paused must carry the chip word "Paused", got hidden=${paused.chipHidden} text="${paused.chipText}"`);
  assert(!/paused/i.test(paused.title),
    `the state word must NOT ride the truncatable title, got "${paused.title}"`);
  assert(paused.timer.length > 0, 'elapsed time stays visible while paused');
  assert(paused.buttons === 4, 'pause must not eat any control-row button');
  log(`paused: chip="${paused.chipText}", title="${paused.title}", timer="${paused.timer}"`);

  await page.click('#capture-pill-pause');   // resume
  await page.waitForFunction(
    () => !document.getElementById('capture-pill')?.classList.contains('paused'),
    null, { timeout: 8000, polling: 50 },
  );
  const resumed = await pillState(page);
  assert(resumed.chipHidden, 'resume must clear the state chip');

  // Remaining phases, driven through the pill's real render path via
  // the same `parley:capture-state` event the recorder emits (the mic
  // interruption/upload-drain hardware states can't be staged from a
  // fake device — same synthetic-envelope approach the outage smokes
  // use for server states).
  const synth = (phase, extra = {}) => page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('parley:capture-state', { detail }));
  }, {
    active: phase !== 'finishing' && phase !== 'starting',
    captureId: 'cap_synth', title: 'A very long meeting title that would truncate any suffix',
    chatId: null, startedAt: Date.now() - 65_000, phase,
    uploaderPending: 0, sealedSegments: 1, marks: 0,
    stalledTotalMs: 0, stalledSince: Date.now(), ...extra,
  });

  await synth('interrupted');
  const interrupted = await pillState(page);
  assert(/interrupted/.test(interrupted.classes), 'interrupted class must apply');
  assert(!interrupted.chipHidden && interrupted.chipText === 'Reconnecting…',
    `interrupted must read "Reconnecting…", got "${interrupted.chipText}"`);
  assert(/A very long meeting title/.test(interrupted.title) && !/interrupted|resuming/i.test(interrupted.title),
    `interrupted title must stay the meeting name (chip carries the state), got "${interrupted.title}"`);

  await synth('finishing');
  const finishing = await pillState(page);
  assert(/finishing/.test(finishing.classes), 'finishing class must apply');
  assert(!finishing.chipHidden && finishing.chipText === 'Uploading…',
    `uploading-drain must read "Uploading…", got "${finishing.chipText}"`);
  assert(/A very long meeting title/.test(finishing.title),
    `finishing keeps the meeting title, got "${finishing.title}"`);

  await synth('starting');
  const starting = await pillState(page);
  assert(/starting/.test(starting.classes), 'starting class must apply');
  assert(/Starting microphone/i.test(starting.title),
    `starting keeps its honest full-title copy (postmortem P1), got "${starting.title}"`);
  assert(starting.chipHidden, 'starting needs no chip — its title IS the state word');

  log(`state words: recording=∅ paused=Paused interrupted=Reconnecting… finishing=Uploading… starting=title`);
}
