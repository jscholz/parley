/**
 * @fileoverview Attachment card — a file the agent delivered through the
 * proxy's general-file lane (proxy/parley/attachments.ts, 2026-10-08:
 * "a widget that lets the agent push to a container and the user click
 * a button to download it"). Nothing here renders the file; the card
 * is a name, a size when known, and a Download button.
 *
 * Download semantics by host:
 *   - browser / PWA: an <a download> to the API-origin URL — the server
 *     answers Content-Disposition: attachment, so the browser saves it.
 *   - CAP iOS shell: WKWebView cannot save a download (an <a download>
 *     silently navigates the web view to the bytes). Hand the absolute
 *     URL to the OS browser via the ExternalBrowser plugin instead —
 *     Safari/Chrome show the share sheet / save to Files.
 */

import { apiUrl } from '../../apiBase.ts';
import { isNativeShell, openExternal } from '../../native/externalLinks.ts';

function resolveUrl(url) {
  return url.startsWith('/') ? apiUrl(url) : url;
}

/** "R2 deck.pptx (1.2 MB)" → { name, size } — the plugin folds the size
 *  into the link label; keep the parse forgiving. Exported for tests. */
export function splitAttachmentLabel(label) {
  const m = /^(.*?)\s*\(([\d.]+\s*(?:B|KB|MB|GB))\)\s*$/i.exec(label || '');
  if (m) return { name: m[1].trim(), size: m[2].trim() };
  return { name: (label || '').trim(), size: '' };
}

function iconFor(name) {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (['pdf'].includes(ext)) return '📄';
  if (['ppt', 'pptx', 'key'].includes(ext)) return '📊';
  if (['doc', 'docx', 'pages', 'md', 'txt'].includes(ext)) return '📝';
  if (['xls', 'xlsx', 'csv', 'numbers'].includes(ext)) return '📈';
  if (['zip', 'tar', 'gz', 'tgz'].includes(ext)) return '🗜️';
  return '📎';
}

/** @type {import('../../types.js').CardKindModule} */
export default {
  kind: 'attachment',
  icon: '📎',
  label: 'Attachment',

  validate(payload) {
    const errors = [];
    if (typeof payload.url !== 'string' || !payload.url) errors.push('missing or invalid url');
    return errors;
  },

  render(card, container) {
    const p = card.payload;
    const { name, size } = p.name ? { name: p.name, size: p.size || '' } : splitAttachmentLabel(p.label);
    const href = resolveUrl(p.url);
    const div = document.createElement('div');
    div.className = 'card-attachment';

    const icon = document.createElement('span');
    icon.className = 'attachment-icon';
    icon.textContent = iconFor(name);
    div.appendChild(icon);

    const meta = document.createElement('div');
    meta.className = 'attachment-meta';
    const title = document.createElement('div');
    title.className = 'attachment-name';
    title.textContent = name || 'Attachment';
    title.title = name;
    meta.appendChild(title);
    if (size) {
      const sub = document.createElement('div');
      sub.className = 'attachment-size';
      sub.textContent = size;
      meta.appendChild(sub);
    }
    div.appendChild(meta);

    const btn = document.createElement('a');
    btn.className = 'attachment-download';
    btn.href = href;
    btn.textContent = 'Download';
    btn.setAttribute('download', name || '');
    btn.setAttribute('aria-label', `Download ${name || 'attachment'}`);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!isNativeShell()) return;           // browser: <a download> does the job
      e.preventDefault();
      void openExternal(href);                // CAP: the OS browser can save it
    });
    div.appendChild(btn);

    container.appendChild(div);
  },
};
