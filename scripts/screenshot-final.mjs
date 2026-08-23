// One-conversation, two-viewport README shots. The chat already has
// the Buckingham Palace setup turn done in hermes; one playwright run
// opens the chat, sends the question via mobile composer, waits for
// live cards to render, screenshots mobile, RESIZES viewport to
// desktop, screenshots desktop. Same conversation, two phones, single
// live flow — no duplicate user prompts.

import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';

const URL = 'http://localhost:3020';
const OUT = '/tmp/parley-shots';
mkdirSync(OUT, { recursive: true });

const CHAT_ID = readFileSync('/tmp/demo-final', 'utf-8').trim();
const FULL_CHAT_ID = `parley:${CHAT_ID}`;
const PROMPT = "give me directions from my office to the nearest tesco";
const SETTINGS_KEY = 'parley.settings.v2';

const exec = process.env.PLAYWRIGHT_CHROMIUM || '/usr/bin/chromium';
const browser = await chromium.launch({ executablePath: exec, headless: true });

// Open at MOBILE viewport first so the live SSE flow renders into a
// mobile-shaped layout (composer position, etc.).
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
await ctx.addInitScript(({ key, theme }) => {
  try {
    const cur = JSON.parse(localStorage.getItem(key) || '{}');
    cur.theme = theme;
    localStorage.setItem(key, JSON.stringify(cur));
    localStorage.setItem('parley.sidebar.expanded', '0');
  } catch {}
}, { key: SETTINGS_KEY, theme: 'dark' });

const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });

// Open drawer + click the demo chat. The handler lives on .sess-body
// inside li[data-chat-id="..."] — clicking the li itself doesn't fire it.
await page.locator('#sb-toggle-mobile').click().catch(() => {});
await page.waitForTimeout(600);
const clickResult = await page.evaluate((id) => {
  const li = document.querySelector(`li[data-chat-id="${id.replace(/"/g, '\\"')}"]`);
  if (!li) return { ok: false, reason: 'li-not-found', count: document.querySelectorAll('li[data-chat-id]').length };
  const body = li.querySelector('.sess-body');
  if (!body) return { ok: false, reason: 'body-not-found' };
  body.click();
  return { ok: true };
}, FULL_CHAT_ID);
console.log('row click:', JSON.stringify(clickResult));
await page.waitForTimeout(1200);
// Verify we're in the right chat — check for the setup turn text in transcript.
const inRightChat = await page.evaluate(() => {
  const lines = document.querySelectorAll('.line.user, .line.you');
  for (const l of lines) {
    if (l.textContent && l.textContent.includes('Buckingham Palace')) return true;
  }
  return false;
});
console.log('in right chat (setup visible):', inRightChat);
// Force-close drawer.
await page.evaluate(() => {
  const sb = document.getElementById('sidebar');
  if (sb) { sb.classList.remove('expanded'); sb.classList.add('collapsed'); }
  document.body.classList.remove('sidebar-expanded');
});
await page.waitForTimeout(400);

// Submit the prompt via the composer for live flow.
await page.locator('#composer-input, textarea').first().fill(PROMPT);
await page.waitForTimeout(200);
await page.locator('#composer-send, [aria-label="Send"]').first().click({ force: true });
console.log('dispatched, waiting for reply...');

// Wait for the assistant reply to settle: a line containing 'Tesco'.
await page.waitForFunction(() => {
  const lines = document.querySelectorAll('.line.agent, .line.assistant');
  for (const l of lines) {
    if (l.textContent && l.textContent.toLowerCase().includes('tesco')) return true;
  }
  return false;
}, { timeout: 60_000 }).catch(() => console.log('timeout waiting for Tesco reply'));
console.log('reply present, waiting for map embed iframe...');

// Wait for the map embed iframe to load (the actual map card).
await page.waitForSelector('iframe[src*="google.com/maps/embed"]', { timeout: 30_000 })
  .catch(() => console.log('no map iframe within 30s — continuing'));
// Extra dwell — the iframe appears in DOM quickly but the map tiles
// + route polyline take several seconds to render inside it. Without
// this wait we screenshot a world-view placeholder.
await page.waitForTimeout(12_000);

await page.evaluate(() => (document.activeElement)?.blur?.());
await page.evaluate(() => {
  const t = document.getElementById('transcript');
  if (t) t.scrollTop = t.scrollHeight;
});
await page.waitForTimeout(600);

// MOBILE shot.
await page.screenshot({ path: `${OUT}/final-mobile-dark.png` });
console.log('saved final-mobile-dark.png');

// DESKTOP shot — resize viewport on the same context, expand sidebar.
await page.setViewportSize({ width: 1280, height: 850 });
await page.waitForTimeout(600);
await page.evaluate(() => {
  const sb = document.getElementById('sidebar');
  if (sb) { sb.classList.add('expanded'); sb.classList.remove('collapsed'); }
  document.body.classList.add('sidebar-expanded');
  localStorage.setItem('parley.sidebar.expanded', '1');
});
await page.waitForTimeout(800);
// Re-scroll because viewport change resets scroll behavior.
await page.evaluate(() => {
  const t = document.getElementById('transcript');
  if (t) t.scrollTop = t.scrollHeight;
});
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/final-desktop-dark.png` });
console.log('saved final-desktop-dark.png');

await ctx.close();
await browser.close();
console.log('done');
