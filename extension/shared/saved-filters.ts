// shared/saved-filters.ts — persistent filter sets.
//
// Filters are ephemeral by default (Slice 1): typing a phrase in the
// panel sends it to content, but closing the browser drops it. 4.5 adds
// `saved` filters — written to `chrome.storage.sync` so they ride along
// with the user's profile and auto-apply when they next land on a page
// with the same fingerprint.
//
// Storage shape: one key per fingerprint, `nf:filters:<fp> → Filter[]`.
// Per-fp keys mean a single-fingerprint clear is one call; the whole
// store is still under sync's 100 KB cap. Sync quota per-item is 8 KB
// — comfortably more than a hand-curated filter set for one layout.
//
// `chrome.storage.sync` is the right surface (vs `local`): the user
// expects their hand-curated filters to follow them between machines.
// LLM keys go to `local` for the opposite reason — see shared/settings.ts.
//
// The Filter type already carries `saved: boolean`. We write each
// persisted filter with `saved: true` so the panel can render a
// per-filter "saved" indicator without a parallel data structure.

import type { Filter } from './types.js';

const KEY_PREFIX = 'nf:filters:';

function keyFor(fingerprint: string): string {
  return KEY_PREFIX + fingerprint;
}

/** Shape-validate a filter object pulled from storage or an import file.
 *  Storage is shared with the user's other devices and the schema may have
 *  shifted — we drop anything that doesn't match the current contract
 *  rather than let invalid filters land in the engine. Exported so the
 *  panel's import path can validate BEFORE writing (saveFilters itself
 *  writes whatever it's given). */
export function isFilterShape(x: unknown): x is Filter {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  if (typeof r['id'] !== 'string') return false;
  if (typeof r['fingerprint'] !== 'string') return false;
  if (r['polarity'] !== 'exclude' && r['polarity'] !== 'keep') return false;
  if (typeof r['field'] !== 'string') return false;
  if (typeof r['predicate'] !== 'object' || r['predicate'] === null) return false;
  if (typeof r['deep'] !== 'boolean') return false;
  if (typeof r['saved'] !== 'boolean') return false;
  return true;
}

export async function loadSavedFilters(fingerprint: string): Promise<Filter[]> {
  const key = keyFor(fingerprint);
  const r = await chrome.storage.sync.get(key);
  const raw = r[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isFilterShape);
}

export async function saveFilters(fingerprint: string, filters: Filter[]): Promise<void> {
  // Stamp `saved: true` on the way in so the round-trip is idempotent
  // and the panel can render the "saved" badge from the filter shape
  // alone.
  const saved: Filter[] = filters.map((f) => ({ ...f, saved: true }));
  await chrome.storage.sync.set({ [keyFor(fingerprint)]: saved });
}

export async function clearSavedFilters(fingerprint: string): Promise<void> {
  await chrome.storage.sync.remove(keyFor(fingerprint));
}
