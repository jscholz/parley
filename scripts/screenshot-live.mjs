// Live-turn capture. Historical replay doesn't reconstruct tool_call /
// tool_result envelopes (those only fire as SSE during a turn) so a
// screenshot of a resumed chat shows agent text but no activity rows
// and no inline cards. This script types the prompt fresh, waits for
// the live envelopes to populate the DOM, then captures.

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL = 'http://localhost:3020';
const OUT = '/tmp/parley-shots';
mkdirSync(OUT, { recursive: true });

const PROMPT = "give me directions from my office to the nearest tesco";
const SETTINGS_KEY = 'parley.settings.v2';

const exec = process.env.PLAYWRIGHT_CHROMIUM || '/usr/bin/chromium';
const browser = await chromium.launch({ executablePath: exec, headless: true });

for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  await ctx.addInitScript(({ key, theme }) => {
    try {
      const cur = JSON.parse(localStorage.getItem(key) || '{}');
      cur.theme = theme;
      localStorage.setItem(key, JSON.stringify(cur));
    } catch {}
  }, { key: SETTINGS_KEY, theme });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);

  // Open drawer, click "New chat", close drawer.
  await page.locator('#sb-toggle-mobile').click().catch(() => {});
  await page.waitForTimeout(400);
  await page.locator('#sb-new-chat').click().catch(() => {});
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const sb = document.getElementById('sidebar');
    if (sb) { sb.classList.remove('expanded'); sb.classList.add('collapsed'); }
    document.body.classList.remove('sidebar-expanded');
  });
  await page.waitForTimeout(300);

  // Type the prompt + send.
  await page.locator('#composer-input, textarea').first().fill(PROMPT);
  await page.waitForTimeout(200);
  await page.locator('#composer-send, [aria-label="Send"]').first().click();
  console.log(`[${theme}] dispatched, waiting for tool activity row...`);

  // Wait for at least one tool row to appear (proves live envelopes are flowing).
  await page.locator('.tool-row, .activity-row').first().waitFor({ timeout: 30_000 }).catch(() => {
    console.log(`[${theme}] no tool row appeared in 30s`);
  });
  console.log(`[${theme}] tool row present, waiting for reply_final + cards...`);

  // Wait for the assistant bubble to settle. Heuristic: wait until
  // we see an assistant line whose text contains "Tesco" (the answer).
  await page.locator('.line.agent, .line.assistant').filter({ hasText: 'Tesco' }).first()
    .waitFor({ timeout: 90_000 }).catch(() => {
      console.log(`[${theme}] no Tesco-mentioning reply in 90s`);
    });
  console.log(`[${theme}] reply present, waiting for card render...`);

  // Give cards (link previews / map embeds) extra time to render.
  await page.waitForTimeout(4000);
  await page.evaluate(() => (document.activeElement)?.blur?.());

  // Bottom-of-chat shot (should include the map card).
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) t.scrollTop = t.scrollHeight;
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/live-${theme}-bottom.png` });
  console.log(`saved live-${theme}-bottom.png`);

  // Top-of-chat shot (user prompt + activity row + start of reply).
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) t.scrollTop = 0;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/live-${theme}-top.png` });
  console.log(`saved live-${theme}-top.png`);

  await ctx.close();
}

await browser.close();
console.log('done');
