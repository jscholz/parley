// PNG app icons from the new SVGs via headless chromium (no CLI
// rasterizer on this box). icon.png: 512 transparent. icon-ios.png:
// 1024 opaque dark (iOS composites its own corner mask; transparent
// apple-touch icons get a black square).
import { launchSharedBrowser } from './smoke/lib.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(path.join(ROOT, 'assets/icon.svg'), 'utf8');
const { browser, closeShared } = await launchSharedBrowser({});
async function shot(px, bg, markPct, out) {
  const ctx = await browser.newContext({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const m = Math.round(px * markPct);
  await page.setContent(`<body style="margin:0;width:${px}px;height:${px}px;display:flex;align-items:center;justify-content:center;background:${bg}">`
    + svg.replace('<svg ', `<svg width="${m}" height="${m}" `) + '</body>');
  await page.waitForTimeout(300);
  await page.screenshot({ path: out, omitBackground: bg === 'transparent' });
  await ctx.close();
  console.log('wrote', out);
}
await shot(512, 'transparent', 0.86, path.join(ROOT, 'assets/icon.png'));
await shot(1024, '#0a0a0a', 0.68, path.join(ROOT, 'assets/icon-ios.png'));
await closeShared();
