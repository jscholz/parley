// One-off UX render harness (not a smoke). Boots sidekick against the
// mock backend, seeds a realistic transcript (prose + markdown + code +
// list), and screenshots desktop+mobile × dark+light into a label dir.
//   node scripts/ux-render.mjs <label>
import { launchSharedBrowser, launchBrowser, waitForReady, DEFAULT_URL } from './smoke/lib.mjs';
import { installMockBackend } from './smoke/mock-backend.mjs';

const LABEL = process.argv[2] || 'render';
const OUT = `/tmp/ux-renders/${LABEL}`;
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

const CHAT = 'ux-demo';
const tSec = Date.now() / 1000;
const MESSAGES = [
  { role: 'user', content: 'Can you summarize the plan for the launch and flag anything risky?', message_id: 'm1', sidekick_id: 'm1', timestamp: tSec - 600 },
  { role: 'assistant', content: `Here's the shape of it.

**Launch plan — three phases**

1. **Soft launch** to the invite list (~20 people). Watch for signup friction.
2. **Show HN** timed to the next hermes news beat, with the demo video up top.
3. **Awesome-list PRs** the same week so the placement compounds.

The one risky dependency is the hosted demo instance — voice needs HTTPS + mic permission, so if that slips, the whole funnel stalls. I'd gate the HN post on it being live.

\`\`\`ts
const funnel = ['video', 'demo', 'show-hn'];
funnel.forEach(step => track(step));
\`\`\`

Want me to draft the Show HN copy?`, message_id: 'm2', sidekick_id: 'm2', timestamp: tSec - 580 },
  { role: 'user', content: 'Yes — keep it short and honest.', message_id: 'm3', sidekick_id: 'm3', timestamp: tSec - 120 },
  { role: 'assistant', content: `Draft:

> **Show HN: A voice-first phone client for self-hosted agents (Hermes, OpenClaw, Claude Code)**
>
> I got tired of only reaching my agent from a terminal, so I built a client I can talk to from my pocket — streaming dictation, real calls with barge-in, meeting capture. Backend-agnostic. Demo you can call from your phone in the link.

Short, leads with the wedge, names the backends. I can tune the tone if it reads too casual.`, message_id: 'm4', sidekick_id: 'm4', timestamp: tSec - 100 },
];

function seed(mock) {
  mock.addChat(CHAT, { title: 'Launch plan', source: 'sidekick', messages: MESSAGES, lastActiveAt: Date.now() });
  mock.addChat('ux-2', { title: 'Investor pitch intro refinement', source: 'sidekick', messages: [{ role: 'user', content: 'hi', message_id: 'x', timestamp: tSec - 9000 }], lastActiveAt: Date.now() - 3_600_000 });
  mock.addChat('ux-3', { title: 'Dust exposure health concerns', source: 'sidekick', messages: [{ role: 'user', content: 'hi', message_id: 'y', timestamp: tSec - 90000 }], lastActiveAt: Date.now() - 86_400_000 });
}

async function shoot(browser, { mobile, theme }) {
  const { page, cleanup } = await launchBrowser(browser, { mobile });
  const mock = await installMockBackend(page);
  seed(mock);
  await waitForReady(page);
  await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
  // open the chat
  if (!mobile) {
    await page.evaluate(() => {
      const el = document.querySelector('#sidebar'); if (el) el.classList.remove('collapsed');
    });
  }
  await page.click(`#sessions-list li[data-chat-id="${CHAT}"]`).catch(() => {});
  await page.waitForTimeout(1200);
  const name = `${mobile ? 'mobile' : 'desktop'}-${theme}.png`;
  await page.screenshot({ path: `${OUT}/${name}`, fullPage: false });
  console.log('shot', name);
  await mock.close?.().catch?.(() => {});
  await cleanup();
}

const { browser, closeShared } = await launchSharedBrowser({});
for (const mobile of [false, true]) {
  for (const theme of ['dark', 'light']) {
    await shoot(browser, { mobile, theme });
  }
}
await closeShared();
console.log('DONE ->', OUT);
