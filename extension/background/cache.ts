// background/cache.ts — schemaCache + the cache-aware discovery orchestrator.
//
// Per BUILD_PLAN module map: this file eventually also holds filterStore
// (storage.sync, Slice 4.5) and detailCache (storage.local, Slice 5). Slice
// 3.3 lands just the schemaCache + the get-or-LLM orchestrator that wraps it.
//
// Layered shape on purpose:
//   - `SchemaCache` is the storage interface (get/set, async).
//   - `chromeStorageSchemaCache()` is the production impl (storage.local).
//   - `memorySchemaCache()` is a Map-backed test double; no real cache file
//     pretends to be one (test reliability beats one extra surface).
//   - `getOrDiscover()` is the orchestrator — cache hit returns the cached
//     Schema verbatim (no LLM call); cache miss calls
//     `llm.discoverSchema()`, writes the result, returns it. Everything it
//     touches comes in via `deps` so tests can count fetcher invocations
//     without standing up chrome.storage or the real provider.

import type { Schema } from '../shared/types.js';
import { discoverSchema as llmDiscoverSchema, type Provider } from './llm.js';

export interface SchemaCache {
  get(fingerprint: string): Promise<Schema | null>;
  set(fingerprint: string, schema: Schema): Promise<void>;
}

const STORAGE_KEY_PREFIX = 'nf:schema:';
const storageKey = (fingerprint: string): string => `${STORAGE_KEY_PREFIX}${fingerprint}`;

/** Production impl: persistent per-device cache in `chrome.storage.local`.
 *  Survives SW termination (that's the whole point — Slice-3 cache hits must
 *  survive the service worker dying between page visits). */
export function chromeStorageSchemaCache(): SchemaCache {
  return {
    async get(fingerprint) {
      const key = storageKey(fingerprint);
      const result = await chrome.storage.local.get([key]);
      const value = result[key];
      return value && typeof value === 'object' ? (value as Schema) : null;
    },
    async set(fingerprint, schema) {
      await chrome.storage.local.set({ [storageKey(fingerprint)]: schema });
    },
  };
}

/** Test impl: in-process Map. Discarded between specs by virtue of the
 *  factory creating a fresh Map per call. */
export function memorySchemaCache(): SchemaCache {
  const store = new Map<string, Schema>();
  return {
    async get(fingerprint) {
      return store.get(fingerprint) ?? null;
    },
    async set(fingerprint, schema) {
      store.set(fingerprint, schema);
    },
  };
}

export interface DiscoverSettings {
  provider: Provider;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export interface DiscoverRequest {
  fingerprint: string;
  distilled: string;
  /** User correction hint, forwarded to the LLM prompt (Slice 3.5). */
  hint?: string;
  /** Re-discover (Slice 3.5): skip the cache read; always call the LLM.
   *  Cache is still **written** on success — so the next non-forced lookup
   *  reads the new value. Use case: the user typed a hint to correct a
   *  bad schema and clicked "Re-discover". */
  force?: boolean;
}

export interface GetOrDiscoverDeps {
  cache: SchemaCache;
  loadSettings: () => Promise<DiscoverSettings>;
  /** Override the LLM call entirely (rarely useful — tests usually pass
   *  `fetcher` instead so the prompt-build path is exercised). */
  llm?: typeof llmDiscoverSchema;
  /** Injected into the LLM call's `fetcher`. Default uses globalThis.fetch
   *  via the underlying discoverSchema. */
  fetcher?: typeof fetch;
  /** Injected into the LLM call's `now`. Default uses Date.now. */
  now?: () => number;
}

/** Cache-aware discovery. Cache **hit** → return the cached Schema
 *  unchanged (source stays 'llm'; the cache is transport, not provenance).
 *  Cache **miss** → call the LLM, persist, return. Errors from the LLM call
 *  propagate (the caller decides whether to surface them — Slice 6.4
 *  re-teach prompt). */
export async function getOrDiscover(
  req: DiscoverRequest,
  deps: GetOrDiscoverDeps,
): Promise<Schema> {
  if (!req.force) {
    const cached = await deps.cache.get(req.fingerprint);
    if (cached) return cached;
  }

  const settings = await deps.loadSettings();
  const llm = deps.llm ?? llmDiscoverSchema;
  const llmOpts: Parameters<typeof llmDiscoverSchema>[1] = {
    provider: settings.provider,
    apiKey: settings.apiKey,
    fingerprint: req.fingerprint,
  };
  if (settings.model !== undefined) llmOpts.model = settings.model;
  if (settings.baseUrl !== undefined) llmOpts.baseUrl = settings.baseUrl;
  if (req.hint !== undefined) llmOpts.hint = req.hint;
  if (deps.fetcher !== undefined) llmOpts.fetcher = deps.fetcher;
  if (deps.now !== undefined) llmOpts.now = deps.now;

  const schema = await llm(req.distilled, llmOpts);
  await deps.cache.set(req.fingerprint, schema);
  return schema;
}
