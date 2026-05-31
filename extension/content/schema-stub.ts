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

// LinkedIn's CSS Modules build hashes class names per deploy, so any LLM
// discovery latches onto transient selectors (verified 2026-05 against a
// real /jobs/collections/recommended page). The `<ul>` itself only carries
// a hashed class — but every job card `<li>` keeps the stable
// `scaffold-layout__list-item` class and a `data-occludable-job-id`
// attribute LinkedIn uses for its own virtualisation. `:has()` lets us
// anchor on those, working around the hashed parent.
export const LINKEDIN_JOBS_STUB_SCHEMA: Schema = {
  fingerprint: 'linkedin:jobs:v1',
  layout: 'list',
  itemSetSelector: 'ul:has(> li[data-occludable-job-id])',
  itemSelector: 'li[data-occludable-job-id]',
  fields: {
    title: {
      kind: 'text',
      selector: '.job-card-list__title, .artdeco-entity-lockup__title, a[aria-label]',
    },
    company: {
      kind: 'text',
      selector:
        '.job-card-container__primary-description, .artdeco-entity-lockup__subtitle',
    },
    location: {
      kind: 'text',
      selector:
        '.job-card-container__metadata-wrapper, .job-card-container__metadata-item, .artdeco-entity-lockup__caption',
    },
    snippet: { kind: 'text', selector: '.job-card-container, .artdeco-entity-lockup' },
  },
  source: 'stub',
  discoveredAt: 0,
};

const ALL_STUBS: readonly Schema[] = [ROLECAST_STUB_SCHEMA, LINKEDIN_JOBS_STUB_SCHEMA];

/** Pick the first stub whose item-set selector matches the document. Returns
 *  null when nothing in our hand-written set fits. Slice 2 supplants this
 *  with detect.ts; Slice 3 with cache lookup + LLM. */
export function pickStubSchema(doc: Document = document): Schema | null {
  for (const schema of ALL_STUBS) {
    if (doc.querySelector(schema.itemSetSelector)) return schema;
  }
  return null;
}
