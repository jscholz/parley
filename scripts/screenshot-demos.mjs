import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';

const URL = 'http://localhost:3020';
const OUT = '/tmp/parley-shots';
mkdirSync(OUT, { recursive: true });

const CHAT_ID = readFileSync('/tmp/demo-d', 'utf-8').trim().split(/\s+/)[1];
const SETTINGS_KEY = 'sidekick.settings.v2';

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

  // Navigate into the demo chat via the drawer. On mobile the drawer
  // is collapsed by default — open it, click the row, then close.
  await page.locator('#sb-toggle-mobile').click().catch(() => {});
  await page.waitForTimeout(400);
  // Click the row whose data-chat-id matches our demo session.
  const fullId = `sidekick:${CHAT_ID}`;
  const clicked = await page.evaluate((id) => {
    const rows = Array.from(document.querySelectorAll('[data-chat-id], [data-id]'));
    const row = rows.find(r => r.getAttribute('data-chat-id') === id || r.getAttribute('data-id') === id);
    if (row) { row.click(); return true; }
    // Fallback: find by title text
    const labels = Array.from(document.querySelectorAll('.session-row, .sess-row'));
    const target = labels.find(el => el.textContent && (el.textContent.includes('Tesco') || el.textContent.includes('office')));
    if (target) { target.click(); return 'fallback'; }
    return false;
  }, fullId);
  console.log(`navigated by row click: ${clicked}`);
  // Force-close the sidebar via direct class manipulation. The toggle
  // click sometimes races / no-ops; rip it via DOM to guarantee state.
  await page.evaluate(() => {
    const sb = document.getElementById('sidebar');
    if (sb) {
      sb.classList.remove('expanded');
      sb.classList.add('collapsed');
      sb.setAttribute('aria-expanded', 'false');
    }
    document.body.classList.remove('sidebar-expanded');
  });
  await page.waitForTimeout(400);
  await page.waitForTimeout(2500);  // chat replay + cards (link previews, map embeds) need time

  // Top-of-chat shot
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) t.scrollTop = 0;
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => (document.activeElement)?.blur?.());
  await page.screenshot({ path: `${OUT}/demo-D-${theme}-top.png` });
  console.log(`saved demo-D-${theme}-top.png`);

  // Bottom-of-chat shot (map card)
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) t.scrollTop = t.scrollHeight;
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/demo-D-${theme}-bottom.png` });
  console.log(`saved demo-D-${theme}-bottom.png`);

  await ctx.close();
}

await browser.close();
console.log('done');
