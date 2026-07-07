/**
 * First-run setup wizard — the "model gate" (FTUE research 2026-07-07,
 * Agent Zero pattern). Engages ONLY when the backend reports
 * needsSetup=true (in-tree stub still on its echo LLM — a fresh
 * `npx sidekick-portal` trial). Real deployments never see it.
 *
 * Three provider paths, then an optional voice step:
 *   Cloud key  — any OpenAI-compatible API (OpenRouter default).
 *   Local      — Ollama, auto-detected with its installed models.
 *   My agent   — point at any /v1/responses server (restart to apply).
 *
 * Gate semantics: sending a message while unconfigured does NOT error —
 * main.ts calls gateIfNeeded() first; we open the wizard and the text
 * stays in the composer, ready to send once a brain is connected.
 *
 * DOM is built here (not index.html) so the whole feature lives in one
 * module — same pattern as transcriptHighlight's hint chip.
 */
import { diag } from './util/log.ts';

type SetupStatus = {
  needsSetup: boolean;
  upstream: { ok: boolean; kind: 'stub' | 'custom'; llm: string | null };
  ollama: { detected: boolean; models: string[] };
  voice: { configured: boolean };
};

let status: SetupStatus | null = null;
let overlay: HTMLElement | null = null;
let noteEl: HTMLElement | null = null;
let completedThisSession = false;

/** True while the trial stub is unconfigured — the composer holds sends. */
export function needsSetup(): boolean {
  return !!status?.needsSetup && !completedThisSession;
}

/** Composer hook: returns true when the send should be HELD (wizard
 *  opens; text stays in the composer). False = proceed normally. */
export function gateIfNeeded(): boolean {
  if (!needsSetup()) return false;
  open('Connect a brain first — your message is kept in the box below.');
  return true;
}

/** Fetch status; auto-open on a fresh trial. Fail-open: any error means
 *  no gate (a broken status probe must never lock a working install). */
export async function init(): Promise<void> {
  try {
    const r = await fetch('/api/sidekick/setup/status');
    if (!r.ok) return;
    status = await r.json();
  } catch { return; }
  if (status?.needsSetup) {
    diag('[setup] trial stub on echo LLM — offering first-run wizard');
    open();
  }
}

// ── UI ───────────────────────────────────────────────────────────────

function open(note?: string): void {
  if (!overlay) {
    overlay = buildOverlay();
    document.body.appendChild(overlay);
  }
  if (noteEl) {
    noteEl.textContent = note ?? '';
    noteEl.hidden = !note;
  }
  overlay.hidden = false;
}

function close(): void {
  if (overlay) overlay.hidden = true;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function buildOverlay(): HTMLElement {
  const wrap = el('div', 'setup-wizard-overlay');
  const card = el('div', 'setup-wizard-card');
  wrap.appendChild(card);

  // Casual dismiss (backdrop click / Escape): hide the overlay but keep
  // the gate ARMED — the next send re-opens it with the held-message
  // note (the Agent Zero re-trigger semantic). The explicit skip button
  // below is the opt-out that actually lets echo-demo sends through.
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.hidden) close();
  });

  const h = el('h2', 'setup-wizard-title', 'Welcome to Sidekick');
  card.appendChild(h);
  card.appendChild(el('p', 'setup-wizard-sub',
    'You’re chatting with a demo echo agent. Connect a real brain — it takes under a minute.'));
  noteEl = el('p', 'setup-wizard-note');
  noteEl.hidden = true;
  card.appendChild(noteEl);

  const paths = el('div', 'setup-wizard-paths');
  card.appendChild(paths);

  const body = el('div', 'setup-wizard-body');
  card.appendChild(body);

  const footer = el('div', 'setup-wizard-footer');
  const skip = el('button', 'setup-wizard-skip', 'Keep the echo demo for now');
  skip.onclick = () => { completedThisSession = true; close(); };
  footer.appendChild(skip);
  card.appendChild(footer);

  const mkPath = (label: string, desc: string, render: (host: HTMLElement) => void) => {
    const b = el('button', 'setup-wizard-path');
    b.appendChild(el('span', 'setup-wizard-path-label', label));
    b.appendChild(el('span', 'setup-wizard-path-desc', desc));
    b.onclick = () => {
      paths.querySelectorAll('.setup-wizard-path').forEach(p => p.classList.remove('active'));
      b.classList.add('active');
      body.innerHTML = '';
      render(body);
    };
    paths.appendChild(b);
    return b;
  };

  mkPath('Cloud key', 'Paste one API key — OpenRouter, OpenAI, Groq, …', renderCloud);
  const ollamaBtn = mkPath(
    status?.ollama.detected ? 'Local Ollama ✓ detected' : 'Local Ollama',
    status?.ollama.detected
      ? `${status.ollama.models.length} model(s) installed — no key needed`
      : 'Run models locally — no key, no cloud',
    renderOllama,
  );
  mkPath('My own agent', 'Point at any /v1/responses-speaking server', renderCustom);

  // Ollama detected → preselect it (the zero-key happy path).
  if (status?.ollama.detected) ollamaBtn.click();

  return wrap;
}

