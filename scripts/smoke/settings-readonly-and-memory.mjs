// Scenario: two additions to the agent-settings schema contract
// (docs/ABSTRACT_AGENT_PROTOCOL.md "Optional settings extension",
// docs/LOCAL_MODE.md §1 and §3) — an optional `group` sub-heading
// within a category, an optional `readonly` flag on any setting type,
// and the new Settings › Memory section/category. The PWA renders all
// three generically; it never special-cases hermes, hindsight, or the
// local model by name.
//
// Test plan (mocked):
//   1. Declare `runtime_profile` (category Agent, group "Runtime", an
//      enum with two described options) plus three Memory-category
//      settings: `memory_enabled` (toggle), `memory_llm` and
//      `memory_status` (text, readonly:true).
//   2. Open Settings › Agent: runtime_profile's <select> renders with
//      both options, directly under an "Runtime" sub-heading — proves
//      `group` groups within a category without needing its own nav
//      section.
//   3. Open Settings › Memory: the empty-state placeholder is hidden,
//      all three fields render, and the two readonly fields show a
//      value line (no <input>/<select> in their row) with the exact
//      backend-supplied text.
//   4. Toggle memory_enabled → exactly one POST to
//      /api/parley/settings/memory_enabled with {value:false} (the
//      settings-schema write route every other agent-setting smoke
//      uses — NOT /api/parley/config/<key>, which is parley's own
//      local-only settings path).
//   5. Simulate the backend changing memory_status server-side (e.g.
//      hindsight retained something new) and close+reopen the panel —
//      the "drift on close/open" refresh (agentSettings.load() on both
//      transitions, per src/agentSettings.ts's fileoverview) must pick
//      up the new text even though the field is readonly and the PWA
//      never wrote it.
import { waitForReady, openSettingsSection, assert } from './lib.mjs';

/** Switch to an already-open panel's section without going through
 *  openSettingsSection() again — that helper's first step re-clicks
 *  '#sb-settings' to OPEN the panel, which while it's already open just
 *  toggles it shut and hangs the next click behind the (still
 *  transitioning) backdrop. Nav-button switch only, no open/close. */
async function switchSection(page, section, { timeout = 3_000 } = {}) {
  await page.click(`.settings-nav-btn[data-target="${section}"]`);
  await page.waitForSelector(`.settings-group[data-section="${section}"]:not([hidden])`, { timeout });
}

export const NAME = 'settings-readonly-and-memory';
export const DESCRIPTION = 'readonly settings render as value lines; Memory section + Agent "Runtime" group render from the schema';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const MEMORY_STATUS_INITIAL = 'hindsight-server active · last retain 3 min ago · 0 LLM errors / 24h';
const MEMORY_STATUS_UPDATED = 'hindsight-server active · last retain 12 sec ago · 0 LLM errors / 24h';
const MEMORY_LLM = 'openai-codex · gpt-5.4-mini';

function schema({ memoryEnabled = true, memoryStatus = MEMORY_STATUS_INITIAL } = {}) {
  return [
    {
      id: 'runtime_profile',
      label: 'Runtime profile',
      description: 'Where every model call goes for this turn onward.',
      category: 'Agent',
      group: 'Runtime',
      type: 'enum',
      value: 'cloud',
      options: [
        { value: 'cloud', label: 'Cloud', description: 'Codex + OpenRouter; normal capability.' },
        { value: 'local', label: 'Local (galatea 4090)', description: 'Off-grid; Qwen3.6-35B on the box, 64K window.' },
      ],
    },
    {
      id: 'memory_enabled', label: 'Memory', description: 'hermes memory.memory_enabled',
      category: 'Memory', type: 'toggle', value: memoryEnabled,
    },
    {
      id: 'memory_llm', label: 'Memory LLM', description: 'follows the runtime profile; not editable here',
      category: 'Memory', type: 'text', value: MEMORY_LLM, readonly: true,
    },
    {
      id: 'memory_status', label: 'Status', description: 'hindsight-server + retain journal',
      category: 'Memory', type: 'text', value: memoryStatus, readonly: true,
    },
  ];
}

