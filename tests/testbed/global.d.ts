// Ambient declarations so Playwright specs can reference `window.__nf`
// without a per-call cast. The actual surface is defined in
// `tests/testbed/runtime.ts`; this file mirrors it for the type checker
// (and only the type checker — no runtime side effects).

import type {
  chromeStorageSchemaCache as chromeStorageSchemaCacheFn,
  getOrDiscover as getOrDiscoverFn,
  memorySchemaCache as memorySchemaCacheFn,
} from '../../extension/background/cache.js';
import type {
  discoverSchema as discoverSchemaFn,
  distill as distillFn,
  SchemaParseError as SchemaParseErrorClass,
} from '../../extension/background/llm.js';
import type { discover as discoverFn } from '../../extension/content/discover.js';
import type { renderPageStatus as renderPageStatusFn } from '../../extension/panel/components/page-status.js';
import type {
  safeCompileRegex as safeCompileRegexFn,
  UnsafeRegexError as UnsafeRegexErrorClass,
} from '../../extension/shared/safe-regex.js';
import type { Picker } from '../../extension/content/picker.js';
import type { Renderer } from '../../extension/content/renderer.js';
import type {
  classify as classifyFn,
  detect as detectFn,
  generalize as generalizeFn,
} from '../../extension/content/detect.js';
import type { ItemVerdict } from '../../extension/content/engine.js';
import type {
  evaluate as evaluateFn,
  findItems as findItemsFn,
} from '../../extension/content/engine.js';
import type { fingerprintItemSet as fingerprintItemSetFn } from '../../extension/content/fingerprint.js';
import type { pickStubSchema as pickStubSchemaFn } from '../../extension/content/schema-stub.js';
import type { Filter, Schema } from '../../extension/shared/types.js';

declare global {
  interface NFTestbed {
    chromeStorageSchemaCache: typeof chromeStorageSchemaCacheFn;
    classify: typeof classifyFn;
    detect: typeof detectFn;
    discover: typeof discoverFn;
    discoverSchema: typeof discoverSchemaFn;
    distill: typeof distillFn;
    evaluate: typeof evaluateFn;
    findItems: typeof findItemsFn;
    fingerprintItemSet: typeof fingerprintItemSetFn;
    generalize: typeof generalizeFn;
    getOrDiscover: typeof getOrDiscoverFn;
    memorySchemaCache: typeof memorySchemaCacheFn;
    renderPageStatus: typeof renderPageStatusFn;
    safeCompileRegex: typeof safeCompileRegexFn;
    SchemaParseError: typeof SchemaParseErrorClass;
    UnsafeRegexError: typeof UnsafeRegexErrorClass;
    Picker: typeof Picker;
    pickStubSchema: typeof pickStubSchemaFn;
    Renderer: typeof Renderer;
    ROLECAST_STUB_SCHEMA: Schema;
    tallyVerdicts: (verdicts: Map<Element, ItemVerdict>) => Record<string, number>;
    makeFilter: (
      overrides: Partial<Filter> & Pick<Filter, 'id' | 'field' | 'predicate'>,
    ) => Filter;
    mountRenderer: (filters: readonly Filter[]) => {
      renderer: Renderer;
      schema: Schema;
      summaries: ReturnType<Renderer['apply']>;
    };
  }

  interface Window {
    __nf: NFTestbed;
    __nfRenderer: Renderer;
  }
}

export {};
