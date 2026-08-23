import { waitForReady, openSidebar, clickRow, assert } from "./lib.mjs";

export const NAME = "scroll-anchor-persists-on-switch";
export const DESCRIPTION = "Mid-transcript visual anchor survives session switch";
export const STATUS = "implemented";
export const BACKEND = "mocked";

const CHAT_A = "mock-scroll-anchor-chat-a";
const CHAT_B = "mock-scroll-anchor-chat-b";

function makeMessages(count, prefix) {
  const out = [];
  const body = `${prefix}: ${"read-position anchor text ".repeat(22)}`;
  for (let i = 0; i < count; i++) {
    out.push({
      id: i + 1,
      parley_id: `${prefix.toLowerCase()}-${i + 1}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `${body} (msg ${i})`,
      timestamp: Date.now() / 1000 - (count - i) * 60,
    });
  }
  return out;
}

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: "Chat A - anchor preserve",
    source: "parley",
    messages: makeMessages(56, "A"),
    lastActiveAt: Date.now() - 60000,
  });
  mock.addChat(CHAT_B, {
    title: "Chat B - switch target",
    source: "parley",
    messages: makeMessages(10, "B"),
    lastActiveAt: Date.now() - 30000,
  });
}

async function currentAnchor(page) {
  return page.evaluate(() => {
    const t = document.getElementById("transcript");
    if (!t) return null;
    // Under virt, transcript children are [spacer-top, slot, spacer-
    // bottom]; the .line bubbles live inside .transcript-slot. Walk
    // .line descendants directly so the lookup works under both paths.
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
        text: (el.textContent || "").replace(/\s+/g, " " ).slice(0, 120),
      };
    }
    return null;
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(800);
  // Precondition: chat is deeply scrollable. Under virt only ~30
  // bubbles are in DOM at a time so the legacy `.line.count() >= 45`
  // assertion doesn't hold; use scrollHeight vs viewport instead —
  // the signal we actually care about is "there's room to scroll."
  const scrollGeom = await page.evaluate(() => {
    const t = document.getElementById("transcript");
    if (!t) return null;
    return { scrollHeight: t.scrollHeight, clientHeight: t.clientHeight };
  });
  assert(scrollGeom && scrollGeom.scrollHeight > scrollGeom.clientHeight * 3,
    `chat A must be deeply scrollable: scrollHeight=${scrollGeom?.scrollHeight} clientHeight=${scrollGeom?.clientHeight}`);
  // Scroll the 27th bubble into view. Walk `.line` descendants (works
  // under virt; the bubble lives inside the slot, not as a direct
  // child of transcriptEl).
  await page.evaluate(() => {
    const t = document.getElementById("transcript");
    const lines = t?.querySelectorAll(".line");
    const row = lines?.[26];
    if (!t || !row) return;
    row.scrollIntoView({ block: "start", inline: "nearest" });
    t.scrollTo({ top: t.scrollTop + 73, behavior: "instant" });
  });
  await page.waitForTimeout(700);
  const before = await currentAnchor(page);
  assert(before?.key, `expected a keyed first-visible anchor before switch, got ${JSON.stringify(before)}`);
  log(`before switch: key=${before.key} top=${before.top} scrollTop=${before.scrollTop} text=${before.text}`);
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1500);
  const after = await currentAnchor(page);
  assert(after?.key, `expected a keyed first-visible anchor after switch, got ${JSON.stringify(after)}`);
  log(`after switch: key=${after.key} top=${after.top} scrollTop=${after.scrollTop} text=${after.text}`);
  assert(after.key === before.key, `expected same first-visible anchor after switch. before=${before.key} after=${after.key}`);
  assert(Math.abs(after.top - before.top) <= 24, `expected anchor visual offset to be preserved. beforeTop=${before.top} afterTop=${after.top}`);
}
