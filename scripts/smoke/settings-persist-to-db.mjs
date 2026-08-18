// Regression gate for Phase 2/3 of the settings→sidekick.db migration:
// synced (non-device) settings now live in the `user_settings` table
// (GET /api/parley/prefs), with the YAML (sidekick.config.yaml,
// GET /api/parley/config) demoted to a one-time read-only SEED.
//
// What this proves, end-to-end through the real fetch paths the PWA
// uses (the mock backend owns /api/parley/prefs; /api/parley/config
// falls through to the real worktree server's YAML):
//
//   1. SEED-FORWARD — boot with an empty DB. settings.load() finds the
//      synced key absent from /prefs, backfills it from the YAML value
//      AND writes it into the DB (PUT /prefs) so the next boot is
//      DB-only.
//   2. WRITE = PUT, never POST — changing the setting in the UI sends
//      PUT /api/parley/prefs/<key> and does NOT POST the legacy
//      /api/parley/config/<key> (YAML is no longer a runtime store).
//   3. DB WINS — after a reload the DB value (set in step 2) takes
//      precedence; seed-forward is skipped because the key is present.
//
// agentActivity is the probe: it's a synced key with a plain <select>
// (#set-agent-activity, Interaction section) so the UI edit is easy to
// drive and observe.

import { waitForReady, openSettingsSection, pollUntil, assert } from './lib.mjs';

export const NAME = 'settings-persist-to-db';
export const DESCRIPTION = 'synced settings seed-forward from YAML into sidekick.db, UI edits PUT to /prefs (not POST /config), and the DB wins on reload';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const KEY = 'agentActivity';
const CHOICES = ['off', 'summary', 'full'];

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // Count any POST to the legacy YAML endpoint. GET (the seed read) is
  // disjoint from this pattern (/config with no trailing /<key>) and
  // falls through to the real server untouched.
  let configPosts = 0;
  await page.route('**/api/parley/config/**', async (route) => {
    if (route.request().method() === 'POST') {
      configPosts += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    return route.fallback();
  });

  // ── Part 1: seed-forward. Boot ran settings.load() with an empty DB
  // Map, so the synced key should have been backfilled from the YAML
  // and written into the DB. Poll the DB store until the PUT lands.
  await pollUntil(page,
    () => fetch('/api/parley/prefs/agentActivity')
      .then((r) => r.json())
      .then((b) => b && b.value != null),
    null,
    { timeout: 5_000, polling: 100, label: 'seed-forward PUT never landed agentActivity in the DB' },
  );
  const seeded = mock.getUserSetting(KEY);
  const yamlValue = await page.evaluate(async () => {
    const r = await fetch('/api/parley/config', { cache: 'no-store' });
    const j = await r.json();
    return j?.settings?.agentActivity;
  });
  assert(seeded != null, `seed-forward should have written ${KEY} into the DB; got ${seeded}`);
  assert(seeded === yamlValue,
    `seeded DB value should match the YAML seed; DB=${JSON.stringify(seeded)} YAML=${JSON.stringify(yamlValue)}`);
  log(`seed-forward: DB ${KEY}=${JSON.stringify(seeded)} backfilled from YAML ✓`);

  // ── Part 2: UI edit writes via PUT /prefs, never POST /config.
  await openSettingsSection(page, 'interaction');
  const current = await page.$eval('#set-agent-activity', (el) => el.value);
  const next = CHOICES.find((v) => v !== current);
  assert(next, `could not pick a value distinct from current=${current}`);

  await page.selectOption('#set-agent-activity', next);

  // set() fires PUT fire-and-forget; poll the DB store for the new value.
  await pollUntil(page,
    (want) => fetch('/api/parley/prefs/agentActivity')
      .then((r) => r.json())
      .then((b) => b && b.value === want),
    next,
    { timeout: 3_000, polling: 100, label: 'UI edit PUT never landed the new agentActivity value' },
  );
  assert(mock.getUserSetting(KEY) === next,
    `UI edit should PUT ${KEY}=${next} into the DB; got ${JSON.stringify(mock.getUserSetting(KEY))}`);
  assert(configPosts === 0,
    `synced edit must not POST the legacy /config endpoint; saw ${configPosts} POST(s)`);
  log(`UI edit: ${KEY} ${current}→${next} via PUT /prefs, zero /config POSTs ✓`);

  // ── Part 3: DB wins on reload. The Map persists across reload (same
  // page closure), so /prefs now carries the edited value; load() should
  // apply it from the DB and skip seed-forward (key present). The panel
  // reflects the DB value, which differs from the YAML seed.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page);
  await openSettingsSection(page, 'interaction');
  const afterReload = await page.$eval('#set-agent-activity', (el) => el.value);
  assert(afterReload === next,
    `after reload the panel should show the DB value ${next} (DB wins over YAML ${yamlValue}); got ${afterReload}`);
  assert(configPosts === 0,
    `reload must not re-seed via /config POST (key present in DB); saw ${configPosts}`);
  log(`DB wins: reload shows ${KEY}=${afterReload} from the DB, YAML seed (${yamlValue}) ignored ✓`);
}
