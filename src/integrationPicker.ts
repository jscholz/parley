/**
 * @fileoverview "Add integration" picker (Settings › Integrations, phase 2):
 * the agent's catalog of addable integrations, a search box, and — for
 * entries that need credentials — a small write-only form. Resolves with
 * what to add, or null. Same overlay pattern as confirmDialog.ts (Escape
 * and backdrop cancel; nothing destructive, so default focus is the search).
 */
import type { CatalogEntry } from './healthModel.ts';

export interface CustomSpec { name: string; label: string; description?: string; status_command?: string; timeout_s?: number; setup_markdown?: string; docs?: string }
export interface PickResult { entry?: CatalogEntry; env: Record<string, string>; custom?: CustomSpec }

const CUSTOM_FIELDS: Array<{ id: keyof CustomSpec; label: string; hint?: string; required?: boolean; multiline?: boolean }> = [
  { id: 'name', label: 'Short name (a-z, 0-9, -)', hint: 'e.g. linkedin-harness', required: true },
  { id: 'label', label: 'Display name', hint: 'e.g. LinkedIn (Playwright harness)', required: true },
  { id: 'description', label: 'What it is' },
  { id: 'status_command', label: 'Status command (exit 0 OK, 1 warn, 2 fail; stdout = report)', hint: '~/code/li-harness/bin/status' },
  { id: 'setup_markdown', label: 'Setup notes (markdown)', multiline: true },
  { id: 'docs', label: 'Docs URL' },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function pickIntegration(entries: CatalogEntry[]): Promise<PickResult | null> {
  return new Promise((resolve) => {
    document.querySelector('.sk-confirm-overlay')?.remove();
    const overlay = el('div', 'sk-confirm-overlay int-picker-overlay');
    const box = el('div', 'sk-confirm int-picker');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Add integration');
    box.appendChild(el('div', 'sk-confirm-title', 'Add integration'));
    const search = el('input', 'int-picker-search');
    search.type = 'search'; search.placeholder = 'Search the catalog…'; search.setAttribute('aria-label', 'Search integrations');
    box.appendChild(search);
    const list = el('div', 'int-picker-list');
    list.setAttribute('role', 'listbox');
    box.appendChild(list);
    const form = el('div', 'int-picker-form'); form.hidden = true;
    box.appendChild(form);
    const actions = el('div', 'sk-confirm-actions');
    const cancel = el('button', 'sk-confirm-cancel', 'Cancel'); cancel.type = 'button';
    const add = el('button', 'sk-confirm-accept', 'Add'); add.type = 'button'; add.disabled = true; add.dataset.role = 'add';
    actions.append(cancel, add);
    box.appendChild(actions);
    overlay.appendChild(box);

    let chosen: CatalogEntry | null = null;
    let customMode = false;
    const inputs = new Map<string, HTMLInputElement>();
    const customInputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();

    const renderCustomForm = () => {
      form.innerHTML = ''; inputs.clear(); customInputs.clear();
      form.hidden = false;
      form.appendChild(el('div', 'hint', 'Register something you built yourself. It shows up here with a Test button; the agent keeps it in ~/.hermes/integrations/<name>.yaml.'));
      for (const f of CUSTOM_FIELDS) {
        const row = el('label', 'int-picker-field');
        row.append(el('span', '', f.label));
        const inp = f.multiline ? el('textarea') : el('input');
        if (inp instanceof HTMLInputElement) { inp.type = 'text'; inp.autocomplete = 'off'; }
        inp.spellcheck = false; inp.dataset.field = String(f.id);
        if (f.hint) inp.placeholder = f.hint;
        inp.addEventListener('input', updateAdd);
        row.appendChild(inp);
        customInputs.set(String(f.id), inp);
        form.appendChild(row);
      }
      add.textContent = 'Register';
      updateAdd();
      customInputs.get('name')?.focus();
    };

    const renderForm = () => {
      if (customMode) { renderCustomForm(); return; }
      form.innerHTML = ''; inputs.clear(); customInputs.clear();
      add.textContent = 'Add';
      if (!chosen) { form.hidden = true; add.disabled = true; return; }
      form.hidden = false;
      const head = el('div', 'int-picker-chosen');
      head.append(el('strong', '', chosen.name), document.createTextNode(chosen.description ? ` — ${chosen.description}` : ''));
      form.appendChild(head);
      const fields = chosen.fields || [];
      if (chosen.setup === 'oauth') form.appendChild(el('div', 'hint', fields.length ? 'Enter the app credentials, then you will sign in with the provider.' : 'You will sign in with the provider in your browser after adding.'));
      for (const f of fields) {
        const row = el('label', 'int-picker-field');
        row.append(el('span', '', f.label || f.id));
        const inp = el('input');
        inp.type = f.secret === false ? 'text' : 'password';
        inp.autocomplete = 'off'; inp.spellcheck = false; inp.dataset.field = f.id;
        inp.required = f.required !== false;
        inp.addEventListener('input', updateAdd);
        row.appendChild(inp);
        inputs.set(f.id, inp);
        form.appendChild(row);
      }
      updateAdd();
      (inputs.values().next().value as HTMLInputElement | undefined)?.focus();
    };
    const updateAdd = () => {
      if (customMode) {
        const name = (customInputs.get('name')?.value || '').trim();
        const label = (customInputs.get('label')?.value || '').trim();
        add.disabled = !/^[a-z0-9_-]{1,20}$/.test(name) || !label;
        return;
      }
      if (!chosen) { add.disabled = true; return; }
      add.disabled = [...inputs.values()].some((i) => i.required && !i.value.trim());
    };
    const renderList = () => {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      // Always offered: register your own (a Playwright harness, a scraper, a local service).
      if (!q || 'custom integration'.includes(q)) {
        const row = el('button', 'int-picker-row int-picker-custom' + (customMode ? ' selected' : ''));
        row.type = 'button'; row.dataset.provider = '__custom__'; row.setAttribute('role', 'option');
        const main = el('div', 'int-picker-row-main');
        main.append(el('div', 'int-picker-row-name', 'Custom integration…'), el('div', 'int-picker-row-desc', 'Something you built: give it a name and a status command'));
        row.appendChild(main);
        row.appendChild(el('span', 'int-kind int-kind-custom', 'custom'));
        row.addEventListener('click', () => { customMode = true; chosen = null; renderList(); renderForm(); });
        list.appendChild(row);
      }
      const shown = entries.filter((e) => !q || e.name.toLowerCase().includes(q) || e.provider.toLowerCase().includes(q) || (e.description || '').toLowerCase().includes(q));
      if (shown.length === 0 && q && !'custom integration'.includes(q)) list.appendChild(el('div', 'hint', 'Nothing matches.'));
      for (const e of shown) {
        const row = el('button', 'int-picker-row' + (chosen?.provider === e.provider ? ' selected' : ''));
        row.type = 'button'; row.dataset.provider = e.provider; row.setAttribute('role', 'option');
        row.disabled = !!e.installed;
        const main = el('div', 'int-picker-row-main');
        main.append(el('div', 'int-picker-row-name', e.name + (e.installed ? ' · installed' : '')));
        if (e.description) main.appendChild(el('div', 'int-picker-row-desc', e.description));
        row.appendChild(main);
        row.appendChild(el('span', 'int-kind', e.setup === 'oauth' ? 'sign-in' : e.setup === 'api-key' ? 'api key' : 'no auth'));
        row.addEventListener('click', () => { customMode = false; chosen = e; renderList(); renderForm(); });
        list.appendChild(row);
      }
    };
    search.addEventListener('input', renderList);
    renderList();

    const done = (r: PickResult | null) => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(r); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) done(null); });
    cancel.addEventListener('click', () => done(null));
    add.addEventListener('click', () => {
      if (customMode) {
        const spec: any = {};
        for (const [k, inp] of customInputs) if (inp.value.trim()) spec[k] = inp.value.trim();
        if (!spec.name || !spec.label) return;
        done({ env: {}, custom: spec as CustomSpec });
        return;
      }
      if (!chosen) return;
      const env: Record<string, string> = {};
      for (const [k, inp] of inputs) if (inp.value.trim()) env[k] = inp.value.trim();
      done({ entry: chosen, env });
    });
    document.body.appendChild(overlay);
    search.focus();
  });
}
