// Meeting-polish #25 drawer leg: the canonical filter button next to
// the Filter Sessions input. Engaging it applies the option filter;
// its one option today — "Has recording" — DEFAULTS TO ON (ticked), so
// the first press immediately narrows the list to sessions with
// meeting captures. Spec's "default true" is the OPTION's default when
// the filter is engaged; the drawer must NOT boot filtered (that would
// hide most sessions). State is session-ephemeral and per-device.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'session-filter-has-recording';
export const DESCRIPTION = 'drawer filter button: has-recording option defaults on; engaged → only recorded sessions; boot unfiltered';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_REC = 'mock-filter-recorded';
const CHAT_PLAIN = 'mock-filter-plain';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 300;
  mock.addChat(CHAT_REC, {
    title: 'Standup (recorded)',
    messages: [{ role: 'user', content: 'seed rec', sidekick_id: 'umsg_f_rec', timestamp: t0 }],
    lastActiveAt: Date.now() - 5000,
  });
  mock.addChat(CHAT_PLAIN, {
    title: 'Plain notes',
    messages: [{ role: 'user', content: 'seed plain', sidekick_id: 'umsg_f_plain', timestamp: t0 + 5 }],
    lastActiveAt: Date.now() - 1000,
  });
  // Finished capture linked to CHAT_REC — the boot-time meetingsIndex
  // fetch (GET /api/parley/captures) sees it.
  mock.addCapture(CHAT_REC, { title: 'Standup recording' });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Boot: BOTH rows visible (drawer must not boot filtered), filter
  // button present + disengaged, options strip hidden.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_REC}"]`, { timeout: 5000 });
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_PLAIN}"]`, { timeout: 5000 });
  const boot = await page.evaluate(() => ({
    btn: !!document.getElementById('sess-filter-btn'),
    pressed: document.getElementById('sess-filter-btn')?.getAttribute('aria-pressed'),
    optionsHidden: document.getElementById('sess-filter-options')?.hidden,
  }));
  assert(boot.btn, 'canonical filter button (#sess-filter-btn) missing from the drawer header');
  assert(boot.pressed === 'false', `filter must boot disengaged, aria-pressed=${boot.pressed}`);
  assert(boot.optionsHidden === true, 'options strip should be hidden while disengaged');
  log('boot: both rows visible, filter disengaged');

  // The recorded row carries the meeting badge (meetingsIndex loaded
  // from the mocked GET /captures) — wait for it so the filter click
  // below can't race the index fetch.
  await page.waitForFunction(
    (id) => !!document.querySelector(`#sessions-list li[data-chat-id="${id}"][data-meetings]`),
    CHAT_REC, { timeout: 5000, polling: 50 },
  );
  log('meeting badge present on the recorded row');

  // 1. Engage: options strip appears, "Has recording" is TICKED BY
  //    DEFAULT, and the list narrows to recorded sessions only.
  await page.click('#sess-filter-btn');
  const engaged = await page.evaluate(() => ({
    pressed: document.getElementById('sess-filter-btn')?.getAttribute('aria-pressed'),
    optionsHidden: document.getElementById('sess-filter-options')?.hidden,
    hasRecChecked: document.getElementById('sess-filter-has-recording')?.checked,
  }));
  assert(engaged.pressed === 'true', 'button should report engaged');
  assert(engaged.optionsHidden === false, 'options strip should show while engaged');
  assert(engaged.hasRecChecked === true, 'has-recording option must DEFAULT TO ON (spec: default true)');
  await page.waitForFunction(
    ({ rec, plain }) =>
      !!document.querySelector(`#sessions-list li[data-chat-id="${rec}"]`)
      && !document.querySelector(`#sessions-list li[data-chat-id="${plain}"]`),
    { rec: CHAT_REC, plain: CHAT_PLAIN },
    { timeout: 3000, polling: 50 },
  );
  log('engaged: only the recorded session remains');

  // 2. Untick the option while engaged → no option constrains, all
  //    rows return.
  await page.click('#sess-filter-has-recording');
  await page.waitForFunction(
    ({ rec, plain }) =>
      !!document.querySelector(`#sessions-list li[data-chat-id="${rec}"]`)
      && !!document.querySelector(`#sessions-list li[data-chat-id="${plain}"]`),
    { rec: CHAT_REC, plain: CHAT_PLAIN },
    { timeout: 3000, polling: 50 },
  );
  log('option unticked: both rows back');

  // 3. Re-tick, then DISENGAGE via the button → pass-through again and
  //    the strip hides; the option keeps its (session-ephemeral) state.
  await page.click('#sess-filter-has-recording');
  await page.waitForFunction(
    (plain) => !document.querySelector(`#sessions-list li[data-chat-id="${plain}"]`),
    CHAT_PLAIN, { timeout: 3000, polling: 50 },
  );
  await page.click('#sess-filter-btn');
  await page.waitForFunction(
    ({ rec, plain }) =>
      !!document.querySelector(`#sessions-list li[data-chat-id="${rec}"]`)
      && !!document.querySelector(`#sessions-list li[data-chat-id="${plain}"]`),
    { rec: CHAT_REC, plain: CHAT_PLAIN },
    { timeout: 3000, polling: 50 },
  );
  const after = await page.evaluate(() => ({
    optionsHidden: document.getElementById('sess-filter-options')?.hidden,
    hasRecChecked: document.getElementById('sess-filter-has-recording')?.checked,
  }));
  assert(after.optionsHidden === true, 'options strip should hide on disengage');
  assert(after.hasRecChecked === true, 'option state survives disengage within the session');
  log('disengage: pass-through restored, option state kept');
}
