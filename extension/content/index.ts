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

import { buildLocalSchema, discover } from './discover.js';
import { evaluate, findItems } from './engine.js';
import { MutationWatcher } from './mutations.js';
import { Renderer } from './renderer.js';
import { pickStubSchema } from './schema-stub.js';
import { DeepTextScanner } from './deep-text.js';
import { suggestFromItems } from './suggest.js';
import { loadSavedFilters } from '../shared/saved-filters.js';
import {
  ALL_TEXT_FIELD,
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

// Pipeline-timing probe (opt-in). Flip via `localStorage.setItem('nf-timing','1')`
// in the page console; logs `[sieve-timing] <event> @<ms>` against a single
// monotonic clock so the gap between "list painted", "mounted", and "filtered"
// is directly readable. Zero cost when off. Not a shipping default.
const TIMING_ON = (() => {
  try {
    return localStorage.getItem('nf-timing') === '1';
  } catch {
    return false;
  }
})();
function tlog(event: string, extra?: Record<string, unknown>): void {
  if (!TIMING_ON) return;
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[sieve-timing] ${event} @${Math.round(performance.now())}ms${suffix}`);
}

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
  /** Per-item fetched description text, folded into ALL_TEXT_FIELD matching
   *  so keyword filters hit content that isn't on the card (LinkedIn job
   *  descriptions). Populated lazily by `scanner` when a phrase filter is
   *  active. */
  detailText: Map<Element, string>;
  /** Throttled fetcher of detail text. null until mount. */
  scanner: DeepTextScanner | null;
  /** One pending re-scan pass for failed description fetches (rate-limit
   *  recovery). null when none is scheduled. */
  rescanTimer: ReturnType<typeof setTimeout> | null;
}

let ctx: PageContext | null = null;

/** True when at least one active filter is a free-text phrase filter (matches
 *  the whole-item text). Only then is fetching descriptions worthwhile. */
function hasPhraseFilter(c: PageContext): boolean {
  return c.filters.some(
    (f) => f.field === ALL_TEXT_FIELD && f.predicate.op === 'containsAny' && f.predicate.phrases.length > 0,
  );
}

/** Kick off (or resume) description fetching when a phrase filter is active.
 *  Cached/in-flight items are skipped inside the scanner, so this is cheap to
 *  call on every filter change. */
function maybeScanDescriptions(c: PageContext): void {
  if (!c.scanner) return;
  if (!hasPhraseFilter(c)) return;
  c.scanner.scan(c.items);
  // Rate-limited fetches fail silently (a miss, never a false hide) and
  // aren't cached — one delayed re-scan picks them up once the limiter
  // cools off. scan() skips cached/in-flight URLs, so the retry only
  // touches the failures.
  if (c.rescanTimer !== null) return;
  c.rescanTimer = setTimeout(() => {
    c.rescanTimer = null;
    if (ctx !== c || !c.scanner || !hasPhraseFilter(c)) return;
    const missing = c.items.some((el) => el.isConnected && !c.detailText.has(el));
    if (missing) c.scanner.scan(c.items);
  }, 12_000);
}

async function hydrateSavedFilters(c: PageContext): Promise<void> {
  try {
    const saved = await loadSavedFilters(c.schema.fingerprint);
    if (saved.length === 0) return;
    c.filters = saved;
    recompute(c);
    tlog('hydrateSavedFilters:applied', {
      filters: saved.length,
      filtered: c.summaries.filter((s) => s.state === 'filtered').length,
    });
    maybeScanDescriptions(c);
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
  const verdicts = evaluate(c.schema, c.items, c.filters, c.detailText, (err) => {
    // A rejected filter (unsafe regex) sits out this pass; the rest keep
    // filtering. Tell the panel which one and why instead of dying silent.
    pushToPanel({
      t: 'filterError',
      v: MESSAGE_VERSION,
      filterId: err.filterId,
      message: err.message,
    });
  });
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
      // the hint into a fresh discover() call. Panel-initiated rediscover
      // bypasses the stub so the user can override a wrong-stub on a
      // known site.
      void tryDiscover({
        ...(msg.hint !== undefined ? { hint: msg.hint } : {}),
        force: true,
        bypassStub: true,
      });
      return { t: 'ack', v: MESSAGE_VERSION };
    }
    if (msg.t === 'spaNavigated') {
      handleSpaUrlChange();
      return { t: 'ack', v: MESSAGE_VERSION };
    }
    if (msg.t === 'getSuggestions') {
      return { t: 'suggestions', v: MESSAGE_VERSION, phrases: [] };
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
      // A phrase filter may need description text the card doesn't carry —
      // fetch it in the background and re-hide as matches arrive.
      maybeScanDescriptions(ctx);
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
      // pushToPanel(discoverError). Panel-initiated → bypass the stub
      // so a wrong-stub on a known site can be overridden.
      void tryDiscover({
        ...(msg.hint !== undefined ? { hint: msg.hint } : {}),
        ...(msg.force === true ? { force: true } : {}),
        bypassStub: true,
      });
      return { t: 'ack', v: MESSAGE_VERSION };
    case 'getSuggestions': {
      // Suggestions come from the page itself — disconnected items still
      // read textContent and would surface ghost phrases from a previous
      // pagination page, so only live cards count.
      const existing = ctx.filters.flatMap((f) =>
        f.predicate.op === 'containsAny' ? f.predicate.phrases : [],
      );
      const phrases = suggestFromItems(
        ctx.items.filter((el) => el.isConnected),
        ctx.detailText,
        existing,
        msg.max,
      );
      return { t: 'suggestions', v: MESSAGE_VERSION, phrases };
    }
    case 'spaNavigated':
      // Stub-first re-detect (unlike rediscover): on a known site the
      // route change should land back on the site stub, not the LLM.
      handleSpaUrlChange();
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
 *  re-discovered) schema. Tears down the previous ctx before installing a
 *  new one so re-discover with a different fp doesn't strand state. Filters
 *  + mode are carried over when the new fingerprint matches the previous
 *  one — that's the SPA-navigation case (same site, new search query) where
 *  the user expects their typed-but-unsaved phrases to keep filtering. A
 *  fingerprint change means the user is on a different layout, so filters
 *  tagged for the old shape are dropped.
 *
 *  `forceRemount` (only the panel's explicit Re-discover sets it) bypasses
 *  the no-op guard below and always rebuilds. */
function mount(schema: Schema, itemSet: Element, opts: { forceRemount?: boolean } = {}): void {
  // No-op re-detect short-circuit. LinkedIn rewrites the URL on every job
  // click (?currentJobId=…) and cosmetically post-load (%20→+); each fires
  // an SPA route change → forced re-discover that lands right back on the
  // SAME item-set element with the same fingerprint. Rebuilding the renderer
  // there flickers the page and burns ~2s in a teardown/re-mount for nothing
  // (measured live: filters applied at 2.31s, needlessly torn down + redone
  // at 4.36s). When the live item-set and fingerprint are unchanged, keep the
  // existing renderer + watcher — the watcher already tracks card changes —
  // and return. A real new search REPLACES the container element, so the
  // identity check fails and we rebuild as before.
  if (
    !opts.forceRemount &&
    ctx !== null &&
    ctx.itemSet === itemSet &&
    itemSet.isConnected &&
    ctx.schema.fingerprint === schema.fingerprint
  ) {
    tlog('mount:skip-unchanged', { fp: schema.fingerprint });
    return;
  }
  tlog('mount:start', { fp: schema.fingerprint, source: schema.source });
  const carry =
    ctx && ctx.schema.fingerprint === schema.fingerprint
      ? { filters: ctx.filters, mode: ctx.mode }
      : null;
  if (ctx) {
    ctx.watcher?.stop();
    ctx.scanner?.stop();
    if (ctx.rescanTimer !== null) clearTimeout(ctx.rescanTimer);
    // Without this, a replaced renderer's self-heal observer keeps
    // re-collapsing items the new renderer no longer filters.
    ctx.renderer.disconnect();
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
  if (carry) renderer.setMode(carry.mode);
  ctx = {
    schema,
    itemSet,
    renderer,
    items: findItems(schema, document, itemSet),
    filters: carry?.filters ?? [],
    mode: carry?.mode ?? 'collapse',
    summaries: [],
    watcher: null,
    detailText: new Map<Element, string>(),
    scanner: null,
    rescanTimer: null,
  };
  // Scanner folds fetched description text into the next recompute. Debounce
  // recompute so a burst of arriving descriptions repaints once, not N times.
  let repaintQueued = false;
  ctx.scanner = new DeepTextScanner({
    onText: (item, text) => {
      if (!ctx) return;
      ctx.detailText.set(item, text);
      if (repaintQueued) return;
      repaintQueued = true;
      setTimeout(() => {
        repaintQueued = false;
        if (ctx) recompute(ctx);
      }, 150);
    },
  });
  tlog('mount:items', { items: ctx.items.length, filters: ctx.filters.length });
  recompute(ctx);
  tlog('mount:firstRecompute', {
    filtered: ctx.summaries.filter((s) => s.state === 'filtered').length,
  });
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
      // Pagination on virtualized lists REPLACES cards rather than
      // appending — prune the disconnected ones (they'd evaluate as
      // ghosts: textContent still reads on detached nodes) and dedupe,
      // since a re-parented wrapper can re-deliver known items.
      const next = new Set(ctx.items.filter((el) => el.isConnected));
      for (const el of added) next.add(el);
      ctx.items = [...next];
      // detailText is keyed by Element — without this, every paginated-away
      // card's 5–20 KB description stays pinned for the page's lifetime.
      for (const el of ctx.detailText.keys()) {
        if (!el.isConnected) ctx.detailText.delete(el);
      }
      recompute(ctx);
      maybeScanDescriptions(ctx);
    },
  });
  ctx.watcher.start();
  if (carry) {
    // Deep-text cache was reset, so descriptions need to be re-fetched for
    // the new set of cards before phrase filters that rely on body text
    // (LinkedIn jobs) can match. Skip storage hydration — the carried
    // filters are the live session state (the initial mount already
    // hydrated, and any later panel edits already supersede the saved set).
    maybeScanDescriptions(ctx);
  } else {
    void hydrateSavedFilters(ctx);
  }
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
  /** Only the panel's "Re-discover" button sets this — that's the
   *  explicit "the stub is wrong, try LLM" escape hatch. SPA route
   *  changes (new LinkedIn search) MUST leave this false so the
   *  deterministic stub re-mounts on the new URL instead of
   *  force-routing into a doomed LLM call. */
  bypassStub?: boolean;
}): Promise<boolean> {
  // The panel's Re-discover is the only explicit "rebuild now" request; every
  // other caller (initial load, SPA route change) lets mount() skip the
  // rebuild when the item-set is unchanged.
  const forceRemount = opts.bypassStub === true;
  if (opts.bypassStub !== true) {
    const stub = pickStubSchema();
    if (stub) {
      const stubItemSet = document.querySelector(stub.itemSetSelector);
      if (stubItemSet) {
        mount(stub, stubItemSet, { forceRemount });
        return true;
      }
    }
  }

  const discoverOpts: { hint?: string; force?: boolean } = {};
  if (opts.hint !== undefined) discoverOpts.hint = opts.hint;
  if (opts.force === true) discoverOpts.force = true;
  try {
    const result = await discover(
      document,
      { fetchSchema: (r) => fetchSchemaViaSw(r) },
      discoverOpts,
    );
    if (!result) return false;
    mount(result.schema, result.itemSet, { forceRemount });
    return true;
  } catch (err) {
    // The LLM round-trip failed (no key, "Failed to fetch", spend cap, or a
    // bad response). Rather than leave the user with nothing, fall back to a
    // local, no-LLM schema so the free-text keyword filter still works. Only
    // named-field / numeric filters need the LLM. If even local detection
    // finds no item-set, surface the original error.
    const local = buildLocalSchema(document);
    if (local) {
      console.warn(
        `${LOG_PREFIX} LLM discovery failed (${
          err instanceof Error ? err.message : String(err)
        }); using local detection.`,
      );
      mount(local.schema, local.itemSet, { forceRemount });
      return true;
    }
    throw err;
  }
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
async function tryDiscover(
  opts: { hint?: string; force?: boolean; bypassStub?: boolean } = {},
): Promise<void> {
  if (opts.force === true) {
    // A forced rediscover supersedes any prior pending attempt.
    teardownDiscoverWatcher();
    discoverState.succeeded = false;
    discoverState.inFlight = false;
  }
  if (discoverState.inFlight || discoverState.succeeded) return;
  discoverState.inFlight = true;

  const delays = [0, 1_000, 3_000];
  let lastError: unknown = null;
  try {
    for (const wait of delays) {
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        if (await attemptDiscover(opts)) {
          discoverState.succeeded = true;
          return;
        }
      } catch (err) {
        // A discovery error (e.g. the LLM returning a malformed schema
        // before the SPA's real list has hydrated) must NOT abort the whole
        // retry — on LinkedIn the site stub or local detection succeeds once
        // the cards mount. Remember the error and keep trying; the watcher's
        // 60s timeout surfaces it only if nothing ever works.
        lastError = err;
      }
    }
    // Initial back-off exhausted without a detection. Watch for
    // significant DOM mutations and retry on each.
    installDiscoverWatcher(opts);
  } finally {
    discoverState.inFlight = false;
  }
  void lastError; // surfaced by the watcher's give-up path, not here
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

function installDiscoverWatcher(opts: {
  hint?: string;
  force?: boolean;
  bypassStub?: boolean;
}): void {
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
    } catch {
      // Keep watching — a transient discovery error on one mutation batch
      // shouldn't stop us; the site stub / local detection typically
      // succeeds on a later batch once the list finishes hydrating. The
      // 60s give-up timer surfaces a final error if nothing ever works.
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

/** Wire up SPA-aware URL-change re-detection. LinkedIn (and most modern
 *  job boards) swap routes via `history.pushState`/`replaceState` without
 *  a full reload — the original document_idle init never re-fires, so a
 *  navigation from `/jobs/search/?…` to `/jobs/search-results/?currentJobId=…`
 *  (or vice versa) leaves the content script bound to a stale schema.
 *  Patch the History API + listen for popstate so any route change kicks
 *  another discover attempt. Safe to call once per page-load. */
let lastSpaUrl = location.href;
let spaDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Re-detect after an SPA route change. Idempotent per URL — the SW relay
 *  (tabs.onUpdated) and the in-realm history patch can both fire for the
 *  same navigation. Debounced: LinkedIn pagination churns through several
 *  URL states in ~2s (re-encoded keywords → +start → +currentJobId); each
 *  un-debounced remount re-fetched every description and the burst tripped
 *  the jobs-guest rate limit. One trailing remount covers the storm. */
function handleSpaUrlChange(): void {
  if (location.href === lastSpaUrl) return;
  lastSpaUrl = location.href;
  tlog('spaUrlChange:queued', { href: location.href });
  if (spaDebounceTimer !== null) clearTimeout(spaDebounceTimer);
  spaDebounceTimer = setTimeout(() => {
    spaDebounceTimer = null;
    tlog('spaUrlChange:fire-rediscover');
    console.log(`${LOG_PREFIX} url changed → re-detect (${location.href})`);
    // Reset the discover gate so tryDiscover() will re-run on the new URL.
    // Existing renderer + ctx for the previous URL are torn down inside
    // mount() the next time it fires.
    discoverState.succeeded = false;
    teardownDiscoverWatcher();
    void tryDiscover({ force: true });
  }, 1200);
}

function installSpaNavigationWatcher(): void {
  // Best-effort only: this patch lives in the ISOLATED world, so a page-
  // realm pushState (every real SPA) never hits it — the production
  // trigger is the SW's tabs.onUpdated relay (`spaNavigated` message).
  // Kept because it catches same-realm navigation in fixtures and tests.
  for (const m of ['pushState', 'replaceState'] as const) {
    const original = history[m];
    history[m] = function patched(this: History, ...args: Parameters<typeof original>) {
      const r = original.apply(this, args);
      // Fire after the framework finishes updating the DOM.
      setTimeout(handleSpaUrlChange, 0);
      return r;
    } as typeof original;
  }
  window.addEventListener('popstate', () => setTimeout(handleSpaUrlChange, 0));
}

function init(): void {
  // panel.handleEnable now runs executeScript against the active tab to
  // recover from `chrome://extensions` reloads that drop the dynamic
  // registration. That can re-execute this bundle while a previous copy
  // is still alive (its `chrome.runtime.onMessage` listener, history
  // monkey-patches, ctx, etc. all linger). Guard so re-runs are no-ops.
  const w = window as Window & { __nfContentInitialized?: boolean };
  if (w.__nfContentInitialized) {
    console.log(`${LOG_PREFIX} content script already initialized — skipping re-init`);
    return;
  }
  w.__nfContentInitialized = true;
  tlog('init:start');

  attachMessageBridge();
  installSpaNavigationWatcher();

  const schema = pickStubSchema();
  if (schema) {
    const itemSet = document.querySelector(schema.itemSetSelector);
    if (itemSet) {
      mount(schema, itemSet);
      console.log(
        `${LOG_PREFIX} stub matched ${schema.fingerprint} (${ctx?.items.length ?? 0} items) at ${location.href}`,
      );
    } else {
      // Stub selector matches a known site but the item-set hasn't hydrated
      // yet — fall through to the SPA-aware discover retry loop so the
      // mutation observer catches the late mount.
      console.log(
        `${LOG_PREFIX} stub schema picked (${schema.fingerprint}) but item-set selector not present yet; will retry`,
      );
      void tryDiscover();
    }
  } else {
    console.log(`${LOG_PREFIX} no stub matched; running discovery on ${location.href}`);
    void tryDiscover();
  }

  // Always do the SW round-trip — 0.5/0.6 gates depend on this log.
  void roundTripPing();
}

init();
