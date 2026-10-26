import { createDrawer, type DrawerHandle } from '../Drawer.ts';

/** The drawer header's shared Clear button, as each module sees it. A
 *  module writes what IT wants (hidden / label / aria) at any time — even
 *  while another module is on screen (pins re-renders on every session
 *  list reload) — and the host applies only the ACTIVE module's wishes to
 *  the real button. Field 2026-10-26 (CAP, two pinned messages): the Pins
 *  module's background re-render un-hid "Clear" over a doc reader. */
export interface ClearButtonFacade {
  hidden: boolean;
  textContent: string;
  setAttribute(name: string, value: string): void;
}

export interface RightDrawerModuleContext {
  clearButton: ClearButtonFacade | null;
  isOpen: () => boolean;
  open: () => void;
  close: () => void;
  render: () => void;
}

export interface RightDrawerModule {
  id: string;
  title: string;
  panel: HTMLElement;
  toggleIds: string[];
  render(ctx: RightDrawerModuleContext): void;
  onClear?: (ctx: RightDrawerModuleContext) => void;
  onSelect?: (ctx: RightDrawerModuleContext) => void;
}

export interface RightDrawerHostOptions {
  drawerId: string;
  titleEl: HTMLElement | null;
  clearButton: HTMLElement | null;
  defaultModuleId: string;
  modules: RightDrawerModule[];
  bodyClass: string;
  prefKey: string;
  /** Plain open/close toggles for the drawer CHROME (e.g. the mobile
   *  toolbar's #btn-right-drawer) — no module-switch semantics; the
   *  drawer opens at its last-active tab. Routed into createDrawer's
   *  toggleIds so Drawer.ts owns the wiring: its listener
   *  stopPropagation()s (the tap can't be counted as "outside" and
   *  close-then-reopen the drawer) and registers the id in the drawers
   *  registry, so SIBLING drawers' click-outside handlers exempt it
   *  too (tapping it while the sidebar is open must not auto-close
   *  the sidebar — see the registry comment in Drawer.ts). */
  chromeToggleIds?: string[];
  excludeSwipeWhenTargetIn?: string[];
  resizer?: {
    handleId: string;
    cssVar: string;
    widthPrefKey: string;
    defaultWidthPx: number;
    minWidthPx: number;
    // Function form lets the ceiling track a live setting (panelMaxWidthPct)
    // without a reload; passed straight through to createDrawer's resizer.
    maxWidthPx: number | (() => number);
  };
}

export interface RightDrawerHost {
  isOpen(): boolean;
  open(): void;
  close(): void;
  activeModuleId(): string;
  select(moduleId: string, opts?: { open?: boolean }): void;
  render(): void;
}

export function createRightDrawerHost(opts: RightDrawerHostOptions): RightDrawerHost {
  const modules = new Map(opts.modules.map((m) => [m.id, m]));
  let activeId = modules.has(opts.defaultModuleId) ? opts.defaultModuleId : opts.modules[0]?.id || '';
  let chrome: DrawerHandle | null = null;

  const host: RightDrawerHost = {
    isOpen: () => !!chrome?.isOpen(),
    open: () => { chrome?.open(); },
    close: () => { chrome?.close(); },
    activeModuleId: () => activeId,
    select: (moduleId, selectOpts = {}) => {
      const mod = modules.get(moduleId);
      if (!mod) return;
      activeId = moduleId;
      if (opts.titleEl) opts.titleEl.textContent = mod.title;
      for (const candidate of opts.modules) {
        const selected = candidate.id === moduleId;
        candidate.panel.hidden = !selected;
        for (const toggleId of candidate.toggleIds) {
          const btn = document.getElementById(toggleId);
          if (!btn) continue;
          btn.classList.toggle('active', selected);
          btn.setAttribute('aria-selected', selected ? 'true' : 'false');
        }
      }
      applyClear(moduleId);
      mod.onSelect?.(ctxOf(moduleId));
      host.render();
      if (selectOpts.open) host.open();
    },
    render: () => {
      const mod = modules.get(activeId);
      if (!mod) return;
      mod.render(ctxOf(activeId));
    },
  };

  // Per-module Clear-button state; the real button mirrors the active one.
  interface ClearState { hidden: boolean; text: string; attrs: Record<string, string> }
  const clearStates = new Map<string, ClearState>();
  const applyClear = (moduleId: string) => {
    const btn = opts.clearButton;
    if (!btn) return;
    const st = clearStates.get(moduleId);
    if (!st) { btn.hidden = true; return; }
    btn.hidden = st.hidden;
    btn.textContent = st.text;
    for (const [k, v] of Object.entries(st.attrs)) btn.setAttribute(k, v);
  };
  const clearFacadeFor = (moduleId: string): ClearButtonFacade | null => {
    if (!opts.clearButton) return null;
    const st: ClearState = { hidden: true, text: 'Clear', attrs: {} };
    clearStates.set(moduleId, st);
    return {
      get hidden() { return st.hidden; },
      set hidden(v: boolean) { st.hidden = !!v; if (activeId === moduleId) applyClear(moduleId); },
      get textContent() { return st.text; },
      set textContent(v: string) { st.text = String(v ?? ''); if (activeId === moduleId) applyClear(moduleId); },
      setAttribute(name: string, value: string) { st.attrs[name] = value; if (activeId === moduleId) applyClear(moduleId); },
    };
  };
  const ctxFor = (moduleId: string): RightDrawerModuleContext => ({
    clearButton: clearFacadeFor(moduleId),
    isOpen: host.isOpen,
    open: host.open,
    close: host.close,
    render: host.render,
  });
  const ctxByModule = new Map<string, RightDrawerModuleContext>(opts.modules.map((m) => [m.id, ctxFor(m.id)]));
  const ctxOf = (moduleId: string): RightDrawerModuleContext => ctxByModule.get(moduleId) ?? ctxFor(moduleId);

  chrome = createDrawer({
    id: opts.drawerId,
    side: 'right',
    bodyClass: opts.bodyClass,
    prefKey: opts.prefKey,
    // Module toggles get capture-phase switch semantics below; chrome
    // toggles keep Drawer.ts's generic open/close-at-last-active-tab.
    // Both lists must be in createDrawer's toggleIds for the
    // click-outside exemptions (ours AND sibling drawers').
    toggleIds: [
      ...opts.modules.flatMap((m) => m.toggleIds),
      ...(opts.chromeToggleIds || []),
    ],
    excludeSwipeWhenTargetIn: opts.excludeSwipeWhenTargetIn || [],
    resizer: opts.resizer,
    onOpen: () => host.render(),
  });

  for (const mod of opts.modules) {
    for (const toggleId of mod.toggleIds) {
      const btn = document.getElementById(toggleId);
      if (!btn) continue;
      btn.addEventListener('click', (e) => {
        // Capture-phase override for Drawer.ts's generic toggle listener:
        // the right drawer rail is a module switcher. Clicking the active
        // module toggles the drawer; clicking another module switches panels.
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        if (host.isOpen() && activeId === mod.id) {
          host.close();
          return;
        }
        host.select(mod.id, { open: true });
      }, true);
    }
  }

  opts.clearButton?.addEventListener('click', () => {
    modules.get(activeId)?.onClear?.(ctxOf(activeId));
  });

  host.select(activeId);
  return host;
}
