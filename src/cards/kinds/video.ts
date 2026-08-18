/**
 * @fileoverview Video card kind — agent-pushed video files rendered
 * inline on the reply bubble (2026-08-04 multimedia lane; the serving
 * side is proxy/sidekick/media.ts). Mirrors image.ts; the <video>
 * attribute set matches the transcript's user-attachment echo player
 * (chat.ts): controls + playsInline (iOS must not force fullscreen) +
 * preload=metadata (first frame + duration, not the whole file — the
 * server route streams Range requests, so scrubbing stays cheap).
 */

import { apiUrl } from '../../apiBase.ts';

/** Site-relative urls (the /api/parley/media/<id> lane) must resolve
 *  against the API origin, not the page origin — under CAP the page
 *  origin is capacitor://localhost and a relative src would 404 into
 *  the local bundle. Absolute urls pass through untouched. */
function resolveMediaUrl(url) {
  return url.startsWith('/') ? apiUrl(url) : url;
}

/** @type {import('../../types.js').CardKindModule} */
export default {
  kind: 'video',
  icon: '▶',
  label: 'Video',

  validate(payload) {
    const errors = [];
    if (typeof payload.url !== 'string' || !payload.url) {
      errors.push('missing or invalid url');
    }
    return errors;
  },

  render(card, container) {
    const p = card.payload;
    const div = document.createElement('div');
    div.className = 'card-video';
    const video = document.createElement('video');
    video.src = resolveMediaUrl(p.url);
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    if (p.poster) video.poster = resolveMediaUrl(p.poster);
    div.appendChild(video);
    if (p.caption) {
      const cap = document.createElement('div');
      cap.className = 'caption';
      cap.textContent = p.caption;
      div.appendChild(cap);
    }
    container.appendChild(div);
  },
};
