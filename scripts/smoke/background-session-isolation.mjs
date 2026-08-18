// /background isolation: bg sessions must NOT leak into the sidekick
// drawer rollup or the current chat's transcript items.
//
// Why install-only:
//
// Currently, /background works cleanly in sidekick because of
// a load-bearing upstream "bug": hermes-agent's _ensure_db_session()
// in run_agent.py:2438 hardcodes user_id=None when it INSERTs the
// session row, regardless of what user_id was passed to the AIAgent
// constructor. Cron jobs, sub-agent delegates, /branch, and /background
// all rely on this — they spin up agents with synthetic session_ids
// bypassing gateway/session.py's SessionStore.get_or_create_session()
// (which is the only path that propagates user_id). So bg sessions
// land orphan in state.db (user_id=NULL, parent_session_id=NULL)
// and the sidekick drawer's recursive CTE filters them out via
// WHERE user_id IS NOT NULL.
//
// If upstream "fixes" _ensure_db_session() to propagate self.user_id
// (which is what the constructor receives), every bg session in
// sidekick will start landing with user_id=current-chat-id (because
// for sidekick, source.user_id IS source.chat_id). The drawer's
// CTE would then roll those sessions UNDER the user's current chat —
// inflating message_count, polluting items, etc.
//
// This smoke catches that regression on the very next hermes upgrade.
// Not in the regular smoke loop because: (a) needs a real LLM call
// (paid + slow), (b) the bug it catches only fires on cross-repo
// upstream change. Keep it install-only and rerun on hermes upgrade.
//
// Usage:
//   npm run smoke -- background-session-isolation --include-install

import {
  waitForReady, clickNewChat, send, deleteChat, captureNextChatId, assert,
} from './lib.mjs';

export const NAME = 'background-session-isolation';
export const DESCRIPTION = 'Real backend: /background result lands in current chat without polluting drawer or transcript items';
export const STATUS = 'install-only';
export const BACKEND = 'real';

