/**
 * @fileoverview Composer attachments — image picker + chips UI + send-path
 * data. Models gate what's accepted (image-capable models only).
 *
 * Owns the `pendingAttachments` queue, the chip DOM in `#composer-attachments`,
 * and the enable/disable state of the attach + camera buttons. Everyone else
 * interacts via the exported helpers — no direct DOM pokes.
 */

import { log } from './util/log.ts';
import { apiUrl } from './apiBase.ts';
import * as status from './status.ts';
import * as chat from './chat.ts';
import * as modelCaps from './modelCapabilities.ts';
import { toast } from './toast.ts';

/** Each pending attachment:
 *  { file, dataUrl?, previewUrl, mimeType, fileName, size }.
 *  `file` is the raw File (kept so large attachments can be streamed to
 *  the upload endpoint without base64). `dataUrl` is only computed for
 *  small files (the base64-in-JSON send path); large files leave it
 *  unset and rely on `previewUrl` (an object URL) for the chip. */
const pending = [];
// Task #158: 100 MB ceiling. Large files no longer ride the base64-in-
// JSON message body — anything over UPLOAD_THRESHOLD streams as raw
// bytes to /api/parley/upload (no ~33% base64 inflation, no full
// in-memory buffer) and is referenced by upload_id. The server caps the
// staged file + rasterized PDF at 100 MB to match.
const MAX_BYTES = 100_000_000;
// Files at or below this ride the existing base64 data-URL path inside
// the JSON message body. Above it, route through the streaming upload
// endpoint. ~5 MB keeps the JSON body comfortably under the proxy's
// 50 MB cap even after base64 inflation, while avoiding an extra HTTP
// round-trip for the common small-photo case.
const UPLOAD_THRESHOLD = 5_000_000;
// Field bug #224 (2026-06-12): a native-res iPhone photo (HEIC→JPEG
// transcoded at pick, often 3-6MB — just under UPLOAD_THRESHOLD) rode
// the inline base64 path as a ~5MB+ JSON POST with no timeout/retry;
// one socket stall on bad wifi = "Send failed." Models don't benefit
// from >2048px input anyway, so downscale photos client-side before
// they enter the queue: a 12MP photo becomes a few-hundred-KB JPEG
// that survives bad links.
const DOWNSCALE_THRESHOLD = 1_000_000;
const DOWNSCALE_MAX_DIM = 2048;
// Quality walk: most photos land well under 1MB at the first step;
// pathological high-entropy images (dense texture) step down until the
// wire payload is small enough to survive a flaky link.
const DOWNSCALE_JPEG_QUALITIES = [0.85, 0.7, 0.55, 0.4];

