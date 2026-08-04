/**
 * @fileoverview Image card kind.
 * @typedef {import('../../types.js').ImagePayload} ImagePayload
 * @typedef {import('../../types.js').CanvasCard} CanvasCard
 */

import { escapeAttr, escapeHtml } from '../../util/dom.ts';
import { apiUrl } from '../../apiBase.ts';

/** @type {import('../../types.js').CardKindModule} */
export default {
  kind: 'image',
  icon: '⬚',
  label: 'Image',

  validate(payload) {
    const errors = [];
    if (typeof payload.url !== 'string' || !payload.url) {
      errors.push('missing or invalid url');
    }
    return errors;
  },

  render(card, container) {
    const p = /** @type {ImagePayload} */ (card.payload);
    const div = document.createElement('div');
    div.className = 'card-image';
    const img = document.createElement('img');
    // Site-relative urls (the /api/sidekick/media/<id> lane) resolve
    // against the API origin — under CAP the page origin is
    // capacitor://localhost and a relative src 404s into the bundle.
    img.src = p.url.startsWith('/') ? apiUrl(p.url) : p.url;
    img.alt = p.alt || p.caption || '';
    img.loading = 'lazy';
    div.appendChild(img);
    if (p.caption) {
      const cap = document.createElement('div');
      cap.className = 'caption';
      cap.textContent = p.caption;
      div.appendChild(cap);
    }
    container.appendChild(div);
  },
};
