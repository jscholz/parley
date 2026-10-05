/**
 * @fileoverview Recognise an in-app chat deep link inside rendered text.
 *
 * The agent (hermes' `/branch` reply via the Parley plugin, push payloads,
 * anything else that wants to point at a chat) writes links in the PWA's
 * own URL grammar: `/?chat=<id>` with an optional `&msg=<id>`. Followed as
 * a real navigation that URL works — main.ts reads `?chat=` at boot — but
 * it reloads the whole app to get there. Clicks on such links inside the
 * transcript are intercepted and routed through the same in-place switch a
 * notification tap uses (`parley:open-chat`), so the branch link lands you
 * in the new chat without a reload (his 2026-10-05 nit).
 *
 * Pure: takes the anchor's href as written plus the page origin, returns
 * the target or null. Off-origin links, other paths and query strings
 * without `chat` are not ours — the external-link handler and the browser
 * keep those.
 */

export type ChatDeepLink = { chatId: string; msgId: string | null };

export function parseChatDeepLink(href: string | null | undefined, origin: string): ChatDeepLink | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  // Only the app root carries the boot-time `?chat=` grammar.
  if (url.pathname !== '/' && url.pathname !== '/index.html') return null;
  const chatId = (url.searchParams.get('chat') || '').trim();
  if (!chatId) return null;
  const msg = (url.searchParams.get('msg') || '').trim();
  return { chatId, msgId: msg || null };
}