// ── Plain-text attachments (2026-10-24) ─────────────────────────────
// Mirror of the plugin's parley_text_ingest classification: MIME first,
// then the extension for empty / mislabeled MIMEs (".md" often arrives
// as "", ".ts" as video/mp2t). Kept small on purpose — the plugin owns
// the full list; the client only has to say yes to the obvious ones.
const TEXT_MAX_BYTES = 2_000_000;
const TEXT_EXTS = new Set([
  'txt', 'text', 'md', 'markdown', 'mdx', 'rst', 'adoc', 'org', 'log', 'csv', 'tsv',
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'xml', 'html', 'htm', 'svg', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'm',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'pl', 'lua', 'r', 'jl', 'scala', 'ex', 'exs', 'hs', 'dart', 'vue', 'svelte',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'sql', 'graphql', 'proto', 'tex', 'bib', 'diff', 'patch',
  'gitignore', 'editorconfig', 'dockerfile', 'makefile', 'srt', 'vtt', 'ics',
]);
const TEXT_APP_MIMES = new Set([
  'application/json', 'application/ld+json', 'application/x-ndjson', 'application/xml', 'application/x-yaml',
  'application/yaml', 'application/toml', 'application/javascript', 'application/x-javascript',
  'application/typescript', 'application/x-sh', 'application/x-shellscript', 'application/sql', 'image/svg+xml',
]);
// ── Audio attachments (2026-10-25) ──────────────────────────────────
// Voice notes and recordings. Capped under the proxy's 25 MB /transcribe
// body limit (the plugin transcribes through it).
const AUDIO_MAX_BYTES = 24_000_000;
const AUDIO_EXTS = new Set(['ogg', 'oga', 'opus', 'm4a', 'mp3', 'wav', 'aac', 'flac', 'amr', 'weba', 'caf', 'aiff', 'aif']);
const AUDIO_EXT_MIME: Record<string, string> = {
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
  aac: 'audio/aac', flac: 'audio/flac', amr: 'audio/amr', weba: 'audio/webm', caf: 'audio/x-caf', aiff: 'audio/aiff', aif: 'audio/aiff',
};
export function isAudioMime(mime: string | undefined | null): boolean {
  const m = (mime || '').split(';')[0].trim().toLowerCase();
  return m.startsWith('audio/') || m === 'application/ogg' || m === 'application/x-ogg';
}
/** The MIME we send for an audio file, or null when it is not one. */
export function audioMimeFor(file: { type: string; name: string }): string | null {
  const m = (file.type || '').split(';')[0].trim().toLowerCase();
  const ext = extOf(file.name);
  if (AUDIO_EXT_MIME[ext]) return AUDIO_EXT_MIME[ext];
  if (m.startsWith('audio/')) return m;
  if (m === 'application/ogg' || m === 'application/x-ogg') return 'audio/ogg';
  if (m && m !== 'application/octet-stream') return null;
  return AUDIO_EXTS.has(ext) ? 'audio/ogg' : null;
}
function extOf(name: string): string {
  const base = (name || '').toLowerCase().split('/').pop() || '';
  if (base === 'dockerfile' || base === 'makefile') return base;
  return base.includes('.') ? base.split('.').pop()! : '';
}
export function isTextMime(mime: string | undefined | null): boolean {
  const m = (mime || '').split(';')[0].trim().toLowerCase();
  return m.startsWith('text/') || TEXT_APP_MIMES.has(m);
}
/** The MIME we send for a text-like file, or null when it is not one. */
export function textMimeFor(file: { type: string; name: string }): string | null {
  const m = (file.type || '').split(';')[0].trim().toLowerCase();
  const ext = extOf(file.name);
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'text/markdown';
  if (isTextMime(m)) return m;
  if (m && m !== 'application/octet-stream' && m !== 'video/mp2t') return null;
  if (!TEXT_EXTS.has(ext)) return null;
  if (ext === 'csv') return 'text/csv';
  if (ext === 'json' || ext === 'jsonl') return 'application/json';
  if (ext === 'html' || ext === 'htm') return 'text/html';
  return 'text/plain';
}


/** Downscale a large still image to ≤DOWNSCALE_MAX_DIM on the long edge.
 *  Skips gif/svg (animation / vector). Returns the original file when
 *  it's already small, decoding fails, or the re-encode isn't smaller
 *  (never make things worse). PNG stays PNG (screenshots with text);
 *  everything else re-encodes as JPEG. */
