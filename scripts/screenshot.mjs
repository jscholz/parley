import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const URL = 'http://localhost:3020';
const OUT = '/tmp/parley-shots';
mkdirSync(OUT, { recursive: true });

const exec = process.env.PLAYWRIGHT_CHROMIUM || '/usr/bin/chromium';
const browser = await chromium.launch({ executablePath: exec, headless: true });

const SETTINGS_KEY = 'parley.settings.v2';
const SIDEBAR_KEY = 'parley.sidebar.expanded';

/**
 * Prep a context: pre-set parley localStorage so the first paint has
 * the right theme + sidebar state — no flash, no post-load click. Then
 * navigate to the empty-new-chat URL.
 */
async function prep(ctx, { theme, sidebarExpanded }) {
  const page = await ctx.newPage();
  // localStorage is per-origin, so set it via an init script that runs
  // before any page script.
  await ctx.addInitScript(({ key, theme, sbKey, sbExp }) => {
    try {
      const cur = JSON.parse(localStorage.getItem(key) || '{}');
      cur.theme = theme;
      localStorage.setItem(key, JSON.stringify(cur));
      localStorage.setItem(sbKey, sbExp ? '1' : '0');
    } catch {}
  }, { key: SETTINGS_KEY, theme, sbKey: SIDEBAR_KEY, sbExp: sidebarExpanded });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  // Belt-and-braces theme set in case settings.load() hasn't won the
  // race yet — applyTheme writes data-theme on documentElement.
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(200);
  return page;
}

// ── Desktop with sidebar open — shows the joke session list ──────────
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({
    viewport: { width: 1100, height: 850 },
    deviceScaleFactor: 2,
  });
  const page = await prep(ctx, { theme, sidebarExpanded: true });
  // Click "New chat" to reset content area to the empty state, so the
  // sidebar takes the visual focus rather than a "You said: ..." echo.
  await page.locator('#sb-new-chat, [aria-label="New chat"]').first().click().catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/desktop-${theme}.png` });
  console.log(`saved desktop-${theme}.png`);
  await ctx.close();
}

// ── Mobile portrait, empty state — for the README hero ───────────────
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await prep(ctx, { theme, sidebarExpanded: false });
  // Mobile sidebar collapses by default; the new-chat button lives
  // inside the drawer. Open the drawer, click new-chat, then close
  // the drawer so the screenshot shows the chat surface (not the open
  // drawer which would obscure everything).
  await page.locator('#sb-toggle-mobile').click().catch(() => {});
  await page.waitForTimeout(300);
  await page.locator('#sb-new-chat').click().catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/mobile-${theme}.png` });
  console.log(`saved mobile-${theme}.png`);
  await ctx.close();
}

await browser.close();
console.log('done');
