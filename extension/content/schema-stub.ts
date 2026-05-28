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

const ALL_STUBS: readonly Schema[] = [ROLECAST_STUB_SCHEMA];

/** Pick the first stub whose item-set selector matches the document. Returns
 *  null when nothing in our hand-written set fits. Slice 2 supplants this
 *  with detect.ts; Slice 3 with cache lookup + LLM. */
export function pickStubSchema(doc: Document = document): Schema | null {
  for (const schema of ALL_STUBS) {
    if (doc.querySelector(schema.itemSetSelector)) return schema;
  }
  return null;
}