async function maybeDownscaleImage(file: File): Promise<File> {
  if (file.size <= DOWNSCALE_THRESHOLD) return file;
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  let bitmap;
  try {
    // 'from-image' bakes in EXIF rotation so the canvas copy isn't
    // sideways; some engines reject the option — fall back to plain.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      .catch(() => createImageBitmap(file));
  } catch {
    return file;
  }
  if (!bitmap) return file;
  try {
    const { width, height } = bitmap;
    const scale = Math.min(1, DOWNSCALE_MAX_DIM / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    let blob: Blob | null = null;
    if (outType === 'image/png') {
      blob = await new Promise((resolve) => canvas.toBlob(resolve, outType));
    } else {
      for (const q of DOWNSCALE_JPEG_QUALITIES) {
        blob = await new Promise((resolve) => canvas.toBlob(resolve, outType, q));
        if (blob && blob.size <= DOWNSCALE_THRESHOLD) break;
      }
    }
    if (!blob || blob.size >= file.size) return file;
    const name = outType === file.type
      ? file.name
      : (file.name || 'image').replace(/\.[a-z0-9]+$/i, '') + '.jpg';
    log(`attachment downscaled: ${file.name} ${width}×${height} ${file.size}B → ${w}×${h} ${blob.size}B`);
    return new File([blob], name, { type: outType });
  } finally {
    try { bitmap.close(); } catch {}
  }
}

/** Stream a large file's raw bytes to the staging endpoint; returns the
 *  upload_id the message send references. No base64, no multipart — the
 *  File is sent as the raw request body (browsers stream File bodies off
 *  disk, so a 57 MB PDF never inflates in JS memory). */
async function uploadLarge(file: File): Promise<string> {
  const res = await fetch(apiUrl('/api/parley/upload'), {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`upload failed: HTTP ${res.status} ${detail.slice(0, 120)}`);
  }
  const j = await res.json().catch(() => ({}));
  if (!j?.upload_id) throw new Error('upload response missing upload_id');
  return j.upload_id as string;
}

/** Surface a rejection so it actually STAYS visible. The header status
 *  line is clobbered within ~2s by the memoOutbox network-status refresher,
 *  so a setStatus('…','err') flashes and vanishes — the user reads it as
 *  "nothing happened". Route attachment errors through a toast instead. */
function rejectAttachment(msg: string) {
  toast(msg, 'err');
  status.setStatus(msg, 'err');
}

/** Called after the pending list changes — main wires this to refresh the
 *  composer send-button enabled state. */
let onChange = () => {};

export function init(opts: { onChange?: () => void } = {}) {
  onChange = opts.onChange || (() => {});
}

export function getPending() { return pending; }
export function hasPending() { return pending.length > 0; }

/** Strip data-url prefix, return a gateway-ready attachment payload list.
 *  We tag videos with `type: 'video'` in case any plugin / model wants
 *  to distinguish; gateways that only recognise 'image' will typically
 *  still pass the bytes through with the mimeType intact. Probing
 *  strategy — if this breaks for a specific model, we'll iterate. */
/** Build the gateway-ready attachment payload. Async because large
 *  files (over UPLOAD_THRESHOLD) are streamed to /api/parley/upload
 *  first and referenced by `uploadId`; small files keep the inline
 *  base64 `content`. Snapshots `pending` synchronously up front so a
 *  caller that clears the composer right after this call can't mutate
 *  the list out from under the in-flight uploads. */
export function toSendPayload() {
  const items = pending.slice();
  return Promise.all(items.map(async (a) => {
    const type = a.mimeType?.startsWith('video/') ? 'video' : isTextMime(a.mimeType) ? 'file' : isAudioMime(a.mimeType) ? 'audio' : 'image';
    const base = { type, mimeType: a.mimeType, fileName: a.fileName };
    if (a.size > UPLOAD_THRESHOLD) {
      const uploadId = await uploadLarge(a.file);
      return { ...base, uploadId };
    }
    // server strips the `data:...;base64,` prefix off `content`
    return { ...base, content: a.dataUrl };
  }));
}

/** Used by the transcript renderer when echoing a user message with
 *  images. Large files have no base64 dataUrl — fall back to the object
 *  URL preview so the optimistic bubble still shows something. */
export function toChatEcho() {
  return pending.map(a => ({
    dataUrl: a.dataUrl || a.previewUrl, mimeType: a.mimeType, fileName: a.fileName,
  }));
}

/** Revoke an attachment's object-URL preview if it has one. data: URLs
 *  (small-file previews) need no cleanup; blob: URLs (large-file
 *  previews) leak until revoked. */
function revokePreview(att) {
  if (att?.previewUrl && att.previewUrl.startsWith('blob:')) {
    try { URL.revokeObjectURL(att.previewUrl); } catch {}
  }
}

export function clear() {
  pending.forEach(revokePreview);
  pending.length = 0;
  renderChips();
  onChange();
}

export async function add(file) {
  if (!file) return;
  // Accept images + videos + PDFs. The gateway currently bundles
  // images and videos as `{ type: 'image', ... }`; PDFs are rasterized
  // server-side by the hermes parley plugin (per-page PNGs), so by
  // the time the agent sees them they're back to image content blocks.
  // Some multimodal models (Gemini, some Gemma variants) decode video
  // frames; others reject. We keep the client permissive — if the
  // gateway or model rejects, the user sees it in the reply.
  // Plain text and anything that is a synonym for it — .md, .txt, logs,
  // CSV/JSON/YAML, source files (2026-10-24). Decided FIRST: a browser
  // labels "recorder.ts" video/mp2t, and the video branch must not win.
  // The plugin inlines the content into the turn (fenced) and keeps a
  // durable copy; no model capability is needed, so text is never gated
  // on vision.
  const textMime = textMimeFor(file);
  const isText = !!textMime;
  // Audio (2026-10-25: a WhatsApp voice note, Opus in OGG) — the plugin
  // transcribes it for the agent; the bubble shows a player.
  const audioMime = isText ? null : audioMimeFor(file);
  const isAudio = !!audioMime;
  const isImage = !isText && !isAudio && file.type.startsWith('image/');
  const isVideo = !isText && !isAudio && file.type.startsWith('video/');
  const isPdf = !isText && !isAudio && file.type === 'application/pdf';
  if (!isImage && !isVideo && !isPdf && !isText && !isAudio) {
    rejectAttachment('Only image, video, PDF, text, and audio attachments are supported');
    return;
  }
  if (isAudio && file.size > AUDIO_MAX_BYTES) {
    rejectAttachment(`Audio too large — ${(file.size / 1_000_000).toFixed(1)}MB exceeds the ${AUDIO_MAX_BYTES / 1_000_000}MB limit for audio`);
    return;
  }
  if (isText && file.size > TEXT_MAX_BYTES) {
    rejectAttachment(`Text file too large — ${(file.size / 1_000_000).toFixed(1)}MB exceeds the ${TEXT_MAX_BYTES / 1_000_000}MB limit for text`);
    return;
  }
  // A PDF only reaches the model if it's pdf-native or rasterize-capable
  // (vision, incl. the auxiliary fallback). On a model that's neither, the
  // gateway would silently discard it — reject up front so the user knows.
  if (isPdf && !modelCaps.canAttachPdf()) {
    rejectAttachment("Current model can't accept PDF attachments");
    return;
  }
  if (file.size > MAX_BYTES) {
    const mb = (n: number) => `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}MB`;
    rejectAttachment(`File too large — ${mb(file.size)} exceeds the ${mb(MAX_BYTES)} limit`);
    return;
  }
  try {
    if (isImage) file = await maybeDownscaleImage(file);
    const kindLabel = isVideo ? 'video' : (isPdf ? 'document' : isText ? 'file' : isAudio ? 'audio' : 'image');
    const ext = isPdf
      ? 'pdf'
      : (isText || isAudio) ? (file.name.split('.').pop() || (isAudio ? 'ogg' : 'txt'))
        : (file.type.split('/')[1] || (isVideo ? 'mp4' : 'jpg')).split(';')[0];
    // Large files skip base64 — reading a 57 MB PDF into a data URL
    // would buffer ~76 MB of base64 in JS memory for nothing (it's
    // streamed raw to the upload endpoint at send time). They get an
    // object-URL preview instead; small files keep the data URL for
    // the inline send path + a stable preview.
    const isLarge = file.size > UPLOAD_THRESHOLD;
    const dataUrl = isLarge ? undefined : await readAsDataUrl(file);
    const previewUrl = dataUrl || URL.createObjectURL(file);
    pending.push({
      file,
      dataUrl,
      previewUrl,
      mimeType: textMime || audioMime || file.type,
      fileName: file.name || `${kindLabel}-${Date.now()}.${ext}`,
      size: file.size,
    });
    renderChips();
    onChange();
  } catch (e) {
    log('attachment read failed:', e.message);
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(/** @type {string} */ (r.result));
    r.onerror = () => reject(new Error('file read failed'));
    r.readAsDataURL(file);
  });
}