export function MOCK_SETUP(mock) {
  mock.setSettingsSchema(schema());
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // Count requests to the settings-write route ourselves — the mock only
  // remembers the LAST post, which proves shape but not count, and the
  // "exactly once" assertion below needs count.
  let memoryEnabledPosts = 0;
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    if (new URL(req.url()).pathname.endsWith('/api/parley/settings/memory_enabled')) memoryEnabledPosts++;
  });

  // ── 2. Agent section: runtime_profile under a "Runtime" heading ──
  await openSettingsSection(page, 'agent');
  await page.waitForSelector('#settings-group-agent [data-agent-setting="runtime_profile"] select', { timeout: 3_000 });
  const runtimeRow = await page.$eval('#settings-group-agent', (host) => {
    const heading = host.querySelector('.agent-setting-group-heading');
    const row = host.querySelector('[data-agent-setting="runtime_profile"]');
    const sel = row?.querySelector('select');
    return {
      headingText: heading?.textContent || null,
      headingPrecedesRow: !!(heading && row && heading.nextElementSibling === row),
      options: sel ? Array.from(sel.options).map((o) => ({ value: o.value, label: o.textContent, title: o.title })) : [],
    };
  });
  assert(runtimeRow.headingText === 'Runtime', `group heading text; got ${JSON.stringify(runtimeRow.headingText)}`);
  assert(runtimeRow.headingPrecedesRow, 'heading must sit directly before the runtime_profile row');
  assert(runtimeRow.options.length === 2, `two runtime_profile options; got ${JSON.stringify(runtimeRow.options)}`);
  assert(runtimeRow.options.some((o) => o.value === 'local' && /galatea/.test(o.label) && /off-grid/i.test(o.title || '')),
    `local option keeps its label + description (rendered as title); got ${JSON.stringify(runtimeRow.options)}`);
  log('runtime_profile enum renders under an Agent › Runtime sub-heading, options + descriptions intact');

  // ── 3. Memory section: empty-state gone, three fields, readonly value lines ──
  await switchSection(page, 'memory');
  await page.waitForSelector('#settings-group-memory [data-agent-setting="memory_status"]', { timeout: 3_000 });
  const memory = await page.$eval('#settings-group-memory', (host) => {
    const emptyState = host.querySelector('[data-memory-empty]');
    const row = (id) => host.querySelector(`[data-agent-setting="${id}"]`);
    const readonlyInfo = (id) => {
      const r = row(id);
      return {
        hasInput: !!r?.querySelector('input, select, textarea'),
        value: r?.querySelector('[data-agent-setting-value]')?.textContent ?? null,
      };
    };
    return {
      emptyHidden: emptyState ? (emptyState.hidden || getComputedStyle(emptyState).display === 'none') : null,
      toggleIsCheckbox: row('memory_enabled')?.querySelector('input[type=checkbox]') != null,
      llm: readonlyInfo('memory_llm'),
      status: readonlyInfo('memory_status'),
    };
  });
  assert(memory.emptyHidden === true, `Memory empty-state must be hidden once fields exist; got ${memory.emptyHidden}`);
  assert(memory.toggleIsCheckbox, 'memory_enabled renders as a real checkbox input');
  assert(!memory.llm.hasInput && memory.llm.value === MEMORY_LLM,
    `memory_llm readonly value line; got ${JSON.stringify(memory.llm)}`);
  assert(!memory.status.hasInput && memory.status.value === MEMORY_STATUS_INITIAL,
    `memory_status readonly value line; got ${JSON.stringify(memory.status)}`);
  log('Memory section: empty-state hidden, toggle + two readonly value lines all present');

  // ── 4. Toggle memory_enabled → exactly one POST to /settings/memory_enabled ──
  await page.click('#settings-group-memory [data-agent-setting="memory_enabled"] input[type=checkbox]');
  // Poll the mock for the POST (not the DOM checkbox state — it flips
  // synchronously on click, before the POST necessarily lands). Same
  // approach as settings-agent-schema.mjs.
  let last = null;
  const pollStart = Date.now();
  while (Date.now() - pollStart < 3_000) {
    last = mock.getLastSettingsPost();
    if (last && last.id === 'memory_enabled') break;
    await page.waitForTimeout(50);
  }
  assert(last && last.id === 'memory_enabled' && last.body?.value === false,
    `memory_enabled POST body; got ${JSON.stringify(last)}`);
  assert(memoryEnabledPosts === 1, `expected exactly one POST to settings/memory_enabled; got ${memoryEnabledPosts}`);
  log('memory_enabled toggle POSTs {value:false} to /api/parley/settings/memory_enabled exactly once');

  // ── 5. Server-side change to a readonly field + close/reopen picks it up ──
  mock.setSettingsSchema(schema({ memoryEnabled: false, memoryStatus: MEMORY_STATUS_UPDATED }));
  await page.click('#settings-close');
  // closePanel() fires agentSettings.load() itself (drift-on-close); the
  // value row lives in a hidden (not removed) container so we can read
  // its text without reopening.
  await page.waitForFunction(
    (expected) => document.querySelector('#settings-group-memory [data-agent-setting="memory_status"] [data-agent-setting-value]')?.textContent === expected,
    MEMORY_STATUS_UPDATED,
    { timeout: 3_000 },
  );
  log('close-time refresh updated the readonly field while the panel was hidden');
  await openSettingsSection(page, 'memory');
  const statusAfterReopen = await page.$eval(
    '#settings-group-memory [data-agent-setting="memory_status"] [data-agent-setting-value]',
    (e) => e.textContent,
  );
  assert(statusAfterReopen === MEMORY_STATUS_UPDATED, `reopened panel shows updated status; got ${statusAfterReopen}`);
  log('reopened panel confirms the drift-refreshed readonly value stuck ✓');
}
