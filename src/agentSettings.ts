/**
 * @fileoverview Agent-declared settings panel — generic renderer for
 * the optional /v1/settings/* contract documented in
 * docs/ABSTRACT_AGENT_PROTOCOL.md.
 *
 * The agent declares a SettingDef[] (model, persona, temperature, ...);
 * we render each to a settings-panel row by `type`. Updates POST back
 * to /api/parley/settings/{id} via the backend adapter; the response
 * (the updated def) replaces the local copy. On error, we revert the
 * input to the previous value so a rejection is visible.
 *
 * Parley-owned settings (theme, hotkeys, mic, TTS) stay in their
 * original groups; this module only renders rows the agent declares.
 *
 * Refresh policy: load() on settings-panel open AND close — the panel
 * is the only UI surface that mutates these, so re-fetching on close
 * surfaces drift caused by parallel clients (CLI, another PWA tab,
 * a sibling agent) without a live SSE channel.
 */

import * as backend from './backend.ts';

export interface AgentSettingOption {
  value: string;
  label: string;
  description?: string;
  /** Optional grouping label. When ANY option in an enum has a group,
   *  the renderer emits `<optgroup>` blocks; ungrouped options fall
   *  into a default "Other" group at the end. Backend-controlled — the
   *  agent decides whether to group. Today: model picker uses this to
   *  cluster by provider (OpenRouter, OpenAI Codex, GitHub Copilot,
   *  Anthropic). */
  group?: string;
}

export interface AgentSettingDef {
  id: string;
  label: string;
  description?: string;
  category?: string;
  /** Optional sub-heading within a category's section, e.g. hermes'
   *  `runtime_profile` declares category "Agent", group "Runtime" so it
   *  renders under a small "Runtime" sub-label instead of loose among
   *  the top-level Agent rows (docs/LOCAL_MODE.md §1). Purely cosmetic
   *  grouping — unlike `category`, an unrecognized `group` never hides
   *  the row, it just renders without a heading. */
  group?: string;
  type: 'enum' | 'slider' | 'toggle' | 'text' | 'string-list';
  value: string | number | boolean | string[];
  options?: AgentSettingOption[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** When true, render a value line (label + current value, muted,
   *  selectable — same treatment as Cron/Health card text) instead of
   *  an input, for ANY `type`. Never POSTed back. Protocol addition:
   *  docs/ABSTRACT_AGENT_PROTOCOL.md "Optional settings extension".
   *  hermes' Memory section uses this for `memory_llm` /
   *  `memory_embeddings` / `memory_status` — values that follow the
   *  active runtime profile and aren't independently editable here
   *  (docs/LOCAL_MODE.md §3). */
  readonly?: boolean;
}

let lastSchema: AgentSettingDef[] = [];

/** Strip rows (and group-sub-headings) we previously injected. Match by
 *  data-agent-setting / data-agent-setting-group attrs so we never touch
 *  hand-authored markup or the static placeholder (which uses
 *  data-agent-setting-placeholder — kept visible until a SUCCESSFUL
 *  schema response arrives). */
function clearInjectedRows(host: HTMLElement) {
  for (const el of Array.from(host.querySelectorAll('[data-agent-setting], [data-agent-setting-group]'))) {
    el.remove();
  }
}

/** Remove the static `<div data-agent-setting-placeholder>` markup
 *  that ships in index.html. Only called on a successful schema
 *  response — null/error responses leave the placeholder visible so
 *  the user sees "Loading…" instead of an empty group (a transient
 *  upstream outage shouldn't make the picker silently disappear). */
function clearPlaceholderRows(host: HTMLElement) {
  for (const el of Array.from(host.querySelectorAll('[data-agent-setting-placeholder]'))) {
    el.remove();
  }
}

/** Render a readonly SettingDef's `value` as display text, one branch
 *  per `type` so every existing widget kind degrades to a value line
 *  the same way it would render its input (enum → the matching
 *  option's label, not the raw id; toggle → On/Off; string-list →
 *  comma-joined). Falls through to String(value) for slider/text and
 *  as the default for any future type. */
function formatReadonlyValue(def: AgentSettingDef): string {
  switch (def.type) {
    case 'toggle':
      return def.value ? 'On' : 'Off';
    case 'enum': {
      const opt = (def.options ?? []).find((o) => o.value === def.value);
      return opt ? opt.label : String(def.value ?? '');
    }
    case 'string-list': {
      const list = Array.isArray(def.value) ? def.value as string[] : [];
      return list.length ? list.join(', ') : '(none)';
    }
    case 'slider':
    case 'text':
    default:
      return String(def.value ?? '');
  }
}

/** Render one SettingDef into a `.row` element. Returns null when the
 *  type is unknown so the caller can skip silently — forks may declare
 *  new types we don't render here (no harm done; they just don't show). */
function renderRow(def: AgentSettingDef): HTMLElement | null {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.agentSetting = def.id;

  const label = document.createElement('label');
  label.textContent = def.label;
  row.appendChild(label);

  if (def.readonly) {
    // Value line, never an input: whatever `type` says, we only ever
    // need a display string here (formatReadonlyValue covers all five).
    // No htmlFor — a <span> isn't labelable and there's nothing to
    // focus. `agent-setting-value` + `cron-job-meta` for the exact
    // muted/mono treatment the Cron and Health cards already use for
    // "here's a fact, not a control" text.
    const val = document.createElement('span');
    val.className = 'agent-setting-value cron-job-meta';
    val.dataset.agentSettingValue = def.id;
    val.textContent = formatReadonlyValue(def);
    row.appendChild(val);
    if (def.description) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = def.description;
      row.appendChild(hint);
    }
    return row;
  }

