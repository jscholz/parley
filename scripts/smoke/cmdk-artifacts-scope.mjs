// cmd+K Artifacts (2026-11-08): "I wanted to open a document I
// remembered from the other day about a company called Trajectory, and
// it's not in the recent documents list."
//   A1  a query matching a cached doc's TITLE lists it under Artifacts
//       with the title marked and a meta line (kind · file · when)
//   A2  a query matching only a doc's BODY lists it with a marked excerpt
//   A3  Enter / click on an artifact row closes the palette and opens
//       that doc in the reader
//   A4  the scope chips: Artifacts hides the other sections and lifts
//       the cap; Tab cycles All → Sessions → Artifacts → Messages → All;
//       the dialog carries data-scope; a reopen starts in All

import { waitForReady, assert, pollUntil } from './lib.mjs';

export const NAME = 'cmdk-artifacts-scope';
export const DESCRIPTION = 'cmd+K: artifacts (the doc cache) are a search category with title/body matches and excerpts; Enter opens the doc; scope chips narrow and Tab cycles';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:cmdk-artifacts';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, { title: 'Artifacts palette', messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_cap', timestamp: Date.now() / 1000 - 60 }], lastActiveAt: Date.now() });
}

const rows = (page, kind) => page.evaluate((k) => Array.from(document.querySelectorAll(`.cmdk-row[data-kind="${k}"]`)).map((li) => ({
  id: li.dataset.id, title: li.querySelector('.cmdk-row-title')?.textContent || '', marks: Array.from(li.querySelectorAll('mark')).map((m) => m.textContent),
  excerpt: li.querySelector('.cmdk-row-excerpt')?.textContent || '', meta: li.querySelector('.cmdk-row-meta')?.textContent || '',
})), kind);

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  const push = (title, content, i) => mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT, title, content, format: 'markdown', path: `/w/docs/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`, displayed_at: Date.now() - (20 - i) * 3_600_000 });
  // Twelve older passing mentions, then the two that matter, newest:
  // the title match (ranks first regardless) and the body match (the
  // newest content-tier hit, so it survives All's cap of 8).
  for (let i = 0; i < 12; i++) push(`Weekly notes ${i}`, `# Notes\n\nTrajectory mentioned in passing ${i}.`, 1 + i);
  push('Trajectory + continual learning: expert briefing', '# Briefing\n\nA long expert briefing about continual learning.', 18);
  push('Investor FAQ draft', '# FAQ\n\nQ: Who else is in the space?\nA: Trajectory raised a round last spring and competes on fleet learning.', 19);
  await pollUntil(page, () => document.querySelectorAll('#doc-rail-tabs .doc-rail-tab').length >= 3 || document.querySelectorAll('.doc-rail-tab').length >= 3, null, { timeout: 6_000, label: 'docs did not arrive' });
  // Put the shelf away so the reader is not already on an artifact.
  await page.evaluate(() => document.getElementById('pin-drawer-clear')?.click());
  await page.waitForTimeout(300);

  await page.keyboard.press('Control+K');
  await page.waitForSelector('.cmdk-dialog[open]', { timeout: 5_000 });
  await page.fill('.cmdk-input', 'trajectory');
  await pollUntil(page, () => document.querySelectorAll('.cmdk-row[data-kind="artifact"]').length > 0, null, { timeout: 6_000, label: 'A1: no artifact rows' });

  // ── A1 / A2 ───────────────────────────────────────────────────────
  const a = await rows(page, 'artifact');
  log(`A1 artifacts: ${JSON.stringify(a.slice(0, 3))} (${a.length} rows)`);
  assert(a[0].title.startsWith('Trajectory + continual'), `A1: title match should rank first, got "${a[0].title}"`);
  assert(a[0].marks.some((m) => /trajectory/i.test(m)), 'A1: the title match must be marked');
  assert(/md · trajectory-continual-learning-expert-briefing\.md · /.test(a[0].meta) && /\d{1,2}:\d{2}/.test(a[0].meta), `A1: meta should read kind · file · when, got "${a[0].meta}"`);
  const faq = a.find((r) => r.title === 'Investor FAQ draft');
  assert(faq && /Trajectory raised a round/.test(faq.excerpt) && faq.marks.some((m) => /trajectory/i.test(m)), `A2: body match should carry a marked excerpt, got ${JSON.stringify(faq)}`);
  assert(a.length <= 8, `A1: All scope keeps artifacts short, got ${a.length}`);

  // ── A4 — chips + Tab ─────────────────────────────────────────────
  await page.click('.cmdk-scope[data-scope="artifacts"]');
  await pollUntil(page, () => document.querySelector('.cmdk-dialog')?.dataset.scope === 'artifacts' && document.querySelectorAll('.cmdk-row[data-kind="artifact"]').length > 8, null, { timeout: 6_000, label: 'A4: Artifacts scope did not lift the cap' });
  const hidden = await page.evaluate(() => ({
    sessions: document.querySelector('ul[data-section="sessions"]')?.hidden, messages: document.querySelector('ul[data-section="messages"]')?.hidden,
    placeholder: document.querySelector('.cmdk-input')?.placeholder, count: document.querySelectorAll('.cmdk-row[data-kind="artifact"]').length,
  }));
  log(`A4 artifacts scope: ${JSON.stringify(hidden)}`);
  assert(hidden.sessions && hidden.messages && /artifacts/i.test(hidden.placeholder) && hidden.count === 14, `A4: narrowed scope should hide the other sections and show all 14, got ${JSON.stringify(hidden)}`);
  await page.keyboard.press('Tab');
  await pollUntil(page, () => document.querySelector('.cmdk-dialog')?.dataset.scope === 'messages', null, { timeout: 2_000, label: 'A4: Tab did not cycle to Messages' });
  await page.keyboard.press('Tab');
  await pollUntil(page, () => document.querySelector('.cmdk-dialog')?.dataset.scope === 'all', null, { timeout: 2_000, label: 'A4: Tab did not cycle back to All' });
  await page.keyboard.press('Shift+Tab');
  await pollUntil(page, () => document.querySelector('.cmdk-dialog')?.dataset.scope === 'messages', null, { timeout: 2_000, label: 'A4: Shift+Tab did not cycle backwards' });
  await page.click('.cmdk-scope[data-scope="all"]');
  await pollUntil(page, () => document.querySelectorAll('.cmdk-row[data-kind="artifact"]').length > 0 && document.querySelector('.cmdk-dialog')?.dataset.scope === 'all', null, { timeout: 6_000, label: 'A4: All did not come back' });
  log('A4 chips narrow, Tab cycles both ways ✓');

  // ── A3 — open ────────────────────────────────────────────────────
  await page.click('.cmdk-row[data-kind="artifact"]');
  await pollUntil(page, () => !document.querySelector('.cmdk-dialog[open]'), null, { timeout: 2_000, label: 'A3: palette did not close' });
  await pollUntil(page, () => import('/build/rightDrawer/docStore.mjs').then((m) => /Trajectory \+ continual/.test(m.currentDoc()?.title || '')), null, { timeout: 6_000, label: 'A3: the artifact did not open in the reader' });
  await pollUntil(page, () => !document.getElementById('pin-drawer')?.classList.contains('collapsed') && !!document.querySelector('#doc-drawer-body .doc-drawer-title-text'), null, { timeout: 4_000, label: 'A3: the Artifacts pane did not show the reader' });
  log('A3 artifact hit opened the doc in the reader ✓');

  // Reopen starts in All.
  await page.keyboard.press('Control+K');
  await page.waitForSelector('.cmdk-dialog[open]', { timeout: 5_000 });
  assert((await page.evaluate(() => document.querySelector('.cmdk-dialog')?.dataset.scope)) === 'all', 'a reopen starts in All');
  log('cmd+K artifacts: category, excerpts, open, scope chips ✓');
}
