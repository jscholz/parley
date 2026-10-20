// Phone numbers in agent replies: tap → Call / Copy (field 2026-10-20).
// The field reply carried `[020 3974 6690](tel:+442****6690)` — hermes'
// redaction masked the target and the bold rule turned it into
// "+44 2<strong><strong>6690" on the iPhone dial sheet. Asserts the link
// is rebuilt from its label, and the tap menu calls and copies.

import { waitForReady, assert, pollUntil } from './lib.mjs';

export const NAME = 'phone-link-call-copy';
export const DESCRIPTION = 'Masked tel: link rebuilt from its label; tap opens Call / Copy; Copy puts the number on the clipboard';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = 'both';

const CHAT = 'parley:mock-phone-link';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 120;
  mock.addChat(CHAT, {
    title: 'Concierge numbers', lastActiveAt: Date.now() - 1000,
    messages: [
      { role: 'user', content: 'concierge number?', parley_id: 'umsg_phone_1', timestamp: t0 },
      { role: 'assistant', message_id: 'm-phone-1', timestamp: t0 + 5,
        content: 'Building concierge:\n\n- **Mobile:** [07929 767203](tel:+447****7203)\n- **Landline:** [020 3974 6690](tel:+442****6690)' },
    ],
  });
}

export default async function run({ page, log }) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await waitForReady(page);
  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, CHAT);
  await pollUntil(page, () => document.querySelectorAll('#transcript a.phone-link').length === 2, null,
    { timeout: 10_000, label: 'two phone links never rendered' });
  const links = await page.evaluate(() => [...document.querySelectorAll('#transcript a.phone-link')]
    .map((a) => ({ href: a.getAttribute('href'), text: a.textContent, html: a.outerHTML })));
  assert(links[0].href === 'tel:07929767203' && links[1].href === 'tel:02039746690', `hrefs not rebuilt: ${JSON.stringify(links)}`);
  assert(links.every((l) => !/strong/.test(l.href)), 'markup leaked into a tel: href');
  log(`links: ${links.map((l) => l.href).join(', ')}`);

  await page.locator('#transcript a.phone-link').nth(1).click();
  await pollUntil(page, () => !!document.querySelector('.phone-menu'), null, { timeout: 3_000, label: 'tap did not open the Call / Copy menu' });
  const items = await page.evaluate(() => [...document.querySelectorAll('.phone-menu .phone-menu-item')]
    .map((i) => ({ text: i.textContent, href: i.getAttribute('href') })));
  assert(items[0].text === 'Call 020 3974 6690' && items[0].href === 'tel:02039746690', `Call item wrong: ${JSON.stringify(items)}`);
  assert(items[1].text === 'Copy number', `Copy item wrong: ${JSON.stringify(items)}`);

  await page.locator('.phone-menu button.phone-menu-item').click();
  await pollUntil(page, () => /Copied 020 3974 6690/.test(document.body.innerText), null,
    { timeout: 3_000, label: 'no "Copied" confirmation' });
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
  if (clip !== null) assert(clip === '020 3974 6690', `clipboard holds ${JSON.stringify(clip)}`);
  assert(await page.evaluate(() => !document.querySelector('.phone-menu')), 'menu should close after Copy');
  log(`menu: Call + Copy; copied ${clip === null ? '(clipboard unreadable here — toast confirmed)' : JSON.stringify(clip)} ✓`);
}
