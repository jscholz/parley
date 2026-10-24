/**
 * @fileoverview Hide the machine-written attachment notes in a USER
 * bubble (2026-10-15). When files are sent to the model, hermes appends
 * a line per image ("[Image attached at: /tmp/…png]" from image_routing,
 * "[screenshot]" from its text-only DB projection), plus a count such as
 * "[94 images]". A 94-page PDF ballooned his message with ~190 such
 * lines. They're for the model; the bubble shows his words and the
 * attachment chips. Display-only — history sent to the agent is untouched.
 */
const NOTE_LINE = [
  /^\[Image attached(?: at)?: [^\]\n]*\]$/i,
  /^\[screenshot\]$/i,
  /^\[\d+ (?:images?|pages?|files?|attachments?)\]$/i,
  /^\[image content removed[^\]\n]*\]$/i,
];

/** A PDF upload's extracted text, fenced by the plugin (parley_pdf_ingest,
 *  2026-10-18): "[PDF attached: …]" … "[end of PDF: …]". */
const PDF_BLOCK = /^\[PDF attached: [^\n]*\]\n[\s\S]*?\n\[end of PDF: [^\n]*\]$/gm;
/** A text-file upload's inlined content, fenced by the plugin
 *  (parley_text_ingest, 2026-10-24): "[File attached: …]" … "[end of
 *  file: …]". The bubble shows the file chip; the model gets the text. */
const FILE_BLOCK = /^\[File attached: [^\n]*\]\n[\s\S]*?\n\[end of file: [^\n]*\]$/gm;

/** hermes' recalled-memory block, stored INSIDE a multimodal user row
 *  (hermes keeps it durable for prompt-cache parity). The plugin strips it
 *  on read (2026-10-20); this covers rows already cached in IDB. */
const MEMORY_CONTEXT = /\s*<\s*memory-context\s*>[\s\S]*?<\/\s*memory-context\s*>\s*/gi;

export function stripAttachmentNotes(text: string): string {
  if (text && text.indexOf('memory-context') >= 0) {
    const without = text.replace(MEMORY_CONTEXT, '\n\n').trim();
    if (without !== text) return stripAttachmentNotes(without);
  }
  if (!text || text.indexOf('[') < 0) return text;
  if (text.indexOf('[PDF attached: ') >= 0) {
    const without = text.replace(PDF_BLOCK, '');
    if (without !== text) return stripAttachmentNotes(without.replace(/\n{3,}/g, '\n\n').trim());
  }
  if (text.indexOf('[File attached: ') >= 0) {
    const without = text.replace(FILE_BLOCK, '');
    if (without !== text) return stripAttachmentNotes(without.replace(/\n{3,}/g, '\n\n').trim());
  }
  const lines = text.split('\n');
  const kept = lines.filter((l) => !NOTE_LINE.some((re) => re.test(l.trim())));
  if (kept.length === lines.length) return text;
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The user-facing summary the plugin writes inside a REDUCED PDF's block
 *  ("[PDF note: tax.pdf (94 pages) was reduced for the agent — …]",
 *  2026-10-20). The bubble hides the block but shows these as a caption,
 *  so he knows when the agent didn't see every page as an image. */
const PDF_NOTE = /^\[(?:PDF|File) note: ([^\n]*)\]$/gm;

export function pdfNotices(text: string): string[] {
  if (!text || (text.indexOf('[PDF note: ') < 0 && text.indexOf('[File note: ') < 0)) return [];
  return [...text.matchAll(PDF_NOTE)].map((m) => m[1].trim()).filter(Boolean);
}
