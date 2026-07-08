import { chromium } from 'playwright-core';
import { CHROMIUM } from './scripts/smoke/lib.mjs';
import { installMockBackend } from './scripts/smoke/mock-backend.mjs';
const browser = await chromium.launch({ executablePath: CHROMIUM, args: [
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']});
const page = await (await browser.newContext({ permissions: ['microphone'], viewport: { width: 900, height: 700 } })).newPage();
await installMockBackend(page);
await page.goto('http://127.0.0.1:3001/');
await page.waitForSelector('#capture-pill', { state: 'attached', timeout: 10000 });
// Open mic menu → screenshot the item, then start.
await page.evaluate(() => {
  const menu = document.getElementById('mic-mode-menu');
  if (menu) { menu.hidden = false; menu.setAttribute('aria-hidden', 'false'); }
});
await page.screenshot({ path: '/tmp/capture-menu.png', clip: { x: 450, y: 380, width: 450, height: 320 } });
await page.evaluate(() => document.getElementById('mic-menu-record-meeting').click());
await page.waitForFunction(() => !document.getElementById('capture-pill').hidden, null, { timeout: 8000 });
await new Promise(r => setTimeout(r, 1200));
const pill = await page.locator('#capture-pill').boundingBox();
await page.screenshot({ path: '/tmp/capture-pill-recording.png', clip: { x: pill.x - 20, y: pill.y - 15, width: pill.width + 40, height: pill.height + 30 } });
// Pause → screenshot paused state.
await page.click('#capture-pill-pause');
await new Promise(r => setTimeout(r, 500));
await page.screenshot({ path: '/tmp/capture-pill-paused.png', clip: { x: pill.x - 20, y: pill.y - 15, width: pill.width + 40, height: pill.height + 30 } });
// Resume → verify recording again, then stop.
await page.click('#capture-pill-pause');
await page.waitForFunction(async () => {
  const mod = await import('/build/capture/recorder.mjs');
  return mod.getCaptureState().phase === 'recording';
}, null, { timeout: 5000 });
console.log('pause→resume roundtrip OK');
await browser.close();
