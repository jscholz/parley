import { createDrawer, type DrawerHandle } from '../Drawer.ts';

export interface RightDrawerModuleContext {
  clearButton: HTMLElement | null;
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
      mod.onSelect?.(ctx);
      host.render();
      if (selectOpts.open) host.open();
    },
    render: () => {
      const mod = modules.get(activeId);
      if (!mod) return;
      mod.render(ctx);
    },
  };

  const ctx: RightDrawerModuleContext = {
    clearButton: opts.clearButton,
    isOpen: host.isOpen,
    open: host.open,
    close: host.close,
    render: host.render,
  };

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
    modules.get(activeId)?.onClear?.(ctx);
  });

  host.select(activeId);
  return host;
}
