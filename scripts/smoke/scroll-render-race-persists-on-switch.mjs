import { waitForReady, openSidebar, clickRow, assert } from "./lib.mjs";

export const NAME = "scroll-render-race-persists-on-switch";
export const DESCRIPTION = "Saved scroll anchor survives transient render-time scroll events during session switch";
export const STATUS = "implemented";
export const BACKEND = "mocked";

const CHAT_A = "mock-scroll-race-chat-a";
const CHAT_B = "mock-scroll-race-chat-b";

function makeMessages(count, prefix) {
  const out = [];
  const body = `${prefix}: ${"render race anchor text ".repeat(24)}`;
  for (let i = 0; i < count; i++) {
    out.push({
      id: i + 1,
      parley_id: `${prefix.toLowerCase()}-race-${i + 1}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `${body} (msg ${i})`,
      timestamp: Date.now() / 1000 - (count - i) * 60,
    });
  }
  return out;
}

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: "Chat A - render scroll race",
    source: "parley",
    messages: makeMessages(60, "A"),
    lastActiveAt: Date.now() - 60000,
  });
  mock.addChat(CHAT_B, {
    title: "Chat B - race switch target",
    source: "parley",
    messages: makeMessages(8, "B"),
    lastActiveAt: Date.now() - 30000,
  });
}

async function currentAnchor(page) {
  return page.evaluate(() => {
    const t = document.getElementById("transcript");
    if (!t) return null;
    // Walk `.line` descendants (works under virt: bubbles are inside
    // .transcript-slot, not direct children of transcriptEl).
    const tr = t.getBoundingClientRect();
    const lines = Array.from(t.querySelectorAll(".line"));
    for (const el of lines) {
      const r = el.getBoundingClientRect();
      if (r.bottom <= tr.top) continue;
      if (r.top >= tr.bottom) break;
      return {
        key: el.getAttribute("data-key"),
        top: Math.round(r.top - tr.top),
        scrollTop: Math.round(t.scrollTop),
        text: (el.textContent || "").replace(/\s+/g, " ").slice(0, 120),
      };
    }
    return null;
  });
}

async function installRenderScrollRace(page) {
  await page.evaluate(() => {
    const t = document.getElementById("transcript");
    if (!t) return;
    let fired = false;
    const mo = new MutationObserver(() => {
      if (fired) return;
      if (!(t.textContent || "").includes("render race anchor text")) return;
      fired = true;
      t.scrollTop = 0;
      t.dispatchEvent(new Event("scroll", { bubbles: true }));
      mo.disconnect();
    });
    mo.observe(t, { childList: true, subtree: true, characterData: true });
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(800);

  // Under virt only ~30 specs are in DOM at a time. Use scrollHeight
  // vs viewport as the "chat is deeply scrollable" precondition.
  const sg = await page.evaluate(() => {
    const t = document.getElementById("transcript");
    return t ? { sh: t.scrollHeight, ch: t.clientHeight } : null;
  });
  assert(sg && sg.sh > sg.ch * 3,
    `chat A must be deeply scrollable: scrollHeight=${sg?.sh} clientHeight=${sg?.ch}`);

  await page.evaluate(() => {
    const t = document.getElementById("transcript");
    const lines = t?.querySelectorAll(".line");
    const row = lines?.[30];
    if (!t || !row) return;
    row.scrollIntoView({ block: "start", inline: "nearest" });
    t.scrollTo({ top: t.scrollTop + 91, behavior: "instant" });
  });
  await page.waitForTimeout(700);
  const before = await currentAnchor(page);
  assert(before?.key, `expected saved anchor before switch, got ${JSON.stringify(before)}`);
  log(`before switch: key=${before.key} top=${before.top} scrollTop=${before.scrollTop}`);

  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);

  await installRenderScrollRace(page);
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1500);

  const after = await currentAnchor(page);
  assert(after?.key, `expected anchor after switch, got ${JSON.stringify(after)}`);
  log(`after switch: key=${after.key} top=${after.top} scrollTop=${after.scrollTop}`);
  assert(after.key === before.key, `expected same anchor after render-time scroll race. before=${before.key} after=${after.key}`);
  assert(Math.abs(after.top - before.top) <= 24, `expected anchor offset preserved. beforeTop=${before.top} afterTop=${after.top}`);
}