  label.htmlFor = `agent-set-${def.id}`;
  let input: HTMLElement | null = null;

  switch (def.type) {
    case 'enum': {
      const sel = document.createElement('select');
      sel.id = `agent-set-${def.id}`;
      const opts = def.options ?? [];
      // If ANY option carries a group, render as <optgroup> blocks so
      // visually-similar IDs (e.g. `gpt-5.4 (Codex)` vs `gpt-5.4 (Copilot)`
      // vs `openai/gpt-5.4-nano` from OpenRouter) cluster by provider.
      // Group iteration order = first-appearance in the options list,
      // so the backend controls ordering. Ungrouped options fall into
      // a final "Other" optgroup.
      const anyGrouped = opts.some(o => !!o.group);
      if (anyGrouped) {
        const byGroup = new Map<string, AgentSettingOption[]>();
        for (const opt of opts) {
          const g = opt.group || 'Other';
          let bucket = byGroup.get(g);
          if (!bucket) { bucket = []; byGroup.set(g, bucket); }
          bucket.push(opt);
        }
        for (const [groupName, groupOpts] of byGroup) {
          const og = document.createElement('optgroup');
          og.label = groupName;
          for (const opt of groupOpts) {
            const o = document.createElement('option');
            o.value = String(opt.value);
            o.textContent = opt.label;
            if (opt.description) o.title = opt.description;
            og.appendChild(o);
          }
          sel.appendChild(og);
        }
      } else {
        for (const opt of opts) {
          const o = document.createElement('option');
          o.value = String(opt.value);
          o.textContent = opt.label;
          if (opt.description) o.title = opt.description;
          sel.appendChild(o);
        }
      }
      sel.value = String(def.value ?? '');
      sel.onchange = () => onSubmit(def, sel.value, sel);
      input = sel;
      break;
    }
    case 'toggle': {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `agent-set-${def.id}`;
      cb.checked = !!def.value;
      cb.onchange = () => onSubmit(def, cb.checked, cb);
      input = cb;
      break;
    }
    case 'slider': {
      const wrap = document.createElement('div');
      wrap.style.display = 'contents';
      const range = document.createElement('input');
      range.type = 'range';
      range.id = `agent-set-${def.id}`;
      range.min = String(def.min ?? 0);
      range.max = String(def.max ?? 100);
      range.step = String(def.step ?? 1);
      range.value = String(def.value ?? def.min ?? 0);
      const valSpan = document.createElement('span');
      valSpan.className = 'val';
      valSpan.textContent = String(range.value);
      range.oninput = () => { valSpan.textContent = range.value; };
      // Commit on `change` (release), not `input` — slider drag would
      // POST per-frame otherwise. Each release = one POST.
      range.onchange = () => onSubmit(def, Number(range.value), range);
      wrap.appendChild(range);
      wrap.appendChild(valSpan);
      input = wrap;
      break;
    }
    case 'text': {
      const txt = document.createElement('input');
      txt.type = 'text';
      txt.id = `agent-set-${def.id}`;
      txt.value = String(def.value ?? '');
      if (def.placeholder) txt.placeholder = def.placeholder;
      // Commit on blur or Enter — typing every keystroke would POST
      // per-character.
      const commit = () => onSubmit(def, txt.value, txt);
      txt.onblur = commit;
      txt.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); txt.blur(); } };
      input = txt;
      break;
    }
    case 'string-list': {
      // Chip-list editor: each entry renders as a removable chip;
      // Enter or comma in the input commits a new entry. POSTs the
      // entire updated list to the agent on each add/remove (full
      // replacement; the contract doesn't have a partial-update
      // shape and the lists are small enough to round-trip whole).
      // Returns a `display: contents` wrapper so the chips + input
      // share row layout with the label.
      row.classList.add('row-wide');
      const wrap = document.createElement('div');
      wrap.style.display = 'contents';
      const chips = document.createElement('div');
      chips.className = 'keyterms-chips';
      chips.setAttribute('aria-label', def.label);
      const txt = document.createElement('input');
      txt.type = 'text';
      txt.id = `agent-set-${def.id}`;
      txt.autocomplete = 'off';
      txt.spellcheck = false;
      if (def.placeholder) txt.placeholder = def.placeholder;
      const renderChips = () => {
        chips.innerHTML = '';
        const list = Array.isArray(def.value) ? def.value as string[] : [];
        for (const term of list) {
          const chip = document.createElement('span');
          chip.className = 'kt-chip';
          chip.textContent = term;
          const x = document.createElement('button');
          x.className = 'kt-chip-x';
          x.type = 'button';
          x.setAttribute('aria-label', `remove ${term}`);
          x.textContent = '×';
          x.onclick = () => {
            const next = (def.value as string[]).filter((t) => t !== term);
            void onSubmit(def, next, chips, renderChips);
          };
          chip.appendChild(x);
          chips.appendChild(chip);
        }
      };
      renderChips();
      txt.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          const term = txt.value.trim();
          if (!term) return;
          const list = Array.isArray(def.value) ? def.value as string[] : [];
          if (list.includes(term)) { txt.value = ''; return; }
          const next = [...list, term];
          txt.value = '';
          void onSubmit(def, next, chips, renderChips);
        }
      };
      wrap.appendChild(chips);
      wrap.appendChild(txt);
      input = wrap;
      break;
    }
    default:
      return null;
  }

  row.appendChild(input);

  if (def.description) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = def.description;
    row.appendChild(hint);
  }
  return row;
}

