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
import type { Filter, ItemState, Predicate, Schema } from '../shared/types.js';

export interface ItemVerdict {
  state: ItemState;
  /** When `filtered`, a short reason — the phrase that matched, or the
   *  predicate op for non-text predicates. Used by the HIDDEN list (1.7). */
  reason?: string;
}

/** Read a field's text content from an item. Returns null if the field isn't
 *  defined on the schema, the selector doesn't match, or the matched element
 *  has no text. Trimmed; further normalization is each predicate's job. */
function readField(item: Element, fieldName: string, schema: Schema): string | null {
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
 *  years" → 1.5, "n/a" → null. Numeric predicates use this so the panel's
 *  slider in 4.4 can read against typical real-world strings. */
function parseFirstNumber(text: string): number | null {
  const m = text.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

function evalPredicate(text: string, pred: Predicate): PredicateOutcome {
  switch (pred.op) {
    case 'containsAny': {
      // Case-insensitive substring across the phrase list. Phrases are
      // user-typed in 1.6; we lowercase once per call rather than per phrase.
      const haystack = text.toLowerCase();
      for (const phrase of pred.phrases) {
        if (phrase.length === 0) continue;
        if (haystack.includes(phrase.toLowerCase())) {
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
): Map<Element, ItemVerdict> {
  const out = new Map<Element, ItemVerdict>();

  // Only filters bound to this schema's fingerprint apply. Cross-fingerprint
  // filters can land in storage (saved-filter reapplication, 4.5) but the
  // engine ignores them here.
  const applicable = filters.filter((f) => f.fingerprint === schema.fingerprint);

  for (const item of items) {
    let verdict: ItemVerdict = { state: 'passing' };

    for (const filter of applicable) {
      const text = readField(item, filter.field, schema);
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
export function findItems(schema: Schema, doc: Document = document): Element[] {
  // itemSelector is rooted at the document (BUILD_PLAN states it's a CSS
  // selector matching repeating items within the set). The set selector is
  // captured separately so callers can hang `mode-hide` on the container.
  return Array.from(doc.querySelectorAll(schema.itemSelector));
}
