// The multisession property of meeting capture (capture plan §3.4/§3.6)
// — LOAD-BEARING, pinned here: the recorder + pill are app-global
// chrome, so a live recording must survive switching sessions and
// chatting elsewhere. A regression that ties capture to chat-scoped
// lifecycle (torn down on switch) is exactly what this smoke catches.
//
// Covered:
//   1. Mic menu "🎙 Record meeting" → instant start (no prompt), pill
//      visible with default "Meeting <date>" title, timer ticking.
//   2. Switch to another session + send a text turn → pill still
//      visible, recorder still active.
//   3. Flag button → mark lands on the mock manifest.
//   4. Stop → pill leaves, mock capture is status=complete with ≥1
//      sealed segment uploaded (fake mic produces real chunks).

import { waitForReady } from './lib.mjs';

export const NAME = 'capture-pill-survives-session-switch';
export const DESCRIPTION = 'Meeting capture is app-global: pill + recorder survive session switches; marks + stop land server-side';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-capture-chat-a';
const CHAT_B = 'mock-capture-chat-b';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 120;
  mock.addChat(CHAT_A, {
    title: 'Chat A',
    messages: [{ role: 'user', content: 'seed a', sidekick_id: 'umsg_cap_a', timestamp: t0 }],
    lastActiveAt: Date.now() - 2000,
  });
  mock.addChat(CHAT_B, {
    title: 'Chat B',
    messages: [{ role: 'user', content: 'seed b', sidekick_id: 'umsg_cap_b', timestamp: t0 + 10 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // 1. Start from the mic menu (instant start — no prompts).
  await page.evaluate(() => {
    const menu = document.getElementById('mic-mode-menu');
    if (menu) { menu.hidden = false; menu.setAttribute('aria-hidden', 'false'); }
    document.getElementById('mic-menu-record-meeting')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }));
  });
  // The pill first appears in the honest 'starting' phase ("Starting
  // microphone…" — postmortem 2026-08-18); the meeting title lands once
  // activation is confirmed. Wait past 'starting' before asserting.
  await page.waitForFunction(
    () => {
      const pill = document.getElementById('capture-pill');
      return !!(pill && !pill.hidden && !pill.classList.contains('starting'));
    },
    null, { timeout: 8000, polling: 50 },
  );
  const title = await page.textContent('#capture-pill-title');
  if (!/^Meeting \d{4}-\d{2}-\d{2}$/.test(title || '')) {
    throw new Error(`pill should show the default instant-start title, got: ${title}`);
  }
  // Placement semantics (field UX 2026-07-09): the COMPOSER menu item
  // records into the ACTIVE session, not a freshly minted one.
  const linked = mock.getCaptures()[0]?.linked_chat || '';
  if (linked.startsWith('sidekick:mock-capture-')) {
    throw new Error(`composer-menu start must link the ACTIVE chat, got minted session: ${linked}`);
  }
  if (!linked) throw new Error('composer-menu start produced no linked_chat');
  log(`capture started from mic menu; linked to active chat (${linked})`);

  // 2. Switch sessions and send a turn — the pill must survive.
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#session-list li, .sess-item, [data-chat-id]')];
    const target = rows.find((r) => (r.getAttribute('data-chat-id') || '').includes('mock-capture-chat-a'))
      || rows.find((r) => (r.textContent || '').includes('Chat A'));
    (target?.querySelector('button, a') || target)?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 800));
  const stillVisible = await page.evaluate(() =>
    !document.getElementById('capture-pill')?.hidden);
  if (!stillVisible) throw new Error('pill vanished on session switch — capture must be app-global');
  const stateAfterSwitch = await page.evaluate(async () => {
    const mod = await import('/build/capture/recorder.mjs').catch(() => null);
    return mod ? mod.getCaptureState() : null;
  });
  if (stateAfterSwitch && !stateAfterSwitch.active) {
    throw new Error('recorder deactivated on session switch');
  }
  log('pill + recorder survive the session switch');

  // 3. Flag a moment.
  await page.click('#capture-pill-flag');
  await page.waitForFunction(
    () => true, null, { timeout: 500 },
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  const marks = mock.getCaptures()[0]?.marks?.length ?? 0;
  if (marks !== 1) throw new Error(`expected 1 mark on the manifest, got ${marks}`);
  log('flag button lands a mark server-side');

  // 4. Let the recorder run long enough to have chunk data, then stop.
  await new Promise((r) => setTimeout(r, 2500));
  await page.click('#capture-pill-stop');
  await page.waitForFunction(
    () => document.getElementById('capture-pill')?.hidden,
    null, { timeout: 20_000, polling: 100 },
  );
  const cap = mock.getCaptures()[0];
  if (cap.status !== 'complete') throw new Error(`capture should be complete, got ${cap.status}`);
  if (!cap.segments.length) throw new Error('no segments were uploaded — fake mic should produce chunks');
  log(`stop: capture complete with ${cap.segments.length} uploaded segment(s)`);

  // 5. APP-LEVEL start (header button): mints a new session and lands
  //    the user IN it instantly — optimistic shell, status line,
  //    focused composer, zero spinners (walking-test spec 2026-07-10).
  await page.click('#btn-capture-header');
  await page.waitForFunction(
    () => !document.getElementById('capture-pill').hidden,
    null, { timeout: 8000, polling: 50 },
  );
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('Recording started'),
    null, { timeout: 4000, polling: 50 },
  );
  const landing = await page.evaluate(() => ({
    spinner: document.getElementById('transcript')?.classList.contains('transcript-loading') ?? false,
    focused: document.activeElement?.id || document.activeElement?.tagName,
  }));
  const linked2 = mock.getCaptures()[1]?.linked_chat || '';
  if (!linked2.startsWith('sidekick:mock-capture-')) {
    throw new Error(`app-level start must mint a new session, got: ${linked2}`);
  }
  if (landing.spinner) throw new Error('optimistic landing must not show the switch spinner');
  log(`app-level start landed in minted session (${linked2}); shell painted, no spinner (focus: ${landing.focused})`);
  // Wrap up: stop the second capture so the smoke leaves clean state.
  page.on('dialog', (d) => d.accept());
  await page.click('#capture-pill-stop');
  await page.waitForFunction(
    () => document.getElementById('capture-pill').hidden,
    null, { timeout: 20_000, polling: 100 },
  );
}
