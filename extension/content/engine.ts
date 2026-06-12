// content/engine.ts — pure per-item evaluation.
//
// The engine never touches the DOM beyond reading via `querySelector`. It
// takes a Schema + filters + the list of item Elements and returns one
// verdict per item. The renderer (renderer.ts) consumes verdicts and is the
// only thing that mutates the page.
//
// Slice 1: `containsAny` only. Slice 4.1: `regex` (compiled through the
// safe-compile guard), `lessThan`, `greaterThan`, `equals`, `oneOf`.
// Numeric predicates parse the first contiguous number out of the text
// (handles "$180k–$220k" → 180 for "lower bound" semantics — the panel
// surfaces this on the slider so users see what they're actually filtering
// against in 4.4).
//
// Composition (per BUILD_PLAN.md):
//   - Multiple filters AND together: an item passes only if every applicable
//     filter says "keep."
//   - Within a phrase list, OR: any one phrase matching is enough for the
//     containsAny predicate to fire.
//
// `keep` vs `exclude` polarity (positive filters land in 4.2 but the engine
// already handles both, so the renderer/panel never have to special-case):
//   exclude + match → filter out · keep + miss → filter out · else → pass.

import { safeCompileRegex } from '../shared/safe-regex.js';
import { ALL_TEXT_FIELD, type Filter, type ItemState, type Predicate, type Schema } from '../shared/types.js';

/** Collapse runs of whitespace so `textContent` from a multi-line card reads
 *  as one clean string for substring/regex matching. */
function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export interface ItemVerdict {
  state: ItemState;
  /** When `filtered`, a short reason — the phrase that matched, or the
   *  predicate op for non-text predicates. Used by the HIDDEN list (1.7). */
  reason?: string;
}

/** Per-item supplementary text (the fetched job/article description) keyed by
 *  the item Element. Folded into ALL_TEXT_FIELD matching so a keyword can hit
 *  text that isn't on the card itself (LinkedIn job descriptions). */
export type DetailText = ReadonlyMap<Element, string>;

/** Read a field's text content from an item. Returns null if the field isn't
 *  defined on the schema, the selector doesn't match, or the matched element
 *  has no text. Trimmed; further normalization is each predicate's job. */
function readField(
  item: Element,
  fieldName: string,
  schema: Schema,
  detailText?: DetailText,
): string | null {
  // Sentinel: match against the whole item's visible text PLUS any fetched
  // description text. Keeps the free-text phrase filter working regardless of
  // how well the schema's named fields map to the live DOM — the keyword just
  // has to appear anywhere on the card or in its (deep-fetched) description.
  if (fieldName === ALL_TEXT_FIELD) {
    const cardText = normalizeText(item.textContent ?? '');
    const extra = detailText?.get(item);
    const text = extra ? `${cardText} ${normalizeText(extra)}` : cardText;
    return text.length > 0 ? text : null;
  }
  const field = schema.fields[fieldName];
  if (!field) return null;
  const el = item.querySelector(field.selector);
  const text = el?.textContent?.trim();
  return text && text.length > 0 ? text : null;
}

interface PredicateOutcome {
  matched: boolean;
  /** The specific phrase that triggered the match — surfaced as the verdict
   *  reason. Undefined when not matched, or for predicates without a single
   *  identifiable trigger. */
  trigger?: string;
}

/** First contiguous number in `text` — handles "$180k–$220k" → 180, "1.5
 *  years" → 1.5, "HK$2,000" → 2000, "n/a" → null. Numeric predicates use
 *  this so the panel's slider in 4.4 can read against typical real-world
 *  strings. The k-suffix is deliberately NOT scaled — 4.4's slider relies
 *  on lower-bound + unit semantics. */
