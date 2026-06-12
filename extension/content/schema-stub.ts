// content/schema-stub.ts — Slice-1 stand-in for LLM discovery.
//
// One hand-written Schema for fixtures/rolecast.html and any other page that
// matches the same shape. Slice 3 replaces this with cache lookup → LLM call;
// keep the matching logic structured the same way (heuristic → Schema) so the
// swap is mechanical.
//
// Mirror of fixtures/rolecast.schema.json — the JSON file documents the
// expected shape for humans; this TS constant is the runtime source of truth.

import type { Schema } from '../shared/types.js';

export const ROLECAST_STUB_SCHEMA: Schema = {
  fingerprint: 'fixture:rolecast:v1',
  layout: 'list',
  itemSetSelector: '.joblist',
  itemSelector: '.joblist > .job',
  fields: {
    title: { kind: 'text', selector: '.title' },
    company: { kind: 'text', selector: '.company' },
    location: { kind: 'text', selector: '.location' },
    snippet: { kind: 'text', selector: '.snippet' },
    // 4.4 needs a number field for the slider editor; engine's
    // parseFirstNumber reads "$180k–$220k" → 180 (lower-bound semantics).
    comp: { kind: 'number', selector: '.comp' },
  },
  source: 'stub',
  discoveredAt: 0,
};

/** LinkedIn jobs — NEW layout (2026-06 redeploy on `/jobs/search-results/`).
 *  LinkedIn rebuilt the list as a virtualized LazyColumn of <div role="button">
 *  cards keyed by a `componentkey="job-card-component-ref-<jobId>"` attribute;
 *  the old <ul>/<li class="scaffold-layout__list-item"> structure is gone on
 *  this URL pattern. The OUTER (role=button) element is unique per job — the
 *  inner content wrapper carries the same componentkey, which is why a plain
 *  `[componentkey^="job-card-component-ref-"]` returns 2× the card count. */
export const LINKEDIN_JOBS_NEW_STUB: Schema = {
  fingerprint: 'site:linkedin:jobs:v2',
  layout: 'list',
  itemSetSelector: '[componentkey="SearchResultsMainContent"]',
  itemSelector:
    '[componentkey="SearchResultsMainContent"] [role="button"][componentkey^="job-card-component-ref-"]',
  fields: {},
  // The LazyColumn is React-reconciled per row: the wrap renderer's
  // `.filt` wrappers get silently reverted on the next render pass
  // (memory.md 2026-06-06). Detached mode mutates only class/data attrs
  // on the card itself, which React's row re-render tolerates.
  renderMode: 'detached',
  source: 'stub',
  discoveredAt: 0,
};

/** LinkedIn jobs — LEGACY layout still served on `/jobs/search/?…` and
 *  `/jobs/collections/recommended` as of 2026-06. The repeated-structure
 *  heuristic was unreliable here (virtualized list + per-card occlusion
 *  class fragments the signature groups), so we kept a deterministic rule.
 *  `li.scaffold-layout__list-item` is the stable per-card class; `:has()`
 *  scopes the set selector to the results <ul>. Empty fields — free-text
 *  + deep-text matches whole-card and fetched-description text. */
export const LINKEDIN_JOBS_STUB: Schema = {
  fingerprint: 'site:linkedin:jobs:v1',
  layout: 'list',
  itemSetSelector: 'ul:has(> li.scaffold-layout__list-item)',
  itemSelector: 'li.scaffold-layout__list-item',
  fields: {},
  source: 'stub',
  discoveredAt: 0,
};

interface StubEntry {
  schema: Schema;
  /** When set, the stub only applies on hosts whose hostname includes this
   *  substring — keeps a site-specific selector from firing elsewhere. */
  hostIncludes?: string;
}

const ALL_STUBS: readonly StubEntry[] = [
  { schema: ROLECAST_STUB_SCHEMA },
  // The NEW LazyColumn layout must win over the legacy <ul>/<li> stub when
  // both happen to be on the page — the new container is only present on
  // /jobs/search-results/, the old <ul> is only present on /jobs/search/,
  // but probing the new one first is cheap and future-proofs the order
  // against pages that briefly carry both during a SPA transition.
  { schema: LINKEDIN_JOBS_NEW_STUB, hostIncludes: 'linkedin.' },
  { schema: LINKEDIN_JOBS_STUB, hostIncludes: 'linkedin.' },
];

/** Pick the first stub whose item-set selector matches the document (and whose
 *  host gate, if any, matches). Returns null when nothing fits — the caller
 *  then falls back to detect()/LLM discovery. Site stubs win because they're
 *  deterministic where the heuristic is fragile (virtualized / SPA lists). */
export function pickStubSchema(doc: Document = document): Schema | null {
  const host = doc.defaultView?.location?.hostname ?? '';
  for (const { schema, hostIncludes } of ALL_STUBS) {
    if (hostIncludes && !host.includes(hostIncludes)) continue;
    try {
      if (doc.querySelector(schema.itemSetSelector)) return schema;
    } catch {
      // `:has()` (or any selector) unsupported in this engine — skip the stub.
    }
  }
  return null;
}
