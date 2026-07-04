// Docs drawer tab — renders the document the agent pushed via the
// display_doc tool (see docStore.ts for the data path). Markdown renders
// through the shared XSS-safe miniMarkdown; HTML renders inside a fully
// sandboxed iframe (no scripts, no same-origin — the doc comes off the
// agent host's filesystem and must stay inert); everything else is
// plain text.

import type { RightDrawerModule, RightDrawerModuleContext } from '../host.ts';
import { miniMarkdown } from '../../util/markdown.ts';
import { currentDoc, clearDoc } from '../docStore.ts';
import { formatRelativeTime } from './common.ts';

export function createDocModule(opts: {
  panel: HTMLElement;
  body: HTMLElement;
  empty: HTMLElement;
  onSelect?: () => void;
}): RightDrawerModule {
  const render = (ctx: RightDrawerModuleContext) => {
    const doc = currentDoc();
    if (ctx.clearButton) {
      ctx.clearButton.hidden = !doc;
      ctx.clearButton.textContent = 'Clear';
      ctx.clearButton.setAttribute('aria-label', 'Clear document');
      ctx.clearButton.setAttribute('title', 'Clear document');
    }
    opts.body.innerHTML = '';
    if (!doc) {
      opts.empty.hidden = false;
      opts.body.hidden = true;
      return;
    }
    opts.empty.hidden = true;
    opts.body.hidden = false;

    const header = document.createElement('div');
    header.className = 'doc-drawer-header';
    const title = document.createElement('span');
    title.className = 'doc-drawer-title';
    title.textContent = doc.title;
    header.appendChild(title);
    const meta = document.createElement('span');
    meta.className = 'doc-drawer-meta';
    meta.textContent = formatRelativeTime(doc.receivedAt);
    if (doc.path) meta.title = doc.path;
    header.appendChild(meta);
    opts.body.appendChild(header);

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
  };

  return {
    id: 'doc',
    title: 'Docs',
    panel: opts.panel,
    toggleIds: ['btn-doc-drawer-rail'],
    render,
    onClear: () => { clearDoc(); },
    onSelect: () => { opts.onSelect?.(); },
  };
}