function parseFirstNumber(text: string): number | null {
  // The bare pattern stops at a thousands separator: "HK$2,000" read as 2
  // made "Price > 2000" silently pass everything on Carousell. Try a
  // comma-grouped match too; when both start at the same position the
  // grouped one is the same number written long, so it wins. An earlier
  // bare number ("5 items at HK$2,000" → 5) still takes priority — first
  // contiguous number wins.
  const grouped = text.match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?/);
  const bare = text.match(/-?\d+(?:\.\d+)?/);
  let raw: string | null = null;
  if (grouped && (!bare || (grouped.index ?? 0) <= (bare.index ?? 0))) {
    raw = grouped[0].replace(/,/g, '');
  } else if (bare) {
    raw = bare[0];
  }
  if (raw === null) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function evalPredicate(text: string, pred: Predicate): PredicateOutcome {
  switch (pred.op) {
    case 'containsAny': {
      // Case-insensitive substring across the phrase list. Phrases are
      // user-typed in 1.6; we lowercase once per call rather than per phrase.
      const haystack = text.toLowerCase();
      // Whitespace-squashed fallback: marketplace listings split words
      // ("Mac Book") that users type joined ("macbook"), and vice versa.
      // Removing ALL whitespace from both sides can only merge words, so
      // it adds no cross-word false positives beyond what plain substring
      // already allows ("so up" → "soup" is accepted collateral). Computed
      // lazily so phrase-free or plain-hit evaluations never pay for it.
      let squashed: string | null = null;
      for (const phrase of pred.phrases) {
        if (phrase.length === 0) continue;
        const needle = phrase.toLowerCase();
        if (haystack.includes(needle)) {
          return { matched: true, trigger: phrase };
        }
        const squashedNeedle = needle.replace(/\s+/g, '');
        if (squashedNeedle.length === 0) continue;
        squashed ??= haystack.replace(/\s+/g, '');
        if (squashed.includes(squashedNeedle)) {
          return { matched: true, trigger: phrase };
        }
      }
      return { matched: false };
    }
    case 'regex': {
      // safeCompileRegex throws UnsafeRegexError on length cap or nested
      // quantifier — propagate up so the panel can surface the typed error
      // (4.1 gate). RegExp.exec returns the match or null.
      const re = safeCompileRegex(pred.pattern, pred.flags);
      const match = re.exec(text);
      return match ? { matched: true, trigger: match[0] } : { matched: false };
    }
    case 'lessThan': {
      const n = parseFirstNumber(text);
      return n !== null && n < pred.value
        ? { matched: true, trigger: `${n} < ${pred.value}` }
        : { matched: false };
    }
    case 'greaterThan': {
      const n = parseFirstNumber(text);
      return n !== null && n > pred.value
        ? { matched: true, trigger: `${n} > ${pred.value}` }
        : { matched: false };
    }
    case 'equals': {
      // Strict-string compare — typed-literal predicate values get
      // stringified once. Booleans become "true"/"false"; numbers via
      // String(n). The text comes from readField's trim, so an exact
      // match is meaningful.
      const target = typeof pred.value === 'string' ? pred.value : String(pred.value);
      return text === target ? { matched: true, trigger: target } : { matched: false };
    }
    case 'oneOf': {
      for (const v of pred.values) {
        const target = typeof v === 'string' ? v : String(v);
        if (text === target) return { matched: true, trigger: target };
      }
      return { matched: false };
    }
  }
}

/** Evaluate every item against every applicable filter and return one
 *  verdict per item. Pure: no DOM mutation, no logging, no message
 *  dispatch. */
export function evaluate(
  schema: Schema,
  items: Iterable<Element>,
  filters: readonly Filter[],
  detailText?: DetailText,
): Map<Element, ItemVerdict> {
  const out = new Map<Element, ItemVerdict>();

  // Only filters bound to this schema's fingerprint apply. Cross-fingerprint
  // filters can land in storage (saved-filter reapplication, 4.5) but the
  // engine ignores them here.
  const applicable = filters.filter((f) => f.fingerprint === schema.fingerprint);

  for (const item of items) {
    let verdict: ItemVerdict = { state: 'passing' };

    for (const filter of applicable) {
      const text = readField(item, filter.field, schema, detailText);
      // Missing fields can't decide the filter — treat as "no information,"
      // skip. (Slice 4.5 may revisit for `keep` filters that should default
      // to exclude on missing data.)
      if (text === null) continue;

      const outcome = evalPredicate(text, filter.predicate);
      const excludes =
        (filter.polarity === 'exclude' && outcome.matched) ||
        (filter.polarity === 'keep' && !outcome.matched);

      if (excludes) {
        verdict = {
          state: 'filtered',
          reason: outcome.trigger ?? filter.predicate.op,
        };
        // First-match-wins: the reason that surfaces is the first filter
        // that ruled the item out. Cheap and the user can iterate by
        // removing the surfaced phrase.
        break;
      }
    }

    out.set(item, verdict);
  }

  return out;
}

/** Helper: resolve the item-set + items from a schema against a document. */
export function findItems(
  schema: Schema,
  doc: Document = document,
  knownItemSet?: Element,
): Element[] {
  // itemSelector is rooted at the document (BUILD_PLAN states it's a CSS
  // selector matching repeating items within the set). The set selector is
  // captured separately so callers can hang `mode-hide` on the container.
  // Scope to the item-set container when it resolves — a too-generic
  // itemSelector (LLM- or locally-derived) must never pick up lookalike
  // elements elsewhere on the page (github.com header decorations matched
  // a bare-div selector document-wide).
  //
  // The set selector may NOT be unique (YouTube's watch page: 4 matches and
  // the real container wasn't first — first-match scoping mounted with 0
  // items while 20 sat in the right one). A caller that already holds the
  // detected container passes it; otherwise pick the candidate that
  // actually contains item matches.
  const root: ParentNode = knownItemSet ?? bestRoot(schema, doc);
  const matches = Array.from(root.querySelectorAll(schema.itemSelector));
  // On table-layout pages (HN is one giant nested table) a generic local
  // selector like `tr` matches layout rows that CONTAIN the real story
  // rows. Treating an ancestor as an item is catastrophic: its textContent
  // aggregates every nested item, one phrase match "filters" it, and
  // hiding it blanks the whole page. An element with a nested match is a
  // container, never an item — keep only the innermost matches.
  return matches.filter((el) => el.querySelector(schema.itemSelector) === null);
}

function bestRoot(schema: Schema, doc: Document): ParentNode {
  let candidates: Element[];
  try {
    candidates = Array.from(doc.querySelectorAll(schema.itemSetSelector));
  } catch {
    return doc;
  }
  if (candidates.length === 0) return doc;
  if (candidates.length === 1) return candidates[0]!;
  let best: Element | null = null;
  let bestCount = 0;
  for (const c of candidates) {
    const n = c.querySelectorAll(schema.itemSelector).length;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best ?? candidates[0]!;
}
