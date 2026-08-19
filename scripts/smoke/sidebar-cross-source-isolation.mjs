// Scenario: two sessions whose underlying platform chat_id collides
// across sources (e.g. one `sidekick:199999999999999@lid` test session
// and one `whatsapp:199999999999999@lid` real WhatsApp thread) must
// render as TWO distinct drawer rows, click-isolate, and resume the
// correct transcript per row.
//
// Background (2026-05-02 bug): the hermes plugin used to expose
// `id = chat_id`, which is unique only under `(source, chat_id)`. When
// a parley test session happened to use a WhatsApp lid as its
// chat_id, two rows came back with identical `data-chat-id`; click
// activated both LIs, history fetch went through
// _resolve_source_for_chat_id which picks one source arbitrarily, and
// the user saw "history mangled" + read-only-composer on the wrong
// row. Plugin fix: prefix-encode `id = ${source}:${chat_id}`.
//
// This smoke locks in the post-fix invariant — distinct prefixed ids
// → distinct rows → distinct clicks → correct transcript replay. If
// the plugin ever regresses to bare-chat_id encoding, this will fail
// at the "two rows rendered" assertion.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'sidebar-cross-source-isolation';
export const DESCRIPTION = 'Same native chat_id under two sources → two rows, click-isolated';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

// The shared underlying chat_id — what the platform sees. The real bug
// involved a WhatsApp @lid; mock that exact shape so the smoke stays
// recognizable to anyone debugging future regressions.
const NATIVE_CHAT_ID = '199999999999999@lid';
const SK_ID = `sidekick:${NATIVE_CHAT_ID}`;
const WA_ID = `whatsapp:${NATIVE_CHAT_ID}`;

export function MOCK_SETUP(mock) {
  const now = Date.now();
  // Distinct ids, distinct sources, distinct content. Source field
  // mirrors the post-fix gateway shape — the mock backend echoes
  // whatever source we pass.
  mock.addChat(SK_ID, {
    title: 'Barge in test with cookie explanation',
    source: 'sidekick',
    messages: [
      { role: 'user', content: 'parley-marker-cookies', timestamp: now / 1000 - 60 },
      { role: 'assistant', content: 'parley-reply-cookies-are-tiny', timestamp: now / 1000 - 59 },
    ],
    lastActiveAt: now - 120_000,
  });
  mock.addChat(WA_ID, {
    title: 'Voice Message Test Confirmation',
    source: 'whatsapp',
    messages: [
      { role: 'user', content: 'whatsapp-marker-voice-memo', timestamp: now / 1000 - 30 },
      { role: 'assistant', content: 'whatsapp-reply-okay-one-two-three', timestamp: now / 1000 - 29 },
    ],
    lastActiveAt: now - 60_000,
  });
}

async function clickRow(page, id) {
  // data-chat-id values containing `:` and `@` are valid in CSS attribute
  // selectors when quoted; no escape needed.
  await page.locator(`#sessions-list li[data-chat-id="${id}"] .sess-body`)
    .first().click();
}

async function activeIds(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#sessions-list li.active'))
      .map(li => li.getAttribute('data-chat-id'))
      .sort(),
  );
}

async function transcriptText(page) {
  return page.evaluate(() => document.getElementById('transcript')?.textContent || '');
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Both rows must render — distinct ids mean distinct LIs.
  const skLi = await page.locator(`#sessions-list li[data-chat-id="${SK_ID}"]`).count();
  const waLi = await page.locator(`#sessions-list li[data-chat-id="${WA_ID}"]`).count();
  assert(skLi === 1, `expected 1 parley LI; got ${skLi}`);
  assert(waLi === 1, `expected 1 whatsapp LI; got ${waLi}`);
  log('two rows rendered ✓');

  // Click parley row → only it is active, transcript shows parley content.
  await clickRow(page, SK_ID);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('parley-marker-cookies'),
    null, { timeout: 5_000, polling: 50 },
  );
  let active = await activeIds(page);
  assert(active.length === 1 && active[0] === SK_ID,
    `after sk click: expected only [${SK_ID}] active; got ${JSON.stringify(active)}`);
  let t = await transcriptText(page);
  assert(!t.includes('whatsapp-marker'),
    `after sk click: transcript leaked whatsapp content. sample=${JSON.stringify(t.slice(0, 200))}`);
  log('click parley row → only parley active + transcript matches ✓');

  // Click whatsapp row → only it is active, transcript shows whatsapp content.
  // The previous click's parley state must NOT linger.
  await clickRow(page, WA_ID);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('whatsapp-marker-voice-memo'),
    null, { timeout: 5_000, polling: 50 },
  );
  active = await activeIds(page);
  assert(active.length === 1 && active[0] === WA_ID,
    `after wa click: expected only [${WA_ID}] active; got ${JSON.stringify(active)}`);
  t = await transcriptText(page);
  assert(!t.includes('parley-marker'),
    `after wa click: transcript leaked parley content. sample=${JSON.stringify(t.slice(0, 200))}`);
  log('click whatsapp row → only whatsapp active + transcript matches ✓');

  // Bounce-back guard: after the second click settles, hold and
  // re-verify nothing flips back. Catches a stale resume callback
  // overwriting state out of order.
  await page.waitForTimeout(600);
  active = await activeIds(page);
  assert(active.length === 1 && active[0] === WA_ID,
    `bounce-back: active flipped after settle; got ${JSON.stringify(active)}`);
  log('no bounce-back after 600ms ✓');
}
