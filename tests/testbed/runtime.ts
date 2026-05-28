// tests/testbed/runtime.ts — bundled "page-runtime" exposed on window.__nf so
// Playwright specs can poke the content-script internals without standing up
// a full extension context.
//
// Bundled by esbuild into dist/testbed/runtime.js (IIFE). Tests add it via
// page.addScriptTag({ path: 'dist/testbed/runtime.js' }). The production
// content script stays untouched; this is a pure test seam.
//
// As Slice-1 modules land (engine → renderer → ...), surface them here so
// later specs can reuse the same testbed instead of inventing per-task
// scaffolding.

import {
  chromeStorageSchemaCache,
  getOrDiscover,
  memorySchemaCache,
} from '../../extension/background/cache.js';
import {
  discoverSchema,
  distill,
  SchemaParseError,
  suggestPhrases,
} from '../../extension/background/llm.js';
import {
  checkLedger,
  incrementLedger,
  memorySpendChecker,
  rollLedger,
  SpendCapError,
  type SpendChecker,
  type SpendCaps,
  type SpendLedger,
} from '../../extension/background/spend.js';
import {
  memoryQueueIO,
  PersistentQueue,
  QUEUE_INTERNALS,
} from '../../extension/background/queue.js';
import { runOne } from '../../extension/background/deep-runner.js';
import { Throttler } from '../../extension/background/throttle.js';
import { extractDetailFields, isDetailPage } from '../../extension/content/detail.js';
import { ViewportEnqueuer } from '../../extension/content/viewport-enqueuer.js';
import { safeCompileRegex, UnsafeRegexError } from '../../extension/shared/safe-regex.js';
import { discover } from '../../extension/content/discover.js';
import { renderPageStatus } from '../../extension/panel/components/page-status.js';
import { classify, detect, generalize } from '../../extension/content/detect.js';
import { evaluate, findItems, type ItemVerdict } from '../../extension/content/engine.js';
import { fingerprintItemSet } from '../../extension/content/fingerprint.js';
import { Picker } from '../../extension/content/picker.js';
import { Renderer } from '../../extension/content/renderer.js';
import {
  pickStubSchema,
  ROLECAST_STUB_SCHEMA,
} from '../../extension/content/schema-stub.js';
import type { Filter, Schema } from '../../extension/shared/types.js';

interface TestbedAPI {
  chromeStorageSchemaCache: typeof chromeStorageSchemaCache;
  classify: typeof classify;
  detect: typeof detect;
  discover: typeof discover;
  discoverSchema: typeof discoverSchema;
  distill: typeof distill;
  evaluate: typeof evaluate;
  findItems: typeof findItems;
  fingerprintItemSet: typeof fingerprintItemSet;
  generalize: typeof generalize;
  getOrDiscover: typeof getOrDiscover;
  memorySchemaCache: typeof memorySchemaCache;
  renderPageStatus: typeof renderPageStatus;
  safeCompileRegex: typeof safeCompileRegex;
  SchemaParseError: typeof SchemaParseError;
  UnsafeRegexError: typeof UnsafeRegexError;
  Picker: typeof Picker;
  pickStubSchema: typeof pickStubSchema;
  Renderer: typeof Renderer;
  ROLECAST_STUB_SCHEMA: Schema;
  checkLedger: typeof checkLedger;
  incrementLedger: typeof incrementLedger;
  memorySpendChecker: typeof memorySpendChecker;
  rollLedger: typeof rollLedger;
  SpendCapError: typeof SpendCapError;
  suggestPhrases: typeof suggestPhrases;
  memoryQueueIO: typeof memoryQueueIO;
  PersistentQueue: typeof PersistentQueue;
  QUEUE_INTERNALS: typeof QUEUE_INTERNALS;
  runOne: typeof runOne;
  Throttler: typeof Throttler;
  extractDetailFields: typeof extractDetailFields;
  isDetailPage: typeof isDetailPage;
  ViewportEnqueuer: typeof ViewportEnqueuer;
  /** Convenience for tests: returns the count of each verdict state. */
  tallyVerdicts: (verdicts: Map<Element, ItemVerdict>) => Record<string, number>;
  /** Convenience: build a fully-formed `Filter` for the rolecast schema. */
  makeFilter: (overrides: Partial<Filter> & Pick<Filter, 'id' | 'field' | 'predicate'>) => Filter;
  /** Mounts a renderer on the page's item-set and stashes it on window for
   *  later spec calls (setRestored, setMode, re-apply). Returns the same
   *  renderer for inline use. */
  mountRenderer: (filters: readonly Filter[]) => {
    renderer: Renderer;
    schema: Schema;
    summaries: ReturnType<Renderer['apply']>;
  };
}

function tallyVerdicts(verdicts: Map<Element, ItemVerdict>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of verdicts.values()) counts[v.state] = (counts[v.state] ?? 0) + 1;
  return counts;
}

function makeFilter(
  overrides: Partial<Filter> & Pick<Filter, 'id' | 'field' | 'predicate'>,
): Filter {
  return {
    fingerprint: ROLECAST_STUB_SCHEMA.fingerprint,
    polarity: 'exclude',
    deep: false,
    saved: false,
    ...overrides,
  };
}

function mountRenderer(filters: readonly Filter[]): {
  renderer: Renderer;
  schema: Schema;
  summaries: ReturnType<Renderer['apply']>;
} {
  const schema = pickStubSchema();
  if (!schema) throw new Error('mountRenderer: no stub schema matched this document');
  const itemSet = document.querySelector(schema.itemSetSelector);
  if (!itemSet) throw new Error(`mountRenderer: no item-set found for ${schema.itemSetSelector}`);

  const renderer = new Renderer({
    schema,
    itemSet,
    onRestoreToggle: (id, restored) => renderer.setRestored(id, restored),
  });
  const items = findItems(schema);
  const verdicts = evaluate(schema, items, filters);
  const summaries = renderer.apply(verdicts);

  (globalThis as unknown as { __nfRenderer: Renderer }).__nfRenderer = renderer;
  return { renderer, schema, summaries };
}

const api: TestbedAPI = {
  chromeStorageSchemaCache,
  classify,
  detect,
  discover,
  discoverSchema,
  distill,
  evaluate,
  findItems,
  fingerprintItemSet,
  generalize,
  getOrDiscover,
  memorySchemaCache,
  renderPageStatus,
  safeCompileRegex,
  SchemaParseError,
  UnsafeRegexError,
  Picker,
  pickStubSchema,
  Renderer,
  ROLECAST_STUB_SCHEMA,
  checkLedger,
  incrementLedger,
  memorySpendChecker,
  rollLedger,
  SpendCapError,
  suggestPhrases,
  memoryQueueIO,
  PersistentQueue,
  QUEUE_INTERNALS,
  runOne,
  Throttler,
  extractDetailFields,
  isDetailPage,
  ViewportEnqueuer,
  tallyVerdicts,
  makeFilter,
  mountRenderer,
};

(globalThis as unknown as { __nf: TestbedAPI }).__nf = api;
