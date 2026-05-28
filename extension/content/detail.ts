// content/detail.ts — extract schema-defined fields from a detail page.
//
// Slice 5.3 closes the deep-path loop: the hidden tab spawned by
// deep-runner.ts (5.2) lands on a detail URL, runs this extractor over
// the schema's `detailFieldSelectors`, and posts the result back to
// the SW via `{t:'detailReady', fields}`.
//
// Pure, no side effects, no DOM mutation. The renderer never runs on
// detail pages (different layout fingerprint — no item-set detected),
// so this lives as a stand-alone extractor.

import type { Schema } from '../shared/types.js';

export type DetailFields = Record<string, string>;

/** Read every `schema.detailFieldSelectors` entry from `doc` and
 *  return a `{fieldName → text}` record. Missing or empty matches
 *  are omitted entirely (rather than emitting null/empty) so the
 *  engine on the host side can keep the "field absent → no info,
 *  skip filter" semantics it already has for list-page reads. */
export function extractDetailFields(
  schema: Schema,
  doc: Document = document,
): DetailFields {
  const out: DetailFields = {};
  const map = schema.detailFieldSelectors;
  if (!map) return out;
  for (const [name, selector] of Object.entries(map)) {
    const el = doc.querySelector(selector);
    const text = el?.textContent?.trim();
    if (text && text.length > 0) out[name] = text;
  }
  return out;
}

/** Heuristic for "is this a detail page or the list page?" The SW
 *  spawns hidden tabs for detail URLs only, so content's init() can
 *  trust the URL — but the same content script bundle ships to both
 *  list + detail pages. We pick detail when none of the schema's
 *  list selectors match. */
export function isDetailPage(schema: Schema, doc: Document = document): boolean {
  if (!schema.detailFieldSelectors) return false;
  // If the item-set is on the page, it's the list.
  if (doc.querySelector(schema.itemSetSelector)) return false;
  // Otherwise: detail page candidate. Confirm at least one detail
  // selector matches — guards against a totally unrelated URL.
  for (const selector of Object.values(schema.detailFieldSelectors)) {
    if (doc.querySelector(selector)) return true;
  }
  return false;
}
