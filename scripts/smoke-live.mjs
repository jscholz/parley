#!/usr/bin/env node
/**
 * Read-only LIVE smoke against a *deployed* parley instance.
 *
 * The mock-backend smoke suite (`npm run smoke`) proves the frontend
 * logic against a stubbed API; it intercepts `/api/parley/*` with
 * `page.route()` so it never touches a real proxy or backend. That
 * leaves a gap exactly where pushes break: contract drift between the
 * deployed bundle, the proxy, and the live agent. This smoke fills it —
 * it exercises the REAL stack over the REAL network as a pre-push gate.
 *
 * Two phases, both strictly READ-ONLY (no message send, no delete, no
 * settings write — safe to run against an instance holding real data):
 *
 *   1. HTTP contract — hit the proxy's read endpoints directly and
 *      assert response shapes: /sessions, /sessions/{id}/messages,
 *      /config, /prefs, and the /stream SSE channel.
 *   2. Browser — boot the actual PWA in headless Chromium, wait for it
 *      to report Connected, assert the drawer renders real sessions and
 *      the transcript renders message bubbles.
 *
 * The only write a browser load can incur is the PWA's own read-pointer
 * update on the auto-opened session (marks it read) — inherent to
 * loading the app, benign, and scoped to the most-recent session.
 *
 * Usage:
 *   npm run smoke:live                       # default target = blueberry
 *   SMOKE_LIVE_URL=https://host:3001 npm run smoke:live
 *   SMOKE_LIVE_TOKEN=<bearer> npm run smoke:live   # if the proxy gates
 *   npm run smoke:live -- --http-only        # skip the browser phase
 *
 * Exit: 0 = all checks passed, 1 = a check failed, 2 = harness error.
 */

import { chromium } from 'playwright-core';
import { CHROMIUM } from './smoke/lib.mjs';

const URL = (process.env.SMOKE_LIVE_URL || process.env.SMOKE_URL
  || 'https://blueberry.tail0c7ad3.ts.net:3001').replace(/\/+$/, '');
const TOKEN = (process.env.SMOKE_LIVE_TOKEN || '').trim();
const HTTP_ONLY = process.argv.includes('--http-only');
const HEADED = process.argv.includes('--headed');

const authHeaders = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Shared across checks: the first drawer row's chat_id, discovered by
// the sessions check and reused by the messages check.
let firstChatId = null;

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// ── Phase 1: HTTP contract (read-only) ────────────────────────────────

check('GET /api/parley/sessions → non-empty {sessions:[...]}', async () => {
  const r = await fetch(`${URL}/api/parley/sessions?limit=5`, { headers: authHeaders });
  assert(r.ok, `HTTP ${r.status}`);
  const j = await r.json();
  assert(Array.isArray(j.sessions), 'sessions is not an array');
  assert(j.sessions.length > 0, 'no sessions returned (empty instance?)');
  const row = j.sessions[0];
  for (const k of ['chat_id', 'source', 'title', 'message_count', 'last_active_at']) {
    assert(k in row, `session row missing "${k}"`);
  }
  firstChatId = row.chat_id;
});

check('GET /sessions/{id}/messages → {messages:[...]} with id/role/content', async () => {
  assert(firstChatId, 'no chat_id from the sessions check');
  const r = await fetch(
    `${URL}/api/parley/sessions/${encodeURIComponent(firstChatId)}/messages?limit=5`,
    { headers: authHeaders },
  );
  assert(r.ok, `HTTP ${r.status}`);
  const j = await r.json();
  assert(Array.isArray(j.messages), 'messages is not an array');
  if (j.messages.length > 0) {
    const m = j.messages[0];
    for (const k of ['id', 'role', 'content']) assert(k in m, `message missing "${k}"`);
  }
});

check('GET /api/parley/config → {settings:{...}}', async () => {
  const r = await fetch(`${URL}/api/parley/config`, { headers: authHeaders });
  assert(r.ok, `HTTP ${r.status}`);
  const j = await r.json();
  assert(j.settings && typeof j.settings === 'object', 'no settings object');
});

check('GET /api/parley/prefs → {settings:{...}}', async () => {
  const r = await fetch(`${URL}/api/parley/prefs`, { headers: authHeaders });
  assert(r.ok, `HTTP ${r.status}`);
  const j = await r.json();
  assert(j.settings && typeof j.settings === 'object', 'no settings object');
});

check('GET /api/parley/stream → SSE channel connects', async () => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const r = await fetch(`${URL}/api/parley/stream`, {
      headers: { ...authHeaders, accept: 'text/event-stream' },
      signal: ac.signal,
    });
    assert(r.ok, `HTTP ${r.status}`);
    assert(
      /text\/event-stream/.test(r.headers.get('content-type') || ''),
      `wrong content-type: ${r.headers.get('content-type')}`,
    );
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
});

// ── Phase 2: browser (read-only) ──────────────────────────────────────

let browser = null;
let page = null;

check('PWA boots + reports Connected + drawer renders real sessions', async () => {
  browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: !HEADED,
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  page = await ctx.newPage();
  await page.goto(`${URL}/?debug=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#composer-input', { timeout: 30_000 });
  await page.waitForFunction(
    () => /Connected/.test(document.body.innerText),
    null,
    { timeout: 30_000, polling: 250 },
  );
  // Drawer rows arrive a beat after connect; they may live in a
  // collapsed drawer, so wait on attachment not visibility.
  await page.waitForSelector('#sessions-list li[data-chat-id]', {
    state: 'attached', timeout: 30_000,
  });
  const rows = await page.$$eval('#sessions-list li[data-chat-id]', (els) => els.length);
  assert(rows > 0, 'drawer rendered zero session rows');
});

check('Opening a session renders transcript bubbles', async () => {
  assert(page, 'no page from the boot check');
  // Click the first drawer row (most-recent; usually already active —
  // a no-harm read). Then wait for at least one message bubble.
  await page.evaluate(() => {
    const row = document.querySelector('#sessions-list li[data-chat-id]');
    if (row) row.click();
  });
  await page.waitForSelector('#transcript .line', { state: 'attached', timeout: 30_000 });
  const bubbles = await page.$$eval('#transcript .line', (els) => els.length);
  assert(bubbles > 0, 'transcript rendered zero bubbles');
});

// ── Runner ────────────────────────────────────────────────────────────

async function main() {
  const runnable = HTTP_ONLY
    ? checks.filter((c) => !/PWA boots|transcript bubbles/.test(c.name))
    : checks;

  console.log(`[smoke:live] target ${URL}${HTTP_ONLY ? ' (http-only)' : ''}`);
  console.log('');
  const results = [];
  for (const c of runnable) {
    const t0 = Date.now();
    try {
      await c.fn();
      const ms = Date.now() - t0;
      console.log(`  ✓ ${c.name}  (${ms} ms)`);
      results.push({ name: c.name, ok: true });
    } catch (e) {
      const ms = Date.now() - t0;
      console.log(`  ✗ ${c.name}  (${ms} ms)`);
      console.log(`      ${e.message}`);
      results.push({ name: c.name, ok: false });
    }
  }

  if (browser) { try { await browser.close(); } catch { /* ignore */ } }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length > 0) {
    console.log(`[smoke:live] ${failed.length}/${results.length} FAILED`);
    process.exit(1);
  }
  console.log(`[smoke:live] all ${results.length} passed`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`[smoke:live] harness error: ${e.stack || e.message}`);
  if (browser) { browser.close().catch(() => {}); }
  process.exit(2);
});
