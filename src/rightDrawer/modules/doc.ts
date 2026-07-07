// Docs drawer tab — the doc SHELF: a compact list of agent-pushed
// documents + a single reader (design doc: sidekick-docs-panel-ux-
// research-2026-07-07.md — "list + reader", the Claude/Gemini/Open WebUI
// consensus; never a tab strip).
//
// Views: READER (default — the active doc) and LIST (via the `‹ All
// docs (n)` header row). Tapping a list row activates it and returns to
// the reader. An agent push adds-or-replaces by path identity and
// re-activates (docStore.setDoc).
//
// The host's single shared header action button is view-dependent:
// reader → "Close" (remove active doc), list → "Clear all". Reader adds
// its own Download action (single file via Blob + <a download>).
//
// Rendering is unchanged from v1: markdown through the shared XSS-safe
// miniMarkdown (styled by the `.line .text / .pin-item-body /
// .doc-drawer-content` group in app.css), HTML in a fully sandboxed
// iframe (sandbox="" — no scripts, no same-origin; agent-pushed content
// is untrusted), everything else plain text.

import type { RightDrawerModule, RightDrawerModuleContext } from '../host.ts';
import { miniMarkdown } from '../../util/markdown.ts';
import {
  currentDoc, listDocs, docCount, selectDoc, removeDoc, clearDocs,
  type DocState,
} from '../docStore.ts';
import { formatRelativeTime } from './common.ts';

type View = 'reader' | 'list';

export function createDocModule(opts: {
  panel: HTMLElement;
  body: HTMLElement;
  empty: HTMLElement;
  onSelect?: () => void;
}): RightDrawerModule {
  let view: View = 'reader';

  const render = (ctx: RightDrawerModuleContext) => {
    const doc = currentDoc();
    if (!doc) view = 'reader';   // empty shelf → empty state, not a list

    if (ctx.clearButton) {
      ctx.clearButton.hidden = !doc;
      const label = view === 'list' ? 'Clear all' : 'Close';
      ctx.clearButton.textContent = label;
      ctx.clearButton.setAttribute('aria-label',
        view === 'list' ? 'Clear all documents' : 'Close this document');
      ctx.clearButton.setAttribute('title', label);
    }
    opts.body.innerHTML = '';
    if (!doc) {
      opts.empty.hidden = false;
      opts.body.hidden = true;
      return;
    }
    opts.empty.hidden = true;
    opts.body.hidden = false;

    if (view === 'list') renderList(ctx);
    else renderReader(ctx, doc);
  };

  const rerender = (ctx: RightDrawerModuleContext) => render(ctx);

  function renderList(ctx: RightDrawerModuleContext): void {
    const back = document.createElement('button');
    back.className = 'doc-shelf-back';
    back.textContent = '‹ Back to document';
    back.onclick = () => { view = 'reader'; rerender(ctx); };
    opts.body.appendChild(back);

    const ul = document.createElement('ul');
    ul.className = 'doc-shelf-list';
    for (const d of listDocs()) {
      const li = document.createElement('li');
      li.className = 'doc-shelf-item' + (d.id === currentDoc()?.id ? ' active' : '');
      const main = document.createElement('button');
      main.className = 'doc-shelf-item-main';
      const title = document.createElement('span');
      title.className = 'doc-shelf-item-title';
      title.textContent = d.title;
      const meta = document.createElement('span');
      meta.className = 'doc-shelf-item-meta';
      const chip = d.format === 'markdown' ? 'md' : d.format === 'html' ? 'html' : 'txt';
      meta.textContent = `${chip} · ${formatRelativeTime(d.updatedAt)}`;
      if (d.path) meta.title = d.path;
      main.appendChild(title);
      main.appendChild(meta);
      main.onclick = () => { selectDoc(d.id); view = 'reader'; rerender(ctx); };
      li.appendChild(main);

      const close = document.createElement('button');
      close.className = 'doc-shelf-item-close';
      close.textContent = '✕';
      close.setAttribute('aria-label', `Remove "${d.title}"`);
      close.onclick = (e) => { e.stopPropagation(); removeDoc(d.id); rerender(ctx); };
      li.appendChild(close);
      ul.appendChild(li);
    }
    opts.body.appendChild(ul);
  }

  function renderReader(ctx: RightDrawerModuleContext, doc: DocState): void {
    const header = document.createElement('div');
    header.className = 'doc-drawer-header';

    // `‹ All docs (n)` — the shelf entry point. Hidden as a no-op when
    // there's a single doc? No: still useful (shows the count model), but
    // keep it quiet at n=1 by labelling with the count either way.
    const listBtn = document.createElement('button');
    listBtn.className = 'doc-drawer-listbtn';
    listBtn.textContent = `‹ All docs (${docCount()})`;
    listBtn.setAttribute('aria-label', 'Show all documents');
    listBtn.onclick = () => { view = 'list'; rerender(ctx); };
    header.appendChild(listBtn);

    const spacer = document.createElement('span');
    spacer.className = 'doc-drawer-header-spacer';
    header.appendChild(spacer);

    const meta = document.createElement('span');
    meta.className = 'doc-drawer-meta';
    meta.textContent = formatRelativeTime(doc.updatedAt);
    if (doc.path) meta.title = doc.path;
    header.appendChild(meta);

    // Download — single file, filename from the path basename else a
    // slugified title, mime by format. No zip/PDF by design.
    const dl = document.createElement('button');
    dl.className = 'doc-drawer-download';
    dl.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2v8.5"/><path d="M4.5 7.5 8 11l3.5-3.5"/><path d="M2.5 13.5h11"/></svg>';
    dl.setAttribute('aria-label', 'Download document');
    dl.setAttribute('title', 'Download');
    dl.onclick = () => downloadDoc(doc);
    header.appendChild(dl);

    opts.body.appendChild(header);

    const titleEl = document.createElement('div');
    titleEl.className = 'doc-drawer-title';
    titleEl.textContent = doc.title;
    opts.body.appendChild(titleEl);

    if (doc.format === 'html') {
      const frame = document.createElement('iframe');
      frame.className = 'doc-drawer-frame';
      // Empty sandbox = no scripts, no same-origin, no forms, no popups.
      frame.setAttribute('sandbox', '');
      frame.srcdoc = doc.content;
      opts.body.appendChild(frame);
    } else if (doc.format === 'markdown') {
      const md = document.createElement('div');
      md.className = 'doc-drawer-content';
      md.innerHTML = miniMarkdown(doc.content);
      opts.body.appendChild(md);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'doc-drawer-content doc-drawer-plain';
      pre.textContent = doc.content;
      opts.body.appendChild(pre);
    }
  }

  return {
    id: 'doc',
    title: 'Docs',
    panel: opts.panel,
    toggleIds: ['btn-doc-drawer-rail'],
    render,
    onClear: (ctx) => {
      if (view === 'list') { clearDocs(); view = 'reader'; }
      else {
        const doc = currentDoc();
        if (doc) removeDoc(doc.id);
      }
      ctx.render();
    },
    onSelect: () => { opts.onSelect?.(); },
  };
}

function downloadDoc(doc: DocState): void {
  const ext = doc.format === 'markdown' ? '.md' : doc.format === 'html' ? '.html' : '.txt';
  const mime = doc.format === 'markdown' ? 'text/markdown'
    : doc.format === 'html' ? 'text/html' : 'text/plain';
  const base = doc.path
    ? (doc.path.split('/').pop() || 'document')
    : (doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'document') + ext;
  const blob = new Blob([doc.content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = base;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}