/** POST the new value to the agent. Optimistic — the caller already
 *  updated the input by user action — so on error we revert via the
 *  inputEl's display refresh, and surface the agent's message via
 *  window.alert (settings-panel-only; drives users back to a valid
 *  value). For chip-list rows, the caller passes a `refresh` callback
 *  that re-renders the chip strip (since the chips container isn't
 *  a primitive input syncInputToValue can drive). */
async function onSubmit(
  def: AgentSettingDef,
  value: unknown,
  inputEl: HTMLElement,
  refresh?: () => void,
) {
  const prev = def.value;
  // Re-resolve def by id from the LIVE lastSchema before mutating, in
  // case a concurrent load() (e.g. settings.ts:openPanel) ran between
  // when the row's onchange handler captured this `def` and now. If
  // load() replaced lastSchema with fresh defs parsed from the server,
  // our closure-captured `def` is orphaned — Object.assign'ing it would
  // mutate dead state, and getCurrentValue (which reads lastSchema)
  // would keep returning the pre-change value forever. Pre-fix repro:
  // `composer-attach-vision-gate` smoke had to wait 1500ms for the
  // openPanel reload to settle before driving the select; without the
  // wait, the user's change vanished into an orphaned def.
  const live = lastSchema.find((d) => d.id === def.id);
  if (live && live !== def) def = live;
  try {
    const adapter: any = (backend as any).adapter ?? await getAdapter();
    if (!adapter?.updateSetting) {
      throw new Error('agent settings not supported by this backend');
    }
    const updated: AgentSettingDef = await adapter.updateSetting(def.id, value);
    // Replace our cached copy with the agent's response (lets the
    // agent normalize — e.g. trim whitespace, lower-case, snap-to-step).
    // Resolve `def` AGAIN — load() may have run during the awaited POST
    // too, replacing lastSchema once more. We want to mutate whatever
    // is live in lastSchema NOW, not the snapshot we took before await.
    const liveAfter = lastSchema.find((d) => d.id === def.id);
    if (liveAfter && liveAfter !== def) def = liveAfter;
    Object.assign(def, updated);
    // Re-sync the input in case the agent normalized.
    syncInputToValue(inputEl, def);
    refresh?.();
    // Notify subscribers (composer attach-button gate) that a setting
    // changed — they can re-read getCurrentValue() and react. Same
    // event for every setting; listeners that only care about specific
    // ids filter via the detail.id field.
    try {
      window.dispatchEvent(new CustomEvent('agent-setting-changed', {
        detail: { id: def.id, value: def.value },
      }));
    } catch { /* SSR-safe */ }
  } catch (e: any) {
    // Revert. Re-resolve once more in case lastSchema changed during
    // the failed await.
    const liveErr = lastSchema.find((d) => d.id === def.id) ?? def;
    syncInputToValue(inputEl, { ...liveErr, value: prev });
    // For chip-list, restore the previous list before re-rendering.
    if (refresh) {
      liveErr.value = prev;
      refresh();
    }
    // Surface the agent's rejection message — this only fires from
    // settings-panel interactions so window.alert is acceptable; a
    // toast would be nicer when the toast util lands.
    try { window.alert(`Couldn't update ${liveErr.label}: ${e?.message ?? e}`); } catch {}
  }
}

