// Meeting-polish #25 titling, client leg: when the capture pipeline
// re-titles the meeting session at end-of-meeting (proxy-side logic —
// captureTranscribe finalize → upstream rename → session_changed
// envelope; unit-tested in proxy/parley/__tests__), the DRAWER must
// pick the new title up in place, including for a session that was
// MINTED by the capture (freshly materialized upstream mid-meeting,
// not part of the boot-time sessions list).
//
// The ingest/titling pipeline itself is mocked (smokes run the client
// against mock-backend page routes; the proxy pipeline never sees
// these captures): the mock materializes the minted session the way
// hermes does when the start message lands, and after stop it emits
// the same session_changed the real re-title produces.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'meeting-end-retitle';
export const DESCRIPTION = 'end-of-meeting re-title (session_changed after capture stop) lands on the minted session row';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const TOPICAL_TITLE = 'Meeting: Transcript Migration, Rollout';

export function MOCK_SETUP(mock) {
  mock.addChat('mock-retitle-prior', {
    title: 'Prior chat',
    messages: [{ role: 'user', content: 'seed', sidekick_id: 'umsg_rt_seed', timestamp: Date.now() / 1000 - 60 }],
    lastActiveAt: Date.now() - 2000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // 1. App-level start (header button): mints a dedicated meeting
  //    session and jumps the view into it.
  await page.click('#btn-capture-header');
  // Wait past the honest 'starting' phase (activation confirmed) so the
  // stop click below acts on a live recording, not a no-op.
  await page.waitForFunction(
    () => {
      const pill = document.getElementById('capture-pill');
      return !!(pill && !pill.hidden && !pill.classList.contains('starting'));
    },
    null, { timeout: 8000, polling: 50 },
  );
  const cap = mock.getCaptures()[0];
  const minted = cap.linked_chat;
  assert(
    String(minted || '').startsWith('sidekick:mock-capture-'),
    `app-level start should mint a session, got: ${minted}`,
  );
  log(`capture ${cap.id} recording into minted session ${minted}`);

  // 2. Mimic the upstream materializing the session when the proxy's
  //    start message lands (real hermes creates the row + placeholder
  //    title within seconds of capture start).
  mock.addChat(minted, {
    title: `Meeting ${new Date().toISOString().slice(0, 10)}`,
    messages: [{
      role: 'user',
      content: '📼 Recording started. Live transcript: /tmp/transcript.md',
      sidekick_id: 'umsg_rt_start',
      timestamp: Date.now() / 1000,
    }],
    lastActiveAt: Date.now(),
  });

  // 3. Record briefly, then stop.
  await new Promise((r) => setTimeout(r, 1500));
  await page.click('#capture-pill-stop');
  await page.waitForFunction(
    () => document.getElementById('capture-pill')?.hidden,
    null, { timeout: 20_000, polling: 100 },
  );
  assert(mock.getCaptures()[0].status === 'complete', 'capture should be complete after stop');

  // 4. The pipeline's end-of-meeting re-title → session_changed. The
  //    drawer row for the minted session must flip to the topical
  //    title IN PLACE (no reload, no click-away).
  mock.pushSessionChanged(minted, TOPICAL_TITLE);
  log('pushed end-of-meeting session_changed re-title');
  try {
    await page.waitForFunction(
      ({ chatId, title }) => {
        const li = document.querySelector(`#sessions-list li[data-chat-id="${chatId}"]`);
        return li?.textContent?.includes(title) ?? false;
      },
      { chatId: minted, title: TOPICAL_TITLE },
      { timeout: 4000, polling: 50 },
    );
  } catch {
    const row = await page.locator(`#sessions-list li[data-chat-id="${minted}"]`).first()
      .textContent().catch(() => '(row not found)');
    throw new Error(
      `minted meeting session did not pick up the end-of-meeting re-title.\n`
      + `  expected to include: ${JSON.stringify(TOPICAL_TITLE)}\n`
      + `  row text:            ${JSON.stringify(row)}`,
    );
  }
  log(`drawer row re-titled to "${TOPICAL_TITLE}" ✓`);
}