export default async function run({ page, log, url }) {
  let chatId = null;

  try {
    await waitForReady(page);
    const idP = captureNextChatId(page);
    await clickNewChat(page);
    chatId = await idP;
    log(`chat: ${chatId}`);

    // Seed the chat with one normal turn so the drawer rollup has a
    // baseline. Without this, the drawer might not register the chat
    // before /background fires, masking a pollution case as "no chat
    // visible at all."
    await send(page, 'Reply with just OK.');
    await page.waitForFunction(
      () => document.querySelectorAll(
        '#transcript .line.agent:not(.streaming):not(.pending)',
      ).length >= 1,
      null,
      { timeout: 45_000, polling: 500 },
    );
    log('seed turn complete');

    // Baseline snapshot: drawer rollup + transcript items for this chat
    // BEFORE the /background fires. Comparing against after-bg state
    // reveals any leak from the bg session's INTERNAL messages (the
    // bg agent's own user/tool/assistant scratch row) into either UI.
    const baselineDrawer = await fetchDrawerEntry(url, chatId);
    const baselineItems = await fetchTranscriptItems(url, chatId);
    assert(baselineDrawer, `drawer entry not found for ${chatId} after seed turn`);
    log(`baseline: drawer mcount=${baselineDrawer.messageCount} transcript-items=${baselineItems.length}`);

    // Fire /background with a tiny computable prompt — fast, deterministic-ish.
    const BG_PROMPT = 'What is 2+2? Answer with just the number.';
    await send(page, `/background ${BG_PROMPT}`);

    // Wait for the "✅ Background task complete" header to appear in the
    // transcript. That's the bg result being delivered via adapter.send
    // (tagged with chat_id=current). Distinguish from the immediate
    // "🔄 Background task started" confirmation.
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('#transcript .line.agent'))
        .some(el => (el.textContent || '').includes('Background task complete')),
      null,
      { timeout: 60_000, polling: 1000 },
    );
    log('bg task result delivered to current chat');
    // Small grace: server-side persistence finalizes, drawer rollup
    // catches up if it's going to.
    await page.waitForTimeout(1500);

    // ── INVARIANT 1: bg session must NOT appear as its own drawer row.
    const allDrawer = await fetchAllDrawer(url);
    const bgLikeRows = allDrawer.filter(s => /^bg_/i.test(s.chatId || s.id || ''));
    assert(
      bgLikeRows.length === 0,
      `BUG: a bg_* session is visible in the drawer rollup — ` +
      `upstream's _ensure_db_session may have started propagating user_id, ` +
      `which breaks sidekick's drawer isolation. Found rows: ` +
      JSON.stringify(bgLikeRows.map(r => ({ id: r.chatId || r.id, mc: r.messageCount }))),
    );

    // ── INVARIANT 2: current chat's drawer rollup must NOT have inflated
    //    its message_count by the bg session's INTERNAL messages. The bg
    //    session's internal scratch (user + tool + assistant) is typically
    //    3-5 messages; only the result bubble (1 finalized assistant +
    //    matching user) belongs in the chat. So at most +2 over baseline
    //    for the /background command itself.
    //
    //    If upstream "fixes" user_id propagation, expect baseline+5-ish or
    //    more, which trips this check.
    const afterDrawer = await fetchDrawerEntry(url, chatId);
    assert(afterDrawer, `drawer entry disappeared for ${chatId}`);
    const drawerDelta = (afterDrawer.messageCount || 0) - (baselineDrawer.messageCount || 0);
    log(`drawer mcount: baseline=${baselineDrawer.messageCount} after=${afterDrawer.messageCount} delta=${drawerDelta}`);
    assert(
      drawerDelta <= 3,
      `BUG: drawer message_count grew by ${drawerDelta} (baseline=${baselineDrawer.messageCount}, after=${afterDrawer.messageCount}). ` +
      `Expected ≤3 (user prompt + result bubble + slack). Higher delta means bg session's ` +
      `internal scratch is rolling up into the current chat — upstream user_id propagation likely broke isolation.`,
    );

    // ── INVARIANT 3: transcript items for this chat must NOT contain the
    //    bg agent's INTERNAL tool message. The bg "what is 2+2" task
    //    likely calls no tools, but a generic check: any message whose
    //    role==='tool' or content starts with '{' (raw tool-output JSON
    //    that leaked) is a smoking gun.
    const afterItems = await fetchTranscriptItems(url, chatId);
    const leakedTools = afterItems.filter(m => m.role === 'tool');
    assert(
      leakedTools.length === 0,
      `BUG: bg session's tool messages leaked into current chat's transcript items. ` +
      `Found ${leakedTools.length} tool messages. Sample: ${JSON.stringify(leakedTools.slice(0, 2))}`,
    );
    log(`items: baseline=${baselineItems.length} after=${afterItems.length} (no tool leak)`);
    log(`✓ /background isolation invariants hold`);
  } finally {
    if (chatId) await deleteChat(page, chatId);
  }
}

async function fetchDrawerEntry(url, chatId) {
  const r = await fetch(`${url}/api/parley/sessions?limit=50`);
  if (!r.ok) throw new Error(`drawer fetch HTTP ${r.status}`);
  const body = await r.json();
  const sessions = body?.sessions || body?.data || [];
  return sessions.find(s => (s.chatId || s.id || s.chat_id) === chatId);
}

async function fetchAllDrawer(url) {
  const r = await fetch(`${url}/api/parley/sessions?limit=200`);
  if (!r.ok) throw new Error(`drawer fetch HTTP ${r.status}`);
  const body = await r.json();
  return body?.sessions || body?.data || [];
}

async function fetchTranscriptItems(url, chatId) {
  const r = await fetch(`${url}/api/parley/sessions/${encodeURIComponent(chatId)}/messages`);
  if (!r.ok) throw new Error(`items fetch HTTP ${r.status}`);
  const body = await r.json();
  return body?.messages || body?.data || [];
}
