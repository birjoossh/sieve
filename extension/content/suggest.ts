// content/suggest.ts — local, zero-network phrase suggestions derived from the
// detected items themselves. Replaces the LLM as the panel's suggestion source
// (user bug #1: suggestions must come from the current page). Pure function:
// no DOM mutation, no chrome.*, so it's unit-testable through the testbed and
// adds nothing to the privacy surface — no payload ever leaves the browser.

// Scoring is discriminative document frequency: a phrase is interesting when
// it appears on SOME cards but not all of them. A token present on (nearly)
// every card is layout chrome ("Save", "Apply", the site name), not content —
// hence the 60% ceiling. A token on a single card can't separate anything —
// hence the floor of 2.
const MIN_ITEMS = 2;
const MAX_ITEM_FRACTION = 0.6;
const MIN_UNIGRAM_LEN = 4;
const MIN_BIGRAM_WORD_LEN = 3;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'are', 'this', 'that', 'from', 'will',
  'have', 'has', 'had', 'was', 'were', 'been', 'being', 'but', 'not', 'all',
  'any', 'can', 'our', 'your', 'their', 'they', 'them', 'then', 'than',
  'when', 'where', 'what', 'which', 'who', 'why', 'how', 'its', 'his', 'her',
  'she', 'him', 'out', 'into', 'over', 'more', 'most', 'some', 'such',
  'only', 'also', 'just', 'very', 'about', 'after', 'before', 'between',
  'each', 'other', 'there', 'here', 'while', 'during', 'both', 'per', 'via',
]);

interface CandidateStats {
  /** Distinct items containing the candidate. */
  docCount: number;
  /** Original-casing forms seen, with occurrence counts. Insertion order is
   *  first-seen, which breaks ties deterministically. */
  forms: Map<string, number>;
  isBigram: boolean;
}

function isPureNumber(word: string): boolean {
  return /^\d+$/.test(word);
}

function isLettersOnly(word: string): boolean {
  return /^[a-zA-Z]+$/.test(word);
}

/** Suggest negative-filter phrases from the page's own detected items.
 *  `detailText` is the deep-text map (fetched descriptions) when available;
 *  `existing` phrases are excluded case-insensitively. Returns at most `max`
 *  phrases in their most common original casing, deterministically ordered:
 *  document-frequency desc, bigrams before unigrams, then alphabetical. */
export function suggestFromItems(
  items: readonly Element[],
  detailText: ReadonlyMap<Element, string> | undefined,
  existing: readonly string[],
  max = 8,
): string[] {
  if (items.length < MIN_ITEMS) return [];
  const excluded = new Set(existing.map((p) => p.trim().toLowerCase()));
  const stats = new Map<string, CandidateStats>();

  const record = (key: string, form: string, isBigram: boolean, seenThisItem: Set<string>): void => {
    let s = stats.get(key);
    if (!s) {
      s = { docCount: 0, forms: new Map(), isBigram };
      stats.set(key, s);
    }
    if (!seenThisItem.has(key)) {
      seenThisItem.add(key);
      s.docCount += 1;
    }
    s.forms.set(form, (s.forms.get(form) ?? 0) + 1);
  };

  for (const item of items) {
    const base = (item.textContent ?? '').replace(/\s+/g, ' ').trim();
    const detail = detailText?.get(item);
    const corpus = detail ? `${base} ${detail.replace(/\s+/g, ' ').trim()}` : base;
    const words = corpus.match(/[a-zA-Z0-9]+/g) ?? [];
    const seen = new Set<string>();

    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      const lw = w.toLowerCase();

      if (
        isLettersOnly(w) &&
        w.length >= MIN_UNIGRAM_LEN &&
        !STOPWORDS.has(lw) &&
        !excluded.has(lw)
      ) {
        record(lw, w, false, seen);
      }

      const next = words[i + 1];
      if (next === undefined) continue;
      const lnext = next.toLowerCase();
      if (
        w.length >= MIN_BIGRAM_WORD_LEN &&
        next.length >= MIN_BIGRAM_WORD_LEN &&
        !isPureNumber(w) &&
        !isPureNumber(next) &&
        !STOPWORDS.has(lw) &&
        !STOPWORDS.has(lnext)
      ) {
        const key = `${lw} ${lnext}`;
        if (!excluded.has(key)) record(key, `${w} ${next}`, true, seen);
      }
    }
  }

  const ceiling = Math.floor(items.length * MAX_ITEM_FRACTION);
  const kept = [...stats.entries()].filter(
    ([, s]) => s.docCount >= MIN_ITEMS && s.docCount <= ceiling,
  );
  kept.sort(([ka, a], [kb, b]) => {
    if (a.docCount !== b.docCount) return b.docCount - a.docCount;
    if (a.isBigram !== b.isBigram) return a.isBigram ? -1 : 1;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return kept.slice(0, max).map(([, s]) => {
    let bestForm = '';
    let bestCount = -1;
    for (const [form, count] of s.forms) {
      // Strictly-greater keeps the first-seen form on ties — deterministic
      // across calls because Map preserves insertion order.
      if (count > bestCount) {
        bestForm = form;
        bestCount = count;
      }
    }
    return bestForm;
  });
}
