/**
 * @fileoverview Audio card kind — agent-pushed audio files rendered
 * inline on the reply bubble (media lane round 2; the serving side is
 * proxy/sidekick/media.ts, which streams m4a/mp3/wav/ogg with Range so
 * scrubbing stays cheap). Mirrors video.ts: a native <audio controls>
 * element is enough here — unlike the meeting-capture player strip
 * (rightDrawer/modules/doc.ts) this is a self-contained produced file,
 * not a lazily-stitched capture, so the browser's built-in transport +
 * scrubber is the right, cheapest surface. preload=metadata gets the
 * duration without pulling the whole file.
 */

import { apiUrl } from '../../apiBase.ts';

/** Site-relative urls (the /api/sidekick/media/<id> lane) must resolve
 *  against the API origin, not the page origin — under CAP the page
 *  origin is capacitor://localhost and a relative src would 404 into
 *  the local bundle. Absolute urls pass through untouched. */
function resolveMediaUrl(url) {
  return url.startsWith('/') ? apiUrl(url) : url;
}

/** @type {import('../../types.js').CardKindModule} */
export default {
  kind: 'audio',
  icon: '♪',
  label: 'Audio',

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
    div.className = 'card-audio';
    const audio = document.createElement('audio');
    audio.src = resolveMediaUrl(p.url);
    audio.controls = true;
    audio.preload = 'metadata';
    div.appendChild(audio);
    if (p.caption) {
      const cap = document.createElement('div');
      cap.className = 'caption';
      cap.textContent = p.caption;
      div.appendChild(cap);
    }
    container.appendChild(div);
  },
};
