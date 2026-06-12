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

import { classify, detect, localizeItemSet } from './detect.js';
import { fingerprintItemSet } from './fingerprint.js';
import { distill } from '../background/llm.js';
import { isVolatileClass } from './stable-classes.js';
import type { FieldKind, LayoutKind, Schema } from '../shared/types.js';

/** Count an itemSelector's matches without throwing on a malformed string. */
function countMatches(root: ParentNode, selector: string): number {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

// --- Local price-field detection (user bug #2: Carousell "Price > 4000") ---
//
// Marketplace / listing pages put the price in a consistently-shaped element
// on every card ("HK$2,000", "$1,234.50", "€99"). Finding that element locally
// gives the numeric filter a real field WITHOUT an LLM call — the least
// invasive path to "Price > 4000" working out of the box. The engine's
// parseFirstNumber already reads comma-grouped currency strings.

/** Currency-marked amount: a recognizable currency token directly followed by
 *  a number. Deliberately requires the marker — a bare number ("3 days ago",
 *  "12 comments") must never be mistaken for a price. */
const CURRENCY_AMOUNT_RE =
  /(?:[A-Z]{0,3}\$|€|£|¥|₩|₹|USD|HKD|SGD|EUR|GBP|RMB?|CNY|JPY)\s*\d[\d,]*(?:\.\d+)?/;

/** Max descendants scanned per item — keeps the sweep cheap on huge cards. */
const PRICE_SCAN_CAP = 250;

function stableSelectorFor(el: Element): string | null {
  const classes = Array.from(el.classList).filter((c) => !isVolatileClass(c));
  if (classes.length === 0) return null;
  return `${el.tagName.toLowerCase()}.${classes.map((c) => CSS.escape(c)).join('.')}`;
}

/** Find a per-item selector whose element consistently carries a
 *  currency-formatted amount across the detected items. Returns null when no
 *  shape covers at least half the items (min 2) — a page without consistent
 *  prices gets no phantom number field. */
export function detectPriceField(
  itemSet: Element,
  itemSelector: string,
): { kind: FieldKind; selector: string } | null {
  let items: Element[];
  try {
    items = Array.from(itemSet.querySelectorAll(itemSelector)).filter(
      (el) => el.querySelector(itemSelector) === null,
    );
  } catch {
    return null;
  }
  if (items.length < 2) return null;

  // Innermost currency-bearing descendants, grouped by their stable selector.
  const coverage = new Map<string, number>();
  for (const item of items) {
    const seen = new Set<string>();
    const descendants = item.querySelectorAll('*');
    const cap = Math.min(descendants.length, PRICE_SCAN_CAP);
    for (let i = 0; i < cap; i++) {
      const el = descendants[i]!;
      const text = el.textContent ?? '';
      if (!CURRENCY_AMOUNT_RE.test(text)) continue;
      // Innermost only: an ancestor whose child also matches is a container.
      let childMatches = false;
      for (const child of el.children) {
        if (CURRENCY_AMOUNT_RE.test(child.textContent ?? '')) {
          childMatches = true;
          break;
        }
      }
      if (childMatches) continue;
      const sel = stableSelectorFor(el);
      if (sel) seen.add(sel);
    }
    for (const sel of seen) coverage.set(sel, (coverage.get(sel) ?? 0) + 1);
  }

  const required = Math.max(2, Math.ceil(items.length / 2));
  let best: string | null = null;
  let bestCount = 0;
  for (const [sel, count] of coverage) {
    if (count > bestCount) {
      best = sel;
      bestCount = count;
    }
  }
  if (best === null || bestCount < required) return null;

  // The engine reads the FIRST selector match per item — verify that first
  // match actually carries the amount on most covered items (a same-shaped
  // non-price sibling appearing first would silently misread every card).
  let firstMatchHits = 0;
  for (const item of items) {
    const el = item.querySelector(best);
    if (el && CURRENCY_AMOUNT_RE.test(el.textContent ?? '')) firstMatchHits++;
  }
  if (firstMatchHits < required) return null;

  return { kind: 'number', selector: best };
}

/** Build a schema from local detection alone — no LLM. Named text fields
 *  still require an LLM schema, but the free-text phrase filter
 *  (ALL_TEXT_FIELD) needs no fields at all, and a currency-bearing `price`
 *  field is detected locally so numeric filtering works without a key. Used
 *  both as the fallback when the LLM call fails or no key is set, and as the
 *  selector source when the LLM under-matches (returns a 1-card selector on
 *  a 25-card list). */
export function buildLocalSchema(doc: Document): DiscoverResult | null {
  const itemSet = detect(doc);
  if (!itemSet) return null;
  const local = localizeItemSet(itemSet);
  if (!local) return null;
  const fingerprint = fingerprintItemSet(itemSet);
  if (!fingerprint) return null;
  const schema: Schema = {
    fingerprint,
    layout: classify(itemSet),
    itemSetSelector: local.itemSetSelector,
    itemSelector: local.itemSelector,
    fields: {},
    source: 'local',
    discoveredAt: Date.now(),
  };
  const price = detectPriceField(itemSet, local.itemSelector);
  if (price) schema.fields['price'] = price;
  return { schema, itemSet };
}

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

  // Selector repair: LLMs frequently return an itemSelector that matches only
  // the one card they "saw" in the distilled DOM (the classic LinkedIn
  // "Detected: list · 1 item"). If a local generalization of the same detected
  // item-set captures more elements, swap the selectors in — keeping the LLM's
  // field mappings intact for named/numeric filters. Both counts are scoped
  // to the detected container so a leaf selector's lookalikes elsewhere on
  // the page can't tip the comparison toward an over-broad local selector.
  const local = localizeItemSet(itemSet);
  if (local && local.count > countMatches(itemSet, schema.itemSelector)) {
    schema.itemSetSelector = local.itemSetSelector;
    schema.itemSelector = local.itemSelector;
  }

  // Field repair: when the LLM didn't surface any numeric field but the
  // cards visibly carry a price, the local currency detector fills the gap —
  // otherwise the panel's numeric filter stays dark on exactly the
  // marketplace pages it was asked for (Carousell, bugs.md #2).
  const hasNumberField = Object.values(schema.fields).some((f) => f.kind === 'number');
  if (!hasNumberField) {
    const price = detectPriceField(itemSet, schema.itemSelector);
    if (price) schema.fields['price'] = price;
  }

  return { schema, itemSet };
}
