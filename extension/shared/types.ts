// shared/types.ts — single source of truth for cross-surface data shapes and
// message contracts. Imported by background, content, and panel.
//
// Per BUILD_PLAN.md cross-cutting concerns: every message carries `v: 1`.
// Future migrations add `v: 2` variants in parallel; receivers reject anything
// they don't understand.
//
// Slice topology (Slice 1):
//  - Panel ↔ content speak **directly** (chrome.tabs.sendMessage for panel→
//    content, chrome.runtime.sendMessage for content→panel). The SW stays
//    focused on enableDomain/disableDomain.
//  - Slice 3 pulls the SW into the middle (LLM discovery + schemaCache).
//  - The PanelMsg / SwToPanel unions below cover panel↔SW only.
//  - PanelToContent / ContentToPanel cover panel↔content directly.

export const MESSAGE_VERSION = 1 as const;
export type MessageV = typeof MESSAGE_VERSION;

// ---------------------------------------------------------------------------
// Data model — BUILD_PLAN.md#data-model
// ---------------------------------------------------------------------------

export type LayoutKind = 'list' | 'carousel' | 'grid';
export type LlmProvider = 'anthropic' | 'openai';
export type ItemState = 'passing' | 'filtered' | 'restored' | 'checking';
export type DisplayMode = 'collapse' | 'hide';
export type Polarity = 'exclude' | 'keep';

/** Predicate union. The evaluator (engine.ts) switches on `op` and throws
 *  on unknown variants. New variants land here as a single source of truth.
 *
 *  Slice 1: `containsAny`.
 *  Slice 4.1: `regex` (with safe-compile guard), `lessThan`, `greaterThan`,
 *  `equals`, `oneOf`. */
export type Predicate =
  | { op: 'containsAny'; phrases: string[] }
  | { op: 'regex'; pattern: string; flags?: string }
  | { op: 'lessThan'; value: number }
  | { op: 'greaterThan'; value: number }
  | { op: 'equals'; value: string | number | boolean }
  | { op: 'oneOf'; values: ReadonlyArray<string | number | boolean> };

export type FieldKind = 'text' | 'number' | 'date' | 'enum' | 'flag';

export interface FieldSpec {
  kind: FieldKind;
  selector: string;
  /** Value only available on the detail page — Slice 5. */
  deep?: boolean;
}

export interface Schema {
  fingerprint: string;
  layout: LayoutKind;
  itemSetSelector: string;
  itemSelector: string;
  fields: Record<string, FieldSpec>;
  /** Anchor → detail-page URL, Slice 5. */
  detailLinkSelector?: string;
  detailFieldSelectors?: Record<string, string>;
  /** How the renderer materializes a filtered item. `wrap` reparents the item
   *  into a `.filt` wrapper; `detached` mutates only class/data attributes on
   *  the item itself — required on React-managed lists, whose reconciler
   *  reverts reparented rows (LinkedIn v2 LazyColumn, memory.md 2026-06-06).
   *  Defaults to `wrap`. */
  renderMode?: 'wrap' | 'detached';
  /** `stub` = the hand-written Slice-1 fallback baked into the content script.
   *  `local` = built from detect()+generalize() with no LLM, so keyword
   *  filtering works offline / when the LLM under-matches or is unavailable. */
  source: 'llm' | 'taught' | 'cached' | 'stub' | 'local';
  discoveredAt: number;
}

/** Sentinel `Filter.field` value meaning "match against the item's entire
 *  visible text", not a single named schema field. Used by the panel's
 *  free-text phrase filter so a keyword hides any card that mentions it —
 *  robust even when the LLM-discovered schema has no matching field (e.g.
 *  LinkedIn job cards have title/company/location but no "snippet"). The
 *  engine's readField() special-cases this to the item's textContent. */
export const ALL_TEXT_FIELD = '*';

export interface Filter {
  id: string;
  fingerprint: string;
  polarity: Polarity;
  field: string;
  predicate: Predicate;
  /** Opt-in detail-page evaluation — Slice 5. */
  deep: boolean;
  /** Ephemeral (memory) vs persistent (storage.sync) — Slice 4.5. */
  saved: boolean;
}

/** What the content script reports about each detected item. The `id` is
 *  stable for the session: the engine assigns it on first sight and keeps it
 *  on the same DOM node. The HIDDEN list in the panel addresses items by id. */
export interface ItemSummary {
  id: string;
  state: ItemState;
  /** Which filter / phrase produced the `filtered` verdict, for display in
   *  the HIDDEN list. Undefined for passing/checking. */
  reason?: string;
  /** Short human-readable label (title field). Used by HIDDEN list rows. */
  label?: string;
}

// ---------------------------------------------------------------------------
// Bus surface A — panel ↔ SW
// ---------------------------------------------------------------------------

/** Panel → service worker. Content also sends these (the ping path lives in
 *  content/index.ts since 0.5; Slice-3 production wire-up adds discoverSchema
 *  there too — same bus, different caller). */
