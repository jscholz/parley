import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL = 'http://localhost:3020';
const OUT = '/tmp/parley-shots';
mkdirSync(OUT, { recursive: true });

const exec = process.env.PLAYWRIGHT_CHROMIUM || '/usr/bin/chromium';
const browser = await chromium.launch({ executablePath: exec, headless: true });

const SETTINGS_KEY = 'parley.settings.v2';

for (const theme of ['dark', 'light']) {
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
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  // Make sure focus is OFF the composer so the keyboard-style focus
  // ring doesn't appear in the screenshot.
  await page.evaluate(() => (document.activeElement)?.blur?.());
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/mobile-${theme}.png` });
  console.log(`saved mobile-${theme}.png`);
  await ctx.close();
}

await browser.close();
console.log('done');
