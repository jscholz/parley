// Scenario: web-search-prompting message → web_search tool fires
// against Tavily, an activity row + tool row render, the reply
// finalizes with a real fact, and state.db captures the tool turn.
//
// This is a tighter cousin of tool-turn.mjs that pins the Tavily
// integration end-to-end. tool-turn.mjs picks any tool the model
// chooses (often weather or browser_navigate); this scenario asserts
// that web_search SPECIFICALLY runs and returns useful content.
//
// BACKEND='real' is mandatory: the mock backend can't synthesize
// Tavily responses faithfully (and the whole point is to verify that
// the live integration works).
//
// Note on the state.db assertion: the user-facing instructions said
// "look for tool_name='web_search' on the tool row." In the current
// schema (~/.hermes/state.db) the messages.tool_name column is empty
// for newly-created rows; the tool name is stored in the preceding
// assistant row's tool_calls JSON. We assert on that — same intent
// (the turn invoked web_search), correct mechanics for today's data
// shape. If/when hermes starts populating tool_name, the assertion
// still passes (it OR's both forms).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { waitForReady, clickNewChat, send, deleteChat, captureNextChatId, SEL, assert } from './lib.mjs';

export const NAME = 'tool-turn-web-search';
export const DESCRIPTION = 'web_search tool runs via Tavily, renders, and lands in state.db';
// install-only: gated on a working Tavily API key + slow real-hermes
// round-trip. Runs at install / weekly cadence, not on every dev-loop
// smoke run. Trigger explicitly with
//   `npm run smoke -- tool-turn-web-search`  (name filter)
//   `npm run smoke -- --include-install`     (suite-level opt-in)
export const STATUS = 'install-only';
// Real backend required — Tavily integration end-to-end is the thing
// under test. Mock cannot stand in.
export const BACKEND = 'real';

const STATE_DB = `${process.env.HOME}/.hermes/state.db`;
const TOOL_PROMPT = 'Use web_search to find one fact about the Eiffel Tower.';

const execFileP = promisify(execFile);

// Mirrors proxy/generic/sql.ts (can't import a .ts file from
// .mjs without a build step; the helper is two lines).
async function sqlQuery(db, sql) {
  const { stdout } = await execFileP('sqlite3', ['-json', db, sql], {
    maxBuffer: 50 * 1024 * 1024,
  });
  if (!stdout.trim()) return [];
  return JSON.parse(stdout);
}

// Strings that signal the model declined / failed to actually use
// the tool. If the finalized reply matches any of these, we treat it
// as a placeholder and fail the scenario (the whole point is that
// Tavily returned real content).
const PLACEHOLDER_PATTERNS = [
  /search blocked/i,
  /\bi cannot\b/i,
  /\bi can'?t\b/i,
  /unable to (search|access)/i,
  /no results found/i,
];

export default async function run({ page, log, fail }) {
  await waitForReady(page);
  const chatIdP = captureNextChatId(page);
  await clickNewChat(page);
  const chatId = await chatIdP;

  try {
    const t0 = await send(page, TOOL_PROMPT);

    // 1. Activity row appears as soon as the first tool_call envelope
    //    arrives. (Same gate as tool-turn.mjs.)
    await page.waitForSelector(SEL.activityRow, { timeout: 30_000 });
    const tActivity = Date.now();
    log(`activity row appeared in ${tActivity - t0} ms`);

    // 2. A tool row carrying tool name 'web_search' renders. The DOM
    //    structure is .tool-row > .tool-row-summary > .tool-name (see
    //    src/activityRow.ts).
    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll('.tool-row .tool-name');
        return Array.from(rows).some((el) => (el.textContent || '').trim() === 'web_search');
      },
      null,
      { timeout: 60_000, polling: 250 },
    );
    log(`web_search tool row rendered`);

    // 3. Reply finalizes — count baseline first because the home-channel
    //    nudge from earlier chats may already have one finalized bubble.
    const baselineCount = await page.locator(SEL.agentFinal).count();
    await page.waitForFunction(
      ({ sel, baseline }) => document.querySelectorAll(sel).length > baseline,
      { sel: SEL.agentFinal, baseline: baselineCount },
      { timeout: 90_000, polling: 250 },
    );
    const tReply = Date.now();
    log(`reply finalized in ${tReply - t0} ms`);

    // 4. Reply text is a real fact, not a placeholder / refusal string.
    const finalText = await page.evaluate((sel) => {
      const nodes = document.querySelectorAll(sel);
      const last = nodes[nodes.length - 1];
      return (last?.textContent || '').trim();
    }, SEL.agentFinal);
    log(`reply text (${finalText.length} chars): ${finalText.slice(0, 160)}`);
    assert(finalText.length > 20, `reply too short to contain a real fact: ${JSON.stringify(finalText)}`);
    for (const re of PLACEHOLDER_PATTERNS) {
      assert(!re.test(finalText), `reply matched placeholder pattern ${re}: ${JSON.stringify(finalText.slice(0, 200))}`);
    }

    // 5. state.db has a tool turn for web_search.
    //
    // We can't map chat_id → state.db session_id from the proxy
    // anymore: /api/parley/sessions only exposes chat_id (the
    // parley-side identity), and state.db's sessions table has
    // no chat_id column (hermes manages session identity by its
    // own `id`). Instead, query the most-recent session in state.db
    // that started AFTER this test began (t0). Smokes are sequential,
    // so the most-recent recently-started session is ours.
    //
    // Hermes commits tool_calls to state.db asynchronously after the
    // response generator yields the final envelope — poll up to 10s
    // so the test isn't racing the write.
    const t0Sec = Math.floor(t0 / 1000);
    let rows = [];
    let sessionId = null;
    const pollStart = Date.now();
    while (Date.now() - pollStart < 10_000) {
      const recentSessions = await sqlQuery(
        STATE_DB,
        `SELECT id FROM sessions
         WHERE source = 'sidekick' AND started_at >= ${t0Sec}
         ORDER BY started_at DESC LIMIT 5`,
      );
      for (const s of recentSessions) {
        const found = await sqlQuery(
          STATE_DB,
          `SELECT id, role, tool_name, tool_calls FROM messages
             WHERE session_id = '${s.id}'
               AND (
                 tool_name = 'web_search'
                 OR (role = 'assistant' AND tool_calls LIKE '%"name": "web_search"%')
               )
             ORDER BY id ASC`,
        );
        if (found.length > 0) {
          rows = found;
          sessionId = s.id;
          break;
        }
      }
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    log(`state.db rows matching web_search: ${rows.length} (after ${Date.now() - pollStart}ms poll, session=${sessionId})`);
    if (rows.length === 0) {
      // Diagnostic: dump ALL recent sessions + their messages so we
      // can see what hermes actually wrote.
      const recentSessions = await sqlQuery(
        STATE_DB,
        `SELECT id, started_at, message_count, tool_call_count FROM sessions
         WHERE source = 'sidekick' ORDER BY started_at DESC LIMIT 3`,
      );
      log(`recent sessions: ${JSON.stringify(recentSessions, null, 2)}`);
    }
    assert(rows.length >= 1, `expected ≥1 web_search row in state.db (looking at sessions started after t0=${t0Sec}), got 0`);
  } finally {
    if (chatId) await deleteChat(page, chatId);
  }
}
