// content/index.ts — content-script entry, injected per granted origin.
//
// Slice-1 orchestration:
//   - Pick the matching stub schema (Slice 3 swaps for LLM discovery).
//   - Mount the renderer on the item-set.
//   - Listen for PanelToContent (setFilters · setDisplayMode ·
//     setItemRestored · getState) and react.
//   - Push itemStates to the panel whenever state changes — in-page
//     clicks (sliver / ↺ re-hide) and panel-driven changes both flow
//     through here.
//   - Preserve the 0.5 SW round-trip log so the 0.5/0.6 gates stay
//     green: the listener attaches before injection in those tests.

import { discover } from './discover.js';
import { evaluate, findItems } from './engine.js';
import { MutationWatcher } from './mutations.js';
import { Renderer } from './renderer.js';
import { pickStubSchema } from './schema-stub.js';
import { loadSavedFilters } from '../shared/saved-filters.js';
import {
  isPanelToContent,
  MESSAGE_VERSION,
  pushToPanel,
  sendToSw,
  type ContentReply,
  type ContentState,
  type DisplayMode,
  type Filter,
  type ItemSummary,
  type PanelToContent,
  type Schema,
} from '../shared/types.js';

const LOG_PREFIX = '[sieve]';

interface PageContext {
  schema: Schema;
  itemSet: Element;
  renderer: Renderer;
  /** Stable list of discovered items. Captured once at init() so the
   *  engine keeps seeing items by reference even after the renderer wraps
   *  them in `.filt` — re-running `findItems` would lose wrapped items
   *  because `.joblist > .job` no longer matches `.joblist > .filt > .job`.
   *  MutationObserver-driven re-discovery lands in 4.6. */
  items: Element[];
  filters: Filter[];
  mode: DisplayMode;
  summaries: ItemSummary[];
  /** 4.6: watches the itemSet for added cards. null until init mounts. */
  watcher: MutationWatcher | null;
}

let ctx: PageContext | null = null;

async function hydrateSavedFilters(c: PageContext): Promise<void> {
  try {
    const saved = await loadSavedFilters(c.schema.fingerprint);
    if (saved.length === 0) return;
    c.filters = saved;
    recompute(c);
    // Re-emit pageDetected so an open panel re-pulls state and
    // reconciles its local mirrors (phrases / numeric / savedExists).
    // The initial pageDetected fired with the empty filter set; the
    // panel needs the second one to see the hydrated filters.
    pushToPanel({
      t: 'pageDetected',
      v: MESSAGE_VERSION,
      layout: c.schema.layout,
      count: c.summaries.length,
      fingerprint: c.schema.fingerprint,
    });
  } catch (err) {
    console.error('[sieve] loadSavedFilters failed:', err);
  }
}

function recompute(c: PageContext): void {
  const verdicts = evaluate(c.schema, c.items, c.filters);
  c.summaries = c.renderer.apply(verdicts);
  pushToPanel({ t: 'itemStates', v: MESSAGE_VERSION, items: c.summaries });
}

function emitItemStates(c: PageContext): void {
  c.summaries = c.renderer.summaries() as ItemSummary[];
  pushToPanel({ t: 'itemStates', v: MESSAGE_VERSION, items: c.summaries });
}

function handlePanelMessage(msg: PanelToContent): ContentReply {
  if (!ctx) {
    // No schema → no engine; still report empty state so the panel can
    // render its "nothing to do here" affordance.
    if (msg.t === 'getState') {
      const empty: ContentState = { schema: null, filters: [], mode: 'collapse', items: [] };
      return { t: 'state', v: MESSAGE_VERSION, state: empty };
    }
    if (msg.t === 'rediscover') {
      // Even without a schema, the user can ask us to try again — feed
      // the hint into a fresh discover() call.
      void tryDiscover({
        ...(msg.hint !== undefined ? { hint: msg.hint } : {}),
        force: true,
      });
      return { t: 'ack', v: MESSAGE_VERSION };
    }
    return { t: 'err', v: MESSAGE_VERSION, message: 'no schema for this page' };
  }

  switch (msg.t) {
    case 'getState': {
      const state: ContentState = {
        schema: ctx.schema,
        filters: ctx.filters,
        mode: ctx.mode,
        items: ctx.summaries,
      };
      return { t: 'state', v: MESSAGE_VERSION, state };
    }
    case 'setFilters':
      ctx.filters = msg.filters;
      recompute(ctx);
      return { t: 'ack', v: MESSAGE_VERSION };
    case 'setDisplayMode':
      ctx.mode = msg.mode;
      ctx.renderer.setMode(msg.mode);
      return { t: 'ack', v: MESSAGE_VERSION };
    case 'setItemRestored':
      ctx.renderer.setRestored(msg.itemId, msg.restored);
      emitItemStates(ctx);
      return { t: 'ack', v: MESSAGE_VERSION };
    case 'rediscover':
      // Fire-and-forget — discover is async (LLM round-trip) but the
      // panel sends rediscover as a request expecting a sync ack;
      // the real outcome lands via pushToPanel(pageDetected) or
      // pushToPanel(discoverError).
      void tryDiscover({
        ...(msg.hint !== undefined ? { hint: msg.hint } : {}),
        ...(msg.force === true ? { force: true } : {}),
      });
      return { t: 'ack', v: MESSAGE_VERSION };
  }
}

