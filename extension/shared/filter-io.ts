// shared/filter-io.ts — export / import of saved filter sets.
//
// 6.3 closes the device-portability loop. The user can grab a JSON
// dump of their saved filters (keyed by fingerprint) and load it on
// another machine — useful when the storage.sync round-trip is slow
// (or when the user doesn't want cross-device sync at all).
//
// Format: a single envelope object so future format changes don't
// require sniffing.
//
//   { v: 1, exportedAt: <ms>, sets: { "<fp>": Filter[] } }
//
// We don't ship per-filter validation here — the panel routes
// imports back through saveFilters() which runs the same shape
// validation as the boot read in shared/saved-filters.ts.

import type { Filter } from './types.js';

export const FILTER_EXPORT_VERSION = 1 as const;

export interface FilterExportV1 {
  v: typeof FILTER_EXPORT_VERSION;
  exportedAt: number;
  sets: Record<string, Filter[]>;
}

export interface FilterImportResult {
  /** Number of fingerprints / sets imported. */
  setsImported: number;
  /** Sum of filter rows across all sets. */
  filtersImported: number;
  /** Soft errors per set — shape failures, unknown ops, etc. */
  warnings: string[];
}

/** Storage-shape: stringify the export envelope to be written by a
 *  Blob download. */
export function serializeExport(
  sets: Record<string, Filter[]>,
  now: number,
): string {
  const env: FilterExportV1 = {
    v: FILTER_EXPORT_VERSION,
    exportedAt: now,
    sets,
  };
  return JSON.stringify(env, null, 2);
}

/** Parse a JSON string back into an envelope. Throws on malformed
 *  input — callers surface a user-facing error rather than silently
 *  ignoring the import. */
export function parseExport(raw: string): FilterExportV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`import: not valid JSON — ${err instanceof Error ? err.message : err}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('import: top-level value is not an object');
  }
  const r = parsed as Record<string, unknown>;
  if (r['v'] !== FILTER_EXPORT_VERSION) {
    throw new Error(`import: unsupported version ${String(r['v'])}`);
  }
  if (typeof r['sets'] !== 'object' || r['sets'] === null) {
    throw new Error('import: missing "sets" object');
  }
  const sets = r['sets'] as Record<string, unknown>;
  const out: Record<string, Filter[]> = {};
  for (const [fp, value] of Object.entries(sets)) {
    if (!Array.isArray(value)) continue;
    out[fp] = value as Filter[];
  }
  return {
    v: FILTER_EXPORT_VERSION,
    exportedAt: typeof r['exportedAt'] === 'number' ? r['exportedAt'] : 0,
    sets: out,
  };
}
