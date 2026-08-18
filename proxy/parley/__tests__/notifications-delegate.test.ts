import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  expandPreferenceUpdates,
  normalizePluginPrefs,
  PIN_BODY_CAP_BYTES,
} from '../notifications/delegate.ts';

test('plugin prefs delegate: expands nested kind updates to plugin push_kind keys', () => {
  assert.deepEqual(
    expandPreferenceUpdates({
      kinds: {
        cron: false,
        approval: true,
        agent_reply: false,
      },
    }),
    [
      { key: 'push_kind_cron', value: false },
      { key: 'push_kind_approval', value: true },
      { key: 'push_kind_agent_reply', value: false },
    ],
  );
});

test('plugin prefs delegate: preserves non-kind updates', () => {
  const quiet = { enabled: true, start: '22:00', end: '07:00' };
  assert.deepEqual(
    expandPreferenceUpdates({ quiet_hours: quiet }),
    [{ key: 'quiet_hours', value: quiet }],
  );
});

test('plugin prefs delegate: normalizes flat plugin push_kind keys to PWA kinds blob', () => {
  assert.deepEqual(
    normalizePluginPrefs({
      prefs: {
        push_kind_agent_reply: false,
        push_kind_cron: 'false',
        push_kind_approval: 'true',
        push_kind_reminder: 'true',
        quiet_hours: { enabled: false, start: '22:00', end: '07:00' },
      },
    }),
    {
      push_kind_agent_reply: false,
      push_kind_cron: 'false',
      push_kind_approval: 'true',
      push_kind_reminder: 'true',
      quiet_hours: { enabled: false, start: '22:00', end: '07:00' },
      kinds: {
        agent_reply: false,
        cron: false,
        approval: true,
      },
    },
  );
});

test('pin delegate body cap covers the client 16K preview plus JSON overhead', () => {
  assert.ok(PIN_BODY_CAP_BYTES >= 32 * 1024);
});