function attachMessageBridge(): void {
  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    if (!isPanelToContent(raw)) return false;
    sendResponse(handlePanelMessage(raw));
    return false; // synchronous response
  });
}

async function roundTripPing(): Promise<void> {
  try {
    const reply = await sendToSw({ t: 'ping', v: MESSAGE_VERSION });
    console.log(`${LOG_PREFIX} SW round-trip:`, reply);
  } catch (err) {
    console.error(`${LOG_PREFIX} SW round-trip failed:`, err);
  }
}

/** Mount the engine + renderer + watcher on a freshly discovered (or
 *  re-discovered) schema. Idempotent: tears down the previous ctx
 *  before installing a new one so re-discover with a different fp
 *  doesn't strand state. */
function mount(schema: Schema, itemSet: Element): void {
  if (ctx) {
    ctx.watcher?.stop();
    ctx = null;
  }
  const renderer = new Renderer({
    schema,
    itemSet,
    onRestoreToggle: (id, restored) => {
      renderer.setRestored(id, restored);
      if (ctx) emitItemStates(ctx);
    },
  });
  ctx = {
    schema,
    itemSet,
    renderer,
    items: findItems(schema),
    filters: [],
    mode: 'collapse',
    summaries: [],
    watcher: null,
  };
  recompute(ctx);
  pushToPanel({
    t: 'pageDetected',
    v: MESSAGE_VERSION,
    layout: schema.layout,
    count: ctx.summaries.length,
    fingerprint: schema.fingerprint,
  });
  ctx.watcher = new MutationWatcher({
    itemSet,
    itemSelector: schema.itemSelector,
    onItemsAdded: (added) => {
      if (!ctx) return;
      ctx.items = [...ctx.items, ...added];
      recompute(ctx);
    },
  });
  ctx.watcher.start();
  void hydrateSavedFilters(ctx);
}

/** SW round-trip for the discover fetch — production wiring of the
 *  Slice-3 capstone. Packs the request as a `discoverSchema` PanelMsg,
 *  unpacks the SW's `schema` reply (or throws on `err`). */
async function fetchSchemaViaSw(req: {
  fingerprint: string;
  distilled: string;
  layout: 'list' | 'carousel' | 'grid';
  hint?: string;
  force?: boolean;
}): Promise<Schema> {
  const msg: Parameters<typeof sendToSw>[0] = {
    t: 'discoverSchema',
    v: MESSAGE_VERSION,
    fingerprint: req.fingerprint,
    distilled: req.distilled,
    layout: req.layout,
  };
  if (req.hint !== undefined) msg.hint = req.hint;
  if (req.force === true) msg.force = true;
  const reply = await sendToSw(msg);
  if (reply.t === 'schema') return reply.schema;
  if (reply.t === 'err') throw new Error(reply.message);
  throw new Error(`unexpected SW reply: ${reply.t}`);
}

/** State for the SPA-aware discover loop. Tracks whether we've already
 *  attached the mutation watcher so a re-trigger from rediscover()
 *  doesn't stack listeners. */
const discoverState = {
  inFlight: false,
  succeeded: false,
  mutationObserver: null as MutationObserver | null,
  giveUpTimer: null as ReturnType<typeof setTimeout> | null,
};

/** Single discover attempt — null if detect() didn't find anything,
 *  throws on LLM / SW failure. Pulled out so the retry loop and the
 *  mutation watcher share one entry point. */