function renderChips() {
  const container = document.getElementById('composer-attachments');
  if (!container) return;
  container.innerHTML = '';
  if (pending.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  pending.forEach((att, i) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    // Video chips show a small silent <video> poster (iOS may not
    // auto-render frame 1 unless muted+preload=metadata). PDFs render
    // as a labelled placeholder — we can't easily preview the first
    // page client-side without pulling pdf.js, and rasterization
    // happens server-side anyway. Image chips stay as <img>.
    if (att.mimeType?.startsWith('video/')) {
      const vid = document.createElement('video');
      vid.src = att.previewUrl;
      vid.muted = true;
      vid.playsInline = true;
      vid.preload = 'metadata';
      vid.title = att.fileName;
      chip.appendChild(vid);
      chip.classList.add('chip-video');
    } else if (att.mimeType === 'application/pdf') {
      const placeholder = document.createElement('div');
      placeholder.className = 'chip-pdf-label';
      placeholder.title = att.fileName;
      placeholder.textContent = 'PDF';
      chip.appendChild(placeholder);
      chip.classList.add('chip-pdf');
    } else if (isAudioMime(att.mimeType)) {
      const placeholder = document.createElement('div');
      placeholder.className = 'chip-pdf-label chip-audio-label';
      placeholder.title = att.fileName;
      placeholder.textContent = '♪ ' + ((String(att.fileName || '').split('.').pop() || 'audio').toUpperCase().slice(0, 4));
      chip.appendChild(placeholder);
      chip.classList.add('chip-pdf', 'chip-audio');
    } else if (isTextMime(att.mimeType)) {
      // Text file: the extension is the glyph (MD / TXT / JSON …).
      const placeholder = document.createElement('div');
      placeholder.className = 'chip-pdf-label chip-file-label';
      placeholder.title = att.fileName;
      const ext = String(att.fileName || '').split('.').pop() || 'txt';
      placeholder.textContent = ext.length <= 4 ? ext.toUpperCase() : 'TXT';
      chip.appendChild(placeholder);
      chip.classList.add('chip-pdf', 'chip-file');
    } else {
      const img = document.createElement('img');
      img.src = att.previewUrl;
      img.alt = att.fileName;
      chip.appendChild(img);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip-remove';
    btn.title = 'Remove';
    btn.textContent = '×';
    btn.onclick = () => {
      const [removed] = pending.splice(i, 1);
      revokePreview(removed);
      renderChips();
      onChange();
    };
    chip.appendChild(btn);
    container.appendChild(chip);
  });
}

/** React to a model change. Button enable/disable + tooltips are owned by
 *  modelCapabilities (single source: the plugin's models.dev-backed
 *  capability endpoint, which is fallback-aware — a text-only primary with
 *  an auxiliary vision model can still take attachments). This module
 *  previously set the buttons too, off settings.getCurrentModelEntry().input,
 *  which disagreed with the fallback path. Delegate the button state and
 *  keep only the pending-queue side effect here. */
export function updateModelGate() {
  modelCaps.updateAttachButtonsState();
  if (pending.length === 0) return;
  // Only drop pending items once we actually KNOW the new model's
  // capabilities — a transient cache miss must not discard valid files
  // before the real verdict lands.
  if (!modelCaps.capsKnownFor(modelCaps.currentModelId())) return;
  const canImage = modelCaps.canAttachFiles();
  const canPdf = modelCaps.canAttachPdf();
  // Text attachments need no model capability — they ride in the turn's text.
  const keep = (a) => ((isTextMime(a.mimeType) || isAudioMime(a.mimeType)) ? true : a.mimeType === 'application/pdf' ? canPdf : canImage);
  const kept = pending.filter(keep);
  if (kept.length === pending.length) return;
  const dropped = pending.length - kept.length;
  pending.filter(a => !keep(a)).forEach(revokePreview);
  pending.length = 0;
  pending.push(...kept);
  renderChips();
  onChange();
  chat.addSystemLine(
    `${dropped > 1 ? 'Attachments' : 'Attachment'} cleared — current model can't use ${dropped > 1 ? 'them' : 'it'}`,
  );
}
