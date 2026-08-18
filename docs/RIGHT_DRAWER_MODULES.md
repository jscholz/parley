# Right Drawer Modules

The right drawer is designed as an internal module host. It is not a public
third-party plugin API yet, but new first-party drawer surfaces should use this
contract instead of wiring another bespoke drawer.

## Current Modules

The right drawer host lives in `src/rightDrawer/host.ts`. First-party modules
live under `src/rightDrawer/modules/` and are registered from
`src/pins/drawer.ts`, which now only bootstraps the historical drawer DOM and
shared chrome.

- `activity` — `src/rightDrawer/modules/activity.ts`. Approval, cron, and
  agent-reply activity. Uses the bell rail button and stores entries through
  `src/notifications/activityStore.ts`.
- `pins` — `src/rightDrawer/modules/pins.ts`. Pinned messages across chats.
  Uses the pin rail button and stores entries through `src/pins/store.ts`.

The module files own their data-specific rendering and actions. The host owns
panel selection, rail toggle behavior, title updates, shared clear button
behavior, drawer open/close state, swipe exclusion, and resizing.

## Module Contract

A module supplies a `RightDrawerModule`:

```ts
interface RightDrawerModule {
  id: string;
  title: string;
  panel: HTMLElement;
  toggleIds: string[];
  render(ctx: RightDrawerModuleContext): void;
  onClear?: (ctx: RightDrawerModuleContext) => void;
  onSelect?: (ctx: RightDrawerModuleContext) => void;
}
```

The host supplies `RightDrawerModuleContext` to keep modules out of drawer
chrome details:

- `clearButton` — the shared header action. Modules set its label, visibility,
  tooltip, and behavior through `onClear`.
- `isOpen()`, `open()`, `close()` — drawer state helpers.
- `render()` — rerender the active module.

A module should own its data model and rendering. The host owns only chrome and
routing between modules.

## Adding A First-Party Module

1. Add the module panel markup to the right drawer body and a rail button in the
   drawer rail.
2. Add a module file under `src/rightDrawer/modules/` that exports a
   `createXModule(...)` factory. The renderer should accept
   `RightDrawerModuleContext` and write only inside the module panel.
3. Register the module in the `modules` array passed to
   `createRightDrawerHost` from `src/pins/drawer.ts`.
4. Use a domain event, such as `sidekick:activity-changed`, to notify the
   drawer when the module store changes.
5. Add a mocked smoke that proves the module can render, switch, clear or act,
   and survive drawer open/close transitions.

Example shape:

```ts
const notesModule = createNotesModule({
  panel: notesPanelEl,
  list: notesListEl,
  empty: notesEmptyEl,
  onSelect: () => { activePanel = 'notes'; },
});

drawerHost = createRightDrawerHost({
  drawerId: 'pin-drawer',
  titleEl,
  clearButton,
  defaultModuleId: activePanel,
  modules: [
    createActivityModule({ ...activityDom, onSelect: () => { activePanel = 'activity'; } }),
    createPinsModule({ ...pinsDom, onSelect: () => { activePanel = 'pins'; } }),
    notesModule,
  ],
  bodyClass: 'pin-drawer-open',
  prefKey: 'parley.pin-drawer.expanded',
});
```

## Boundaries

This API is intentionally internal for now. It assumes DOM panels and rail
buttons already exist in `index.html`, and it does not yet expose a lazy-load
or manifest system for user-installed extensions.

The pragmatic path toward user plugins is:

1. Keep adding first-party modules through this contract.
2. Stabilize the module manifest, lifecycle, and permissions model once a few
   modules exist.
3. Expose a constrained user-plugin surface for modules such as markdown notes,
   artifacts, or custom canvases.