function syncInputToValue(inputEl: HTMLElement, def: AgentSettingDef) {
  if (inputEl instanceof HTMLSelectElement) inputEl.value = String(def.value ?? '');
  else if (inputEl instanceof HTMLInputElement) {
    if (inputEl.type === 'checkbox') inputEl.checked = !!def.value;
    else inputEl.value = String(def.value ?? '');
  }
  // string-list rows pass a non-input wrapper as inputEl; the
  // refresh() callback in onSubmit owns their re-render.
}

/** Fetch the adapter via backend.ts internals. backend.ts proxies most
 *  methods but doesn't yet expose getSettingsSchema/updateSetting; this
 *  reaches the live adapter so we don't need to add a wrapper for each. */
async function getAdapter(): Promise<any> {
  // backend.ts's loadAdapter returns the configured adapter. We import
  // the proxy-client directly because that's the only adapter wired in
  // post-refactor.
  const mod: any = await import('./proxyClient.ts');
  return mod.proxyClientAdapter;
}

/** Map an agent-declared `category` string to a settings-section data-section
 *  key (matches the `<div class="settings-group" data-section="...">` in
 *  index.html). Unknown categories fall back to the Agent section so a
 *  forked plugin that emits a novel category still surfaces SOMETHING
 *  rather than silently dropping rows.
 *
 *  Hermes plugin emits "Agent" / "Plugins" / "Session" today; all three
 *  are agent-internal concerns and slot into the Agent section. If a
 *  future category genuinely belongs in Voice input (e.g. an STT-related
 *  agent setting), add the mapping here.
 *
 *  "Memory" (docs/LOCAL_MODE.md §3) gets its own section rather than
 *  folding into Agent — it's "what hindsight is doing and with what",
 *  a different question than "how does the model behave", and the
 *  fields are almost all readonly status lines rather than knobs. */
function categoryToSection(category: string | undefined): string {
  if (!category) return 'agent';
  switch (category.toLowerCase()) {
    case 'agent':
    case 'plugins':
    case 'session':
      return 'agent';
    case 'memory': return 'memory';
    case 'voice input':
    case 'voice-input': return 'voice-input';
    case 'voice output':
    case 'voice-output': return 'voice-output';
    case 'voice phrases':
    case 'voice-phrases': return 'voice-phrases';
    case 'interaction': return 'interaction';
    case 'display': return 'display';
    default: return 'agent';
  }
}

/** Render agent-declared rows into the matching settings section by
 *  category. Idempotent — re-runs replace previously-injected rows. */
