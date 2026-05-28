// content/discover.ts — content-side discovery orchestrator.
//
// Wiring: detect the candidate item-set on the live DOM, fingerprint it,
// distill it, ask the SW for a Schema (cache hit or LLM call). Returns the
// Schema + the item-set Element so the caller can hand both to the engine
// + renderer in one step.
//
// `fetchSchema` is **injected**. Production wires it to a chrome.runtime
// .sendMessage round-trip to the SW (which calls `getOrDiscover` from
// background/cache.ts). Tests inject a fake that calls `getOrDiscover`
// directly with an in-memory cache + a counted mock fetcher so the "first
// call = 1 LLM hit, second = 0" gate is observable without standing up the
// full chrome.runtime bus.
//
// Hint forwarding (3.5): `discover()` takes an optional `hint`; it's
// passed straight through to the SW request and onward to the prompt.

import { classify, detect } from './detect.js';
import { fingerprintItemSet } from './fingerprint.js';
import { distill } from '../background/llm.js';
import type { LayoutKind, Schema } from '../shared/types.js';

export interface DiscoverFetchRequest {
  fingerprint: string;
  distilled: string;
  layout: LayoutKind;
  hint?: string;
  /** Re-discover: bypass cache, always call LLM. Slice 3.5. */
  force?: boolean;
}

export interface DiscoverOptions {
  hint?: string;
  force?: boolean;
}

export interface DiscoverContext {
  /** SW round-trip — the only side-effecting dependency. Default-less so
   *  the production wiring (Slice 3.4) is explicit at every call site. */
  fetchSchema: (req: DiscoverFetchRequest) => Promise<Schema>;
}

export interface DiscoverResult {
  schema: Schema;
  itemSet: Element;
}

/** Detect → fingerprint → distill → ask the SW for a Schema. Returns
 *  `null` if the page has no detectable item-set (the panel surfaces this
 *  as "no detection on this page" in Slice 3.4).
 *
 *  Pass `{ hint }` to feed a user correction into the prompt (Slice 3.5).
 *  Pass `{ force: true }` to bypass cache and force a fresh LLM call —
 *  used by the panel's "Re-discover" button. */
export async function discover(
  doc: Document,
  ctx: DiscoverContext,
  opts: DiscoverOptions = {},
): Promise<DiscoverResult | null> {
  const itemSet = detect(doc);
  if (!itemSet) return null;

  const fingerprint = fingerprintItemSet(itemSet);
  if (!fingerprint) return null;

  const layout = classify(itemSet);
  const distilled = distill(itemSet);

  const req: DiscoverFetchRequest = { fingerprint, distilled, layout };
  if (opts.hint !== undefined) req.hint = opts.hint;
  if (opts.force === true) req.force = true;

  const schema = await ctx.fetchSchema(req);
  return { schema, itemSet };
}
