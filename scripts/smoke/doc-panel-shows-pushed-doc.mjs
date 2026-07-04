// Docs drawer tab v1: the agent's display_doc tool ships a doc_show
// envelope; the PWA must (1) auto-OPEN the right drawer on the Docs tab
// (the user asked to SEE the doc — that's the point of the feature),
// (2) render markdown through miniMarkdown, and (3) keep the doc across
// a reload via the localStorage mirror WITHOUT re-yanking the drawer
// open (hydrate is autoOpen=false).
//
// Wire path under test: mock SSE 'doc_show' → proxyClient listener list
// (an envelope type absent from that list is silently dropped — the
// exact bug class documented at proxyClient.ts:382) → handleEnvelope →
// backendEventHandlers.handleToolEvent kind='doc.show' → docStore →
// drawer host select('doc', {open:true}).

import { waitForReady } from './lib.mjs';

export const NAME = 'doc-panel-shows-pushed-doc';
export const DESCRIPTION = 'display_doc push auto-opens the Docs drawer tab and renders markdown';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-doc-panel-chat';
const DOC_MARKER = 'DECK-DOC-MARKER-4711';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Doc panel chat',
    messages: [{ role: 'user', content: 'seed', sidekick_id: 'umsg_doc_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // Sanity: drawer starts collapsed (rail) — the push must open it.
  const collapsedBefore = await page.evaluate(
    () => document.getElementById('pin-drawer')?.classList.contains('collapsed'),
  );
  if (!collapsedBefore) throw new Error('precondition: right drawer should start collapsed');

  mock.pushEnvelope({
    type: 'doc_show',
    chat_id: CHAT_ID,
    title: 'Deck notes',
    content: `# Raise plan\n\nThe marker is **${DOC_MARKER}**.\n`,
    format: 'markdown',
    path: '/home/user/deck-notes.md',
  });

  // Drawer open + Docs panel visible + markdown rendered (bold, not
  // literal asterisks).
  await page.waitForFunction(
    (marker) => {
      const drawer = document.getElementById('pin-drawer');
      const panel = document.getElementById('doc-drawer-panel');
      const body = document.getElementById('doc-drawer-body');
      if (!drawer || drawer.classList.contains('collapsed')) return false;
      if (!panel || panel.hidden) return false;
      const strong = body?.querySelector('.doc-drawer-content strong');
      return !!strong && strong.textContent === marker;
    },
    DOC_MARKER, { timeout: 6_000, polling: 50 },
  );
  log('doc push opened the drawer and rendered markdown');

  const title = await page.evaluate(
    () => document.querySelector('.doc-drawer-title')?.textContent,
  );
  if (title !== 'Deck notes') throw new Error(`doc title mismatch: ${title}`);

  // Reload: doc survives via localStorage, but the drawer must NOT be
  // auto-yanked open by hydrate. (Drawer open-state itself persists via
  // its own pref — collapse it first so the assertion is meaningful.)
  await page.evaluate(() => {
    document.getElementById('btn-doc-drawer-rail')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
  });
  await page.waitForFunction(
    () => document.getElementById('pin-drawer')?.classList.contains('collapsed'),
    null, { timeout: 4_000, polling: 50 },
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page);
  const afterReload = await page.evaluate(() => ({
    collapsed: document.getElementById('pin-drawer')?.classList.contains('collapsed'),
    persisted: (localStorage.getItem('sidekick.doc.current') || '').includes('DECK-DOC-MARKER-4711'),
  }));
  if (!afterReload.persisted) throw new Error('doc did not persist to localStorage');
  if (!afterReload.collapsed) throw new Error('hydrate must not auto-open the drawer on reload');
  log('doc persisted across reload without auto-opening the drawer');
}
