/**
 * Meeting title derivation (meeting-polish #25 — topical titles at
 * start AND end of a capture).
 *
 * Pure text → title functions; no I/O, no LLM. The capture pipeline
 * produces TRANSCRIPTS (summaries are the agent's post-ingest job and
 * arrive too late / non-deterministically for a rename), so the
 * end-of-meeting topical title is a deterministic salience heuristic
 * over the transcript body:
 *
 *   1. Strip transcript markup (header, meta line, [+M:SS] offsets,
 *      [MARK] rows, "Speaker N [t]:" labels, markdown emphasis).
 *   2. Tokenize; drop stopwords + short tokens + pure numbers.
 *   3. Score words by frequency (case-insensitive, first-seen casing
 *      kept for display). Bigrams that repeat get priority — a phrase
 *      said three times ("transcript migration") is a better topic
 *      label than its words separately.
 *   4. Title = "Meeting: <top phrase/terms>", capped at MAX_LEN.
 *
 * Too little content (< MIN_WORDS words) → null: the caller keeps the
 * placeholder title rather than inventing a topic from noise.
 */

const MAX_LEN = 64;
const MIN_WORDS = 25;

// Compact english stopword list — enough to keep glue words out of a
// title. Deliberately not exhaustive: an over-aggressive list starts
// eating domain words.
const STOPWORDS = new Set([
  'a', 'about', 'actually', 'after', 'again', 'all', 'also', 'am', 'an', 'and',
  'any', 'are', 'around', 'as', 'at', 'back', 'basically', 'be', 'because',
  'been', 'before', 'being', 'but', 'by', 'can', 'could', 'did', 'do', 'does',
  'doing', 'done', 'down', 'even', 'for', 'from', 'get', 'gets', 'getting',
  'go', 'going', 'gonna', 'good', 'got', 'had', 'has', 'have', 'having', 'he',
  'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'just', 'kind', 'know', 'like', 'likely', 'little', 'lot',
  'make', 'makes', 'many', 'may', 'maybe', 'me', 'mean', 'might', 'more',
  'most', 'much', 'my', 'need', 'needs', 'no', 'not', 'now', 'of', 'off',
  'oh', 'okay', 'ok', 'on', 'one', 'only', 'or', 'other', 'our', 'out',
  'over', 'own', 'people', 'pretty', 'put', 'really', 'right', 'said', 'same',
  'say', 'saying', 'see', 'she', 'should', 'so', 'some', 'something', 'sort',
  'still', 'stuff', 'sure', 'take', 'than', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'thing', 'things', 'think', 'this',
  'those', 'though', 'through', 'time', 'to', 'too', 'try', 'two', 'up', 'us',
  'use', 'very', 'want', 'wanna', 'was', 'way', 'we', 'well', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would',
  'yeah', 'yes', 'yet', 'you', 'your',
]);

/** Strip the transcript's structural markup down to spoken words. */
export function transcriptBodyText(markdown: string): string {
  return (markdown || '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (t.startsWith('#')) return false;                    // "# <title>" header
      if (t.startsWith('_') && t.endsWith('_')) return false; // meta line (_Recorded …_)
      if (/^\*\*\[MARK [^\]]*\]\*\*$/.test(t)) return false;  // mark rows
      return true;
    })
    .join(' ')
    // Segment offsets: **[+M:SS]** — and diarized speaker labels:
    // **Speaker N** [H:MM:SS]:
    .replace(/\*\*\[\+[0-9:]+\]\*\*/g, ' ')
    .replace(/\*\*Speaker \d+\*\*\s*\[[0-9:]+\]:/g, ' ')
    .replace(/\*\(transcription failed[^)]*\)\*/g, ' ')
    .replace(/[*_`#>]/g, ' ');
}

interface Scored { display: string; count: number; firstAt: number }

function tokenize(text: string): string[] {
  // Keep letters/digits/apostrophes/hyphens; everything else splits.
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []);
}

function isContentWord(tok: string): boolean {
  if (tok.length < 3) return false;
  if (/^\d+$/.test(tok)) return false;
  return !STOPWORDS.has(tok.toLowerCase());
}

function titleCase(word: string): string {
  // Preserve existing capitalization (acronyms, CamelCase names); only
  // lift all-lowercase words.
  return word === word.toLowerCase()
    ? word.charAt(0).toUpperCase() + word.slice(1)
    : word;
}

/**
 * Derive a topical title from a meeting transcript (markdown as
 * written by captureTranscribe). Returns null when there isn't enough
 * content to name a topic (caller keeps the placeholder).
 */
export function topicalTitleFromTranscript(markdown: string): string | null {
  const words = tokenize(transcriptBodyText(markdown));
  if (words.length < MIN_WORDS) return null;

  // Unigram frequencies (content words only).
  const uni = new Map<string, Scored>();
  words.forEach((w, i) => {
    if (!isContentWord(w)) return;
    const key = w.toLowerCase();
    const s = uni.get(key);
    if (s) s.count += 1;
    else uni.set(key, { display: w, count: 1, firstAt: i });
  });
  if (uni.size === 0) return null;

  // Repeated content bigrams — a phrase beats two disjoint words.
  const bi = new Map<string, Scored>();
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i], b = words[i + 1];
    if (!isContentWord(a) || !isContentWord(b)) continue;
    const key = `${a.toLowerCase()} ${b.toLowerCase()}`;
    const s = bi.get(key);
    if (s) s.count += 1;
    else bi.set(key, { display: `${a} ${b}`, count: 1, firstAt: i });
  }

  // Rank: count desc, then earlier first mention (stable topics tend
  // to be stated up front).
  const rank = (m: Map<string, Scored>) =>
    [...m.values()].sort((x, y) => y.count - x.count || x.firstAt - y.firstAt);

  const parts: string[] = [];
  const used = new Set<string>();
  const pushPart = (display: string) => {
    const keyWords = display.toLowerCase().split(' ');
    if (keyWords.some((w) => used.has(w))) return;
    keyWords.forEach((w) => used.add(w));
    parts.push(display.split(' ').map(titleCase).join(' '));
  };

  // Lead with the strongest REPEATED bigram (count >= 2), then fill
  // with top unigrams not already covered by it.
  const topBigram = rank(bi).find((s) => s.count >= 2);
  if (topBigram) pushPart(topBigram.display);
  for (const s of rank(uni)) {
    if (parts.length >= 3) break;
    if (s.count < 2 && parts.length > 0) break;   // singletons only pad an empty title
    pushPart(s.display);
  }
  if (parts.length === 0) pushPart(rank(uni)[0].display);

  let title = `Meeting: ${parts.join(', ')}`;
  if (title.length > MAX_LEN) {
    title = title.slice(0, MAX_LEN - 1).replace(/[,\s]+\S*$/, '') || title.slice(0, MAX_LEN - 1);
    title = `${title}…`;
  }
  return title;
}