function field(host: HTMLElement, label: string, input: HTMLElement): void {
  const row = el('label', 'setup-wizard-field');
  row.appendChild(el('span', 'setup-wizard-field-label', label));
  row.appendChild(input);
  host.appendChild(row);
}

function textInput(placeholder: string, value = ''): HTMLInputElement {
  const i = el('input', 'setup-wizard-input');
  i.type = 'text';
  i.placeholder = placeholder;
  i.value = value;
  i.autocomplete = 'off';
  i.spellcheck = false;
  return i;
}

function applyButton(label: string, run: (btn: HTMLButtonElement, out: HTMLElement) => Promise<void>): HTMLElement {
  const wrap = el('div', 'setup-wizard-apply-row');
  const btn = el('button', 'setup-wizard-apply', label);
  const out = el('span', 'setup-wizard-result');
  btn.onclick = async () => {
    btn.disabled = true;
    out.textContent = 'Connecting…';
    out.className = 'setup-wizard-result';
    try { await run(btn, out); }
    catch (e: any) {
      out.textContent = e?.message || 'failed';
      out.classList.add('err');
    }
    btn.disabled = false;
  };
  wrap.appendChild(btn);
  wrap.appendChild(out);
  return wrap;
}

async function apply(bodyJson: Record<string, unknown>): Promise<{ llm: string | null; restartRequired: boolean }> {
  const r = await fetch('/api/sidekick/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bodyJson),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return { llm: data?.llm ?? null, restartRequired: !!data?.restartRequired };
}

function succeed(out: HTMLElement, llm: string | null): void {
  completedThisSession = true;
  if (status) status.needsSetup = false;
  out.textContent = llm ? `Connected — ${llm}` : 'Saved';
  out.classList.add('ok');
  renderVoiceStep();
}

function renderCloud(host: HTMLElement): void {
  host.appendChild(el('p', 'setup-wizard-hint',
    'Default is OpenRouter — one key, every major model. Any OpenAI-compatible endpoint works.'));
  const link = el('a', 'setup-wizard-link', 'Get an OpenRouter key ↗');
  (link as HTMLAnchorElement).href = 'https://openrouter.ai/keys';
  (link as HTMLAnchorElement).target = '_blank';
  host.appendChild(link);
  const key = textInput('sk-or-…  (API key)');
  const base = textInput('https://openrouter.ai/api/v1 (base URL, optional)');
  const model = textInput('openrouter/auto (model, optional)');
  field(host, 'API key', key);
  field(host, 'Base URL', base);
  field(host, 'Model', model);
  host.appendChild(applyButton('Connect', async (_b, out) => {
    const { llm } = await apply({
      path: 'cloud', apiKey: key.value.trim(),
      baseUrl: base.value.trim(), model: model.value.trim(),
    });
    succeed(out, llm);
  }));
}

function renderOllama(host: HTMLElement): void {
  if (!status?.ollama.detected) {
    host.appendChild(el('p', 'setup-wizard-hint',
      'No Ollama detected on 127.0.0.1:11434. Install from ollama.com, `ollama pull llama3.2`, then reopen this wizard.'));
  }
  const models = status?.ollama.models ?? [];
  let modelInput: HTMLInputElement | HTMLSelectElement;
  if (models.length) {
    const sel = el('select', 'setup-wizard-input') as HTMLSelectElement;
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      sel.appendChild(o);
    }
    modelInput = sel;
  } else {
    modelInput = textInput('llama3.2');
  }
  const base = textInput('http://127.0.0.1:11434');
  field(host, 'Model', modelInput);
  field(host, 'Ollama URL', base);
  host.appendChild(applyButton('Use local model', async (_b, out) => {
    const { llm } = await apply({
      path: 'ollama',
      model: (modelInput as HTMLInputElement).value.trim(),
      baseUrl: base.value.trim(),
    });
    succeed(out, llm);
  }));
}