async function attemptDiscover(opts: {
  hint?: string;
  force?: boolean;
}): Promise<boolean> {
  const discoverOpts: { hint?: string; force?: boolean } = {};
  if (opts.hint !== undefined) discoverOpts.hint = opts.hint;
  if (opts.force === true) discoverOpts.force = true;
  const result = await discover(
    document,
    { fetchSchema: (r) => fetchSchemaViaSw(r) },
    discoverOpts,
  );
  if (!result) return false;
  mount(result.schema, result.itemSet);
  return true;
}

/** Attempt LLM discovery with SPA-aware retry. YouTube / LinkedIn /
 *  Twitter hydrate well after document_idle, so a fixed back-off
 *  isn't enough. After the seeded delays we install a MutationObserver
 *  on document.body that re-tries detect() on each batch of new
 *  descendants — capped at a 60s total budget so an idle tab doesn't
 *  retain the observer indefinitely.
 *
 *  Re-entrant: rediscover() may call this while a previous run is in
 *  flight. We coalesce to one run via discoverState.inFlight. force:true
 *  cancels the previous attempt's mutation watcher so the new hint
 *  takes effect. */
async function tryDiscover(opts: { hint?: string; force?: boolean } = {}): Promise<void> {
  if (opts.force === true) {
    // A forced rediscover supersedes any prior pending attempt.
    teardownDiscoverWatcher();
    discoverState.succeeded = false;
    discoverState.inFlight = false;
  }
  if (discoverState.inFlight || discoverState.succeeded) return;
  discoverState.inFlight = true;

  const delays = [0, 1_000, 3_000];
  try {
    for (const wait of delays) {
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        if (await attemptDiscover(opts)) {
          discoverState.succeeded = true;
          return;
        }
      } catch (err) {
        emitDiscoverError(err);
        return;
      }
    }
    // Initial back-off exhausted without a detection. Watch for
    // significant DOM mutations and retry on each.
    installDiscoverWatcher(opts);
  } finally {
    discoverState.inFlight = false;
  }
}

function emitDiscoverError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${LOG_PREFIX} discover failed:`, message);
  pushToPanel({
    t: 'discoverError',
    v: MESSAGE_VERSION,
    message,
  });
}

const GIVE_UP_MS = 60_000;
const MIN_MUTATION_RETRY_INTERVAL_MS = 750;

function installDiscoverWatcher(opts: { hint?: string; force?: boolean }): void {
  if (discoverState.mutationObserver) return;
  let lastAttemptAt = 0;
  let retryQueued = false;
  const attempt = async (): Promise<void> => {
    if (discoverState.succeeded) return;
    if (Date.now() - lastAttemptAt < MIN_MUTATION_RETRY_INTERVAL_MS) {
      if (retryQueued) return;
      retryQueued = true;
      setTimeout(() => {
        retryQueued = false;
        void attempt();
      }, MIN_MUTATION_RETRY_INTERVAL_MS);
      return;
    }
    lastAttemptAt = Date.now();
    try {
      if (await attemptDiscover(opts)) {
        discoverState.succeeded = true;
        teardownDiscoverWatcher();
      }
    } catch (err) {
      emitDiscoverError(err);
      teardownDiscoverWatcher();
    }
  };
  const observer = new MutationObserver((records) => {
    // Filter to mutations that *grow* the tree — irrelevant
    // attribute changes alone don't justify a re-detect.
    for (const r of records) {
      if (r.addedNodes.length > 0) {
        void attempt();
        return;
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  discoverState.mutationObserver = observer;
  // Cap the lifetime so we don't keep an observer running on idle pages.
  discoverState.giveUpTimer = setTimeout(() => {
    if (!discoverState.succeeded) {
      pushToPanel({
        t: 'discoverError',
        v: MESSAGE_VERSION,
        message:
          'no item-set detected after 60s — try Re-discover with a one-line hint about which list to filter.',
      });
    }
    teardownDiscoverWatcher();
  }, GIVE_UP_MS);
}

function teardownDiscoverWatcher(): void {
  discoverState.mutationObserver?.disconnect();
  discoverState.mutationObserver = null;
  if (discoverState.giveUpTimer !== null) {
    clearTimeout(discoverState.giveUpTimer);
    discoverState.giveUpTimer = null;
  }
}

function init(): void {
  attachMessageBridge();

  const schema = pickStubSchema();
  if (schema) {
    const itemSet = document.querySelector(schema.itemSetSelector);
    if (itemSet) mount(schema, itemSet);
  } else {
    // No hand-written stub for this page → kick off LLM discovery.
    void tryDiscover();
  }

  // Always do the SW round-trip — 0.5/0.6 gates depend on this log.
  void roundTripPing();
}

init();
