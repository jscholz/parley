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

export function stripAttachmentNotes(text: string): string {
  if (!text || text.indexOf('[') < 0) return text;
  if (text.indexOf('[PDF attached: ') >= 0) {
    const without = text.replace(PDF_BLOCK, '');
    if (without !== text) return stripAttachmentNotes(without.replace(/\n{3,}/g, '\n\n').trim());
  }
  const lines = text.split('\n');
  const kept = lines.filter((l) => !NOTE_LINE.some((re) => re.test(l.trim())));
  if (kept.length === lines.length) return text;
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