export async function load() {
  // The Agent section host is required (it carries the loading
  // placeholder + is the fallback for unknown categories).
  const agentHost = document.getElementById('settings-group-agent');
  if (!agentHost) return;
  const adapter: any = await getAdapter();
  if (!adapter?.getSettingsSchema) {
    // Adapter doesn't implement the extension — leave placeholder +
    // hand-authored rows untouched.
    return;
  }
  let schema: AgentSettingDef[] | null;
  try {
    schema = await adapter.getSettingsSchema();
  } catch {
    // Treat fetch errors as "leave-as-is" so a transient outage doesn't
    // strip a previously-rendered picker. Next panel-open retries.
    return;
  }
  if (schema === null) {
    // Agent doesn't implement /v1/settings/* (404). Leave placeholder
    // + previously-injected rows alone — same rationale as the error
    // case. If the user wants to see "no settings" we'd need a
    // dedicated empty-state row; not worth the complexity yet.
    return;
  }
  // Successful response → drop placeholder + previously-injected rows
  // from EVERY section host (rows could have been routed anywhere on a
  // prior load), then render fresh.
  clearPlaceholderRows(agentHost);
  const allHosts = document.querySelectorAll<HTMLElement>('.settings-group[data-section]');
  for (const host of Array.from(allHosts)) clearInjectedRows(host);
  // Resolve target host per row by category up front — needed even for
  // an empty schema so the Memory empty-state toggle below has a host
  // to act on.
  const hostBySection = new Map<string, HTMLElement>();
  for (const host of Array.from(allHosts)) {
    const s = host.dataset.section;
    if (s) hostBySection.set(s, host);
  }
  if (schema.length === 0) {
    lastSchema = [];
    updateMemoryEmptyState(hostBySection.get('memory'));
    return;
  }
  lastSchema = schema;
  // Insertion cursor per host: the node the NEXT row for that host should
  // land after. Starts at the section's `.group-label` (rows go right
  // below the heading) and advances to each row/heading as it's placed,
  // so multi-row sections render in schema order. (A prior version
  // re-anchored to `.group-label` on every iteration, which inserted
  // each new row immediately after the label — i.e. BEFORE whatever
  // had just been inserted — silently reversing the order of any
  // section with more than one row. Harmless while every section only
  // ever carried "model", but `group` sub-headings need real ordering
  // to mean anything.)
  const cursorByHost = new Map<HTMLElement, HTMLElement>();
  // Last `group` rendered per host, so we only emit a sub-heading on
  // the first row of each named group (consecutive same-group rows in
  // the schema share one heading; the agent controls this by keeping
  // grouped settings adjacent, same convention as `category`).
  const lastGroupByHost = new Map<HTMLElement, string | undefined>();
  const insertAfterCursor = (host: HTMLElement, node: HTMLElement) => {
    const cursor = cursorByHost.get(host) ?? (host.querySelector('.group-label') as HTMLElement | null);
    if (cursor && cursor.parentElement === host) cursor.after(node);
    else host.appendChild(node);
    cursorByHost.set(host, node);
  };
  for (const def of schema) {
    const sectionKey = categoryToSection(def.category);
    const host = hostBySection.get(sectionKey) || agentHost;
    if (def.group !== lastGroupByHost.get(host)) {
      lastGroupByHost.set(host, def.group);
      if (def.group) {
        const heading = document.createElement('div');
        heading.className = 'agent-setting-group-heading';
        heading.dataset.agentSettingGroup = def.group;
        heading.textContent = def.group;
        insertAfterCursor(host, heading);
      }
    }
    const row = renderRow(def);
    if (!row) continue;
    insertAfterCursor(host, row);
  }
  // Memory is the one section whose absence needs to say something
  // (Cron/Health have their own "not supported" 404 path via a
  // dedicated endpoint; Memory rides the shared settings schema, so
  // "zero Memory-category rows" is the only signal we get — could mean
  // the plugin doesn't build the section yet, or the user disabled
  // memory upstream entirely).
  updateMemoryEmptyState(hostBySection.get('memory'));
  // Notify subscribers (composer attach-button gate, etc.) that the
  // agent settings schema is now populated. Fired once per successful
  // load — listeners read getCurrentValue() to react.
  try {
    window.dispatchEvent(new CustomEvent('agent-schema-loaded'));
  } catch { /* SSR-safe */ }
}

/** Toggle the Memory section's static empty-state row (index.html,
 *  `[data-memory-empty]`) based on whether any Memory-category rows
 *  actually landed in the host this load(). Called both when the whole
 *  schema is empty and after a normal render, so re-declaring (or
 *  fully removing) Memory settings on a later load flips it back. */
function updateMemoryEmptyState(memoryHost: HTMLElement | undefined) {
  if (!memoryHost) return;
  const emptyEl = memoryHost.querySelector<HTMLElement>('[data-memory-empty]');
  if (!emptyEl) return;
  const hasRows = memoryHost.querySelectorAll('[data-agent-setting]').length > 0;
  emptyEl.hidden = hasRows;
  // `.row` is display:flex, which beats the `hidden` attribute alone —
  // same fix cronSettings.ts/healthSettings.ts already apply to their
  // placeholders.
  emptyEl.style.display = hasRows ? 'none' : '';
}

/** Read the most recently-loaded value for an agent setting. Returns
 *  undefined if no schema has loaded or the setting id isn't declared
 *  by this agent. Used by the composer to gate the image-upload UI on
 *  the selected model's vision capability. */
export function getCurrentValue(settingId: string): unknown {
  const def = lastSchema.find((d) => d.id === settingId);
  return def?.value;
}