function renderCustom(host: HTMLElement): void {
  host.appendChild(el('p', 'setup-wizard-hint',
    'Any server speaking the OpenAI Responses API (/v1/responses + /v1/conversations). Applies on next restart. Wiring your own agent? Open this repo in an AI coding assistant and see AGENTS.md.'));
  const url = textInput('http://127.0.0.1:8645');
  const token = textInput('bearer token (optional)');
  field(host, 'Agent URL', url);
  field(host, 'Token', token);
  host.appendChild(applyButton('Save', async (_b, out) => {
    await apply({ path: 'custom', platformUrl: url.value.trim(), platformToken: token.value.trim() });
    out.textContent = 'Saved — restart Sidekick to connect';
    out.classList.add('ok');
    completedThisSession = true;
    if (status) status.needsSetup = false;
  }));
}

function renderVoiceStep(): void {
  if (!overlay) return;
  const body = overlay.querySelector('.setup-wizard-body') as HTMLElement | null;
  const paths = overlay.querySelector('.setup-wizard-paths') as HTMLElement | null;
  if (!body) return;
  if (paths) paths.hidden = true;
  if (status?.voice.configured) { finishPanel(body); return; }

  body.innerHTML = '';
  body.appendChild(el('h3', 'setup-wizard-step-title', 'Optional: give it a voice'));
  body.appendChild(el('p', 'setup-wizard-hint',
    'Voice replies (TTS) work immediately with a Deepgram key — free tier includes $200 of credit. Mic input additionally needs the audio bridge (see README).'));
  const link = el('a', 'setup-wizard-link', 'Get a free Deepgram key ↗');
  (link as HTMLAnchorElement).href = 'https://console.deepgram.com/signup';
  (link as HTMLAnchorElement).target = '_blank';
  body.appendChild(link);
  const key = textInput('Deepgram API key');
  field(body, 'API key', key);
  body.appendChild(applyButton('Enable voice', async (_b, out) => {
    await apply({ path: 'voice', deepgramKey: key.value.trim() });
    if (status) status.voice.configured = true;
    out.textContent = 'Voice enabled';
    out.classList.add('ok');
    // Audible proof — same call the per-bubble play button makes.
    try {
      const r = await fetch('/tts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Sidekick voice is ready.' }),
      });
      if (r.ok) {
        const blob = await r.blob();
        void new Audio(URL.createObjectURL(blob)).play().catch(() => {});
      }
    } catch { /* test is best-effort */ }
    finishPanel(body);
  }));
  const skipVoice = el('button', 'setup-wizard-skip', 'Skip voice for now');
  skipVoice.onclick = () => finishPanel(body);
  body.appendChild(skipVoice);
}

function finishPanel(body: HTMLElement): void {
  body.innerHTML = '';
  body.appendChild(el('h3', 'setup-wizard-step-title', 'You’re set 🎉'));
  body.appendChild(el('p', 'setup-wizard-hint',
    'Say something in the composer below. Settings → Agent lets you change any of this later.'));
  const done = el('button', 'setup-wizard-apply', 'Start chatting');
  done.onclick = () => close();
  body.appendChild(done);
}
