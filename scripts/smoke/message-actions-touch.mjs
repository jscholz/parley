// Phone layout (2026-11-05): the message actions are always on, dimmed —
// tap-to-reveal "is probably not obvious to people". The row hangs below
// the bubble, so it costs nothing inside it.
import { waitForReady, assert } from './lib.mjs';

export const NAME = 'message-actions-touch';
export const DESCRIPTION = 'Phone: message action icons are visible at rest (dimmed), no tap needed; the stamp stays';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = true;

const CHAT = 'parley:touch-footer';
export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  mock.addChat(CHAT, { title: 'Touch', messages: [
    { role: 'user', content: 'a question', parley_id: 'umsg_t1', timestamp: t0 },
    { role: 'assistant', content: 'an answer', parley_id: 'msg_t1', timestamp: t0 + 1 },
  ], lastActiveAt: Date.now() });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  // Open the chat the way a notification tap does — the desktop sidebar
  // toggle is not a phone affordance.
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('parley:open-chat', { detail: { chatId: id, msgId: null } })), CHAT);
  await page.waitForFunction(() => /an answer/.test(document.getElementById('transcript')?.textContent || ''), null, { timeout: 5_000 });
  const probe = await page.evaluate(() => {
    const hoverNone = matchMedia('(hover: none)').matches;
    const rows = ['#transcript .line.s0[data-message-id="umsg_t1"]', '#transcript .line.agent[data-message-id="msg_t1"]'].map((s) => {
      const l = document.querySelector(s);
      const acts = Array.from(l.querySelectorAll('.msg-foot .act')).map((a) => parseFloat(getComputedStyle(a).opacity));
      return { acts, min: Math.min(...acts), stamp: parseFloat(getComputedStyle(l.querySelector('.msg-foot .line-ts-rel')).opacity) };
    });
    return { hoverNone, rows };
  });
  log(`hover:none=${probe.hoverNone}; icon opacities at rest user=${JSON.stringify(probe.rows[0].acts)} agent=${JSON.stringify(probe.rows[1].acts)}`);
  assert(probe.hoverNone, 'this variant must run under (hover: none)');
  for (const r of probe.rows) {
    assert(r.acts.length >= 3 && r.min > 0.2, `phone: action icons must be visible at rest, got ${JSON.stringify(r.acts)}`);
    assert(r.stamp > 0, 'phone: the stamp must stay visible');
  }
  const tall = await page.evaluate(() => Array.from(document.querySelectorAll('#transcript .msg-foot')).map((f) => Math.round(f.getBoundingClientRect().height)).filter((h) => h > 28));
  assert(tall.length === 0, `phone: a footer wrapped to a second line (heights ${JSON.stringify(tall)}) — row heights must not depend on the stamp text`);
  log('phone: actions always on, dimmed; footers single-line ✓');
}
