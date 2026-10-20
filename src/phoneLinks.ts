/**
 * @fileoverview Phone links: tap → a small menu with Call and Copy
 * (field 2026-10-20: "would be nice to be able to click that number and
 * call on mac/iphone, and to copy it").
 *
 * miniMarkdown renders tel: links as `a.phone-link[data-phone]`. Call
 * hands the tel: URL to the OS (iPhone dial sheet; on a Mac, FaceTime /
 * Continuity calling). Copy puts the number as written on the clipboard.
 * One menu at a time; Esc, an outside tap or scrolling closes it.
 */
import { toast } from './toast.ts';

let open: HTMLElement | null = null;

function close(): void {
  open?.remove();
  open = null;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older WebKit / no permission: the selection fallback.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

/** Build the menu for one link. Exported for tests. */
export function buildPhoneMenu(a: HTMLAnchorElement): HTMLElement {
  const number = a.dataset.phone || a.textContent?.trim() || '';
  const menu = document.createElement('div');
  menu.className = 'phone-menu';
  menu.setAttribute('role', 'menu');
  const call = document.createElement('a');
  call.className = 'phone-menu-item';
  call.setAttribute('role', 'menuitem');
  call.href = a.getAttribute('href') || '';
  call.textContent = `Call ${number}`;
  call.addEventListener('click', () => setTimeout(close, 0));
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'phone-menu-item';
  copy.setAttribute('role', 'menuitem');
  copy.textContent = 'Copy number';
  copy.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyText(number);
    close();
    toast(ok ? `Copied ${number}` : 'Could not copy', ok ? undefined : 'err');
  });
  menu.append(call, copy);
  return menu;
}

function place(menu: HTMLElement, a: HTMLElement): void {
  const r = a.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 220))}px`;
  const below = r.bottom + 6;
  menu.style.top = `${below + 96 > window.innerHeight ? Math.max(8, r.top - 96) : below}px`;
}

export function installPhoneLinks(root: Document | HTMLElement = document): void {
  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t || t.closest('.phone-menu')) return;
    const a = t.closest('a.phone-link') as HTMLAnchorElement | null;
    if (!a) { if (open) close(); return; }
    e.preventDefault();
    e.stopPropagation();
    close();
    const menu = buildPhoneMenu(a);
    document.body.appendChild(menu);
    place(menu, a);
    open = menu;
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) close(); });
  window.addEventListener('scroll', () => { if (open) close(); }, true);
}