export type PanelMsg =
  | { t: 'ping'; v: MessageV }
  | { t: 'enableDomain'; v: MessageV; origin: string }
  | { t: 'disableDomain'; v: MessageV; origin: string }
  | {
      t: 'discoverSchema';
      v: MessageV;
      fingerprint: string;
      distilled: string;
      layout: LayoutKind;
      hint?: string;
      force?: boolean;
    }
  /** LLM-curated phrase suggestions. `candidates` are the locally-extracted
   *  recurring tokens from the detected items — the ONLY page content the
   *  suggestion call may transmit (PRIVACY.md). The SW errs with
   *  `no-api-key` when settings are absent; the panel then falls back to
   *  the local candidates as-is. */
  | { t: 'suggestPhrases'; v: MessageV; existing: string[]; candidates: string[] };

/** Service worker → panel (or reply value to a PanelMsg send). `ack`/`err`
 *  are generic side-effect replies — anything that doesn't return data uses
 *  them. */
export type SwToPanel =
  | { t: 'pong'; v: MessageV }
  | { t: 'ack'; v: MessageV }
  | { t: 'err'; v: MessageV; message: string }
  | { t: 'schema'; v: MessageV; schema: Schema }
  | { t: 'suggestions'; v: MessageV; phrases: string[] };

// ---------------------------------------------------------------------------
// Bus surface B — panel ↔ content (direct, Slice 1)
// ---------------------------------------------------------------------------

/** Panel → content (via chrome.tabs.sendMessage). */
export type PanelToContent =
  | { t: 'getState'; v: MessageV }
  | { t: 'setFilters'; v: MessageV; filters: Filter[] }
  | { t: 'setDisplayMode'; v: MessageV; mode: DisplayMode }
  | { t: 'setItemRestored'; v: MessageV; itemId: string; restored: boolean }
  | { t: 'rediscover'; v: MessageV; hint?: string; force?: boolean }
  /** Local phrase suggestions extracted from the detected items — no LLM,
   *  no network, so nothing here touches the PRIVACY.md surface. `max`
   *  widens the candidate list when the panel intends to LLM-curate it. */
  | { t: 'getSuggestions'; v: MessageV; max?: number }
  /** SW-relayed SPA route change (tabs.onUpdated fires on pushState; the
   *  content script's own history patch can't cross the isolated-world
   *  boundary — memory.md 2026-06-06). */
  | { t: 'spaNavigated'; v: MessageV; url: string };

/** Content's reply to a PanelToContent request. */
export type ContentReply =
  | { t: 'state'; v: MessageV; state: ContentState }
  | { t: 'ack'; v: MessageV }
  | { t: 'err'; v: MessageV; message: string }
  | { t: 'suggestions'; v: MessageV; phrases: string[] };

/** Snapshot of the content script's view of the page. */
export interface ContentState {
  /** Null when no schema matched (no item-set detected on the page). */
  schema: Schema | null;
  filters: Filter[];
  mode: DisplayMode;
  items: ItemSummary[];
}

/** Content → panel push (via chrome.runtime.sendMessage; the panel listens
 *  on chrome.runtime.onMessage). Fire-and-forget — no reply expected. The
 *  panel is allowed to be closed; these messages are absorbed silently. */
export type ContentToPanel =
  | { t: 'itemStates'; v: MessageV; items: ItemSummary[] }
  | {
      t: 'pageDetected';
      v: MessageV;
      layout: LayoutKind;
      count: number;
      fingerprint: string;
    }
  | { t: 'discoverError'; v: MessageV; message: string }
  /** One filter was rejected by the engine (unsafe/invalid regex). The
   *  rest of the filter set keeps evaluating; the panel surfaces which
   *  filter sat out and why. */
  | { t: 'filterError'; v: MessageV; filterId: string; message: string };

// ---------------------------------------------------------------------------
// Type guards — receivers must validate at the boundary, since chrome.runtime
// hands us `unknown` from another extension surface.
// ---------------------------------------------------------------------------

function hasShape(x: unknown): x is { t: unknown; v: unknown } {
  return typeof x === 'object' && x !== null && 't' in x && 'v' in x;
}

function hasStringField(x: object, key: string): boolean {
  return key in x && typeof (x as Record<string, unknown>)[key] === 'string';
}

export function isPanelMsg(x: unknown): x is PanelMsg {
  if (!hasShape(x)) return false;
  if (x.v !== MESSAGE_VERSION) return false;
  const r = x as Record<string, unknown>;
  switch (x.t) {
    case 'ping':
      return true;
    case 'enableDomain':
    case 'disableDomain':
      return hasStringField(x, 'origin');
    case 'discoverSchema':
      return (
        hasStringField(x, 'fingerprint') &&
        hasStringField(x, 'distilled') &&
        (r['layout'] === 'list' || r['layout'] === 'carousel' || r['layout'] === 'grid')
      );
    case 'suggestPhrases':
      return Array.isArray(r['existing']) && Array.isArray(r['candidates']);
    default:
      return false;
  }
}

export function isSwToPanel(x: unknown): x is SwToPanel {
  if (!hasShape(x)) return false;
  if (x.v !== MESSAGE_VERSION) return false;
  const r = x as Record<string, unknown>;
  switch (x.t) {
    case 'pong':
    case 'ack':
      return true;
    case 'err':
      return hasStringField(x, 'message');
    case 'schema':
      return typeof r['schema'] === 'object' && r['schema'] !== null;
    case 'suggestions':
      return Array.isArray(r['phrases']);
    default:
      return false;
  }
}

export function isPanelToContent(x: unknown): x is PanelToContent {
  if (!hasShape(x)) return false;
  if (x.v !== MESSAGE_VERSION) return false;
  const r = x as Record<string, unknown>;
  switch (x.t) {
    case 'getState':
      return true;
    case 'setFilters':
      return Array.isArray(r['filters']);
    case 'setDisplayMode':
      return r['mode'] === 'collapse' || r['mode'] === 'hide';
    case 'setItemRestored':
      return hasStringField(x, 'itemId') && typeof r['restored'] === 'boolean';
    case 'rediscover':
    case 'getSuggestions':
      return true;
    case 'spaNavigated':
      return hasStringField(x, 'url');
    default:
      return false;
  }
}

export function isContentReply(x: unknown): x is ContentReply {
  if (!hasShape(x)) return false;
  if (x.v !== MESSAGE_VERSION) return false;
  const r = x as Record<string, unknown>;
  switch (x.t) {
    case 'ack':
      return true;
    case 'err':
      return hasStringField(x, 'message');
    case 'state':
      return typeof r['state'] === 'object' && r['state'] !== null;
    case 'suggestions':
      return Array.isArray(r['phrases']);
    default:
      return false;
  }
}

export function isContentToPanel(x: unknown): x is ContentToPanel {
  if (!hasShape(x)) return false;
  if (x.v !== MESSAGE_VERSION) return false;
  const r = x as Record<string, unknown>;
  switch (x.t) {
    case 'itemStates':
      return Array.isArray(r['items']);
    case 'pageDetected':
      return hasStringField(x, 'fingerprint') && typeof r['count'] === 'number';
    case 'discoverError':
      return hasStringField(x, 'message');
    case 'filterError':
      return hasStringField(x, 'filterId') && hasStringField(x, 'message');
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Per-domain content-script registration identity. Used by both the SW
// (registerContentScripts / unregisterContentScripts) and the panel (to look
// up whether an origin is currently enabled). Stable + deterministic so a
// reload of either surface arrives at the same id.
// ---------------------------------------------------------------------------

/** `nf:` prefix keeps our ids namespaced inside the global registration
 *  table; the origin is the natural primary key. Chrome's id rules forbid
 *  `,` and underscores at the start — `:` and `/` are fine. */
export function scriptIdFor(origin: string): string {
  return `nf:${origin}`;
}

/** A match pattern that targets every page of an origin. `optional_host_
 *  permissions`, `permissions.request`, `registerContentScripts.matches`, and
 *  `permissions.contains` all want the same shape. */
export function originMatchPattern(origin: string): string {
  return `${origin}/*`;
}

// ---------------------------------------------------------------------------
// Typed bus — thin wrappers so callers never touch chrome.runtime.sendMessage
// or chrome.tabs.sendMessage directly. Each wrapper validates the reply at
// the boundary and throws on shape mismatch, so callers get a typed value or
// a clear error.
// ---------------------------------------------------------------------------

/** Send a typed message to the service worker, get a typed reply. Callable
 *  from any extension surface (panel, content, popup). Throws on malformed
 *  replies so the caller can surface the breakage rather than silently
 *  proceeding with `undefined`. */
export async function sendToSw(msg: PanelMsg): Promise<SwToPanel> {
  const reply: unknown = await chrome.runtime.sendMessage(msg);
  if (!isSwToPanel(reply)) {
    throw new Error(`SW returned malformed reply: ${JSON.stringify(reply)}`);
  }
  return reply;
}

/** Send a typed message from the panel to a specific tab's content script.
 *  Throws if the tab has no listener (extension not enabled there) or if
 *  the reply doesn't match the contract. */
export async function sendToContent(tabId: number, msg: PanelToContent): Promise<ContentReply> {
  const reply: unknown = await chrome.tabs.sendMessage(tabId, msg);
  if (!isContentReply(reply)) {
    throw new Error(`content returned malformed reply: ${JSON.stringify(reply)}`);
  }
  return reply;
}

/** Fire-and-forget push from the content script to the panel. The panel may
 *  not be open — we swallow the "Receiving end does not exist" rejection
 *  rather than surfacing it. */
export function pushToPanel(msg: ContentToPanel): void {
  // chrome.runtime.sendMessage from a content script targets all extension
  // pages (panel + SW). Both see it; the SW ignores anything not on its
  // contract, the panel acts on it.
  void chrome.runtime.sendMessage(msg).catch(() => undefined);
}
