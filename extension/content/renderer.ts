// content/renderer.ts — the only part of the extension that mutates the page.
//
// Slice-1 scope (list layout only):
//   - Wrap each filtered item in `.filt` so site CSS can't reach the original
//     `<article class="job">` from sibling positional selectors; insert a
//     horizontal `.sliver` placeholder next to it.
//   - Never touch passing items. Their outerHTML stays byte-identical to the
//     page's original (the renderer instead tracks identity via a WeakMap).
//   - The `↺ re-hide` marker + click-to-toggle ride in 1.5.
//   - The collapse | hide DISPLAY mode (`.mode-hide` on the item-set) rides
//     in 1.8.
//
// All scoped CSS is injected into the document head exactly once per
// renderer instance — Slice 6 will namespace these classes if collisions
// turn out to bite.

import type { DisplayMode, ItemSummary, Schema } from '../shared/types.js';
import type { ItemVerdict } from './engine.js';

const STYLE_EL_ID = 'nf-injected-styles';

/** Styles injected into the host page. Kept narrow:
 *    - hide the real card when its wrapper is .filt (and not .restored)
 *    - render the sliver as a single thin horizontal strip
 *    - re-hide marker styling lands in 1.5
 *    - mode-hide rule lands in 1.8
 */
const STYLES = `
.filt > .nf-card-hidden { display: none; }
.filt > .sliver {
  display: block;
  height: 28px;
  line-height: 28px;
  padding: 0 10px;
  font: 12px/28px system-ui, -apple-system, Segoe UI, sans-serif;
  color: #57606a;
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  text-align: left;
  width: 100%;
  box-sizing: border-box;
}
.filt > .sliver:hover { background: #eaeef2; }
.filt.restored > .sliver { display: none; }
.filt.restored > .nf-card-hidden { display: block; }
.filt > .rehide { display: none; }
.filt.restored > .rehide {
  display: inline-block;
  margin-top: 4px;
  padding: 2px 8px;
  font: 11px/1 system-ui, -apple-system, Segoe UI, sans-serif;
  color: #57606a;
  background: transparent;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  cursor: pointer;
}
.mode-hide > .filt:not(.restored) { display: none; }
/* Carousel layout (Slice 2.5): a narrow vertical sliver replaces the card
   width-wise so the horizontal track keeps the same flex shape; reason
   text is rotated to read top-to-bottom. */
.filt.layout-carousel {
  flex: 0 0 46px;
  width: 46px;
  min-width: 46px;
  align-self: stretch;
}
.filt.layout-carousel > .sliver-v {
  display: block;
  width: 100%;
  min-height: 120px;
  height: 100%;
  padding: 8px 6px;
  font: 12px/1.2 system-ui, -apple-system, Segoe UI, sans-serif;
  color: #57606a;
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  box-sizing: border-box;
  writing-mode: vertical-rl;
  text-align: left;
  overflow: hidden;
}
.filt.layout-carousel > .sliver-v:hover { background: #eaeef2; }
.filt.layout-carousel.restored > .sliver-v { display: none; }
/* Grid layout (Slice 2.6): wrapper still occupies exactly one grid cell so
   the column count and row pack stay stable; a .ctile placeholder fills
   the cell footprint and signals "hidden item." No flex sizing — the host
   grid template already gives the wrapper the right cell. */
.filt.layout-grid > .ctile {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60px;
  height: 100%;
  width: 100%;
  padding: 12px;
  font: 12px/1.3 system-ui, -apple-system, Segoe UI, sans-serif;
  color: #57606a;
  background: #f6f8fa;
  border: 1px dashed #d0d7de;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
  text-align: center;
  box-sizing: border-box;
}
.filt.layout-grid > .ctile:hover { background: #eaeef2; }
.filt.layout-grid.restored > .ctile { display: none; }
/* Checking state (Slice 5.7): items mid-deep-scan get a small inline
   spinner. We add an absolutely-positioned indicator element rather
   than restyling the card so the passing-card outerHTML still snaps
   back to identical when the spinner is removed. */
.nf-check-mark {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  font: 11px/1.2 system-ui, -apple-system, Segoe UI, sans-serif;
  color: #57606a;
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  vertical-align: middle;
}
/* Detached mode: React-managed lists revert reparented rows on their next
   reconciliation pass (LinkedIn v2 LazyColumn), so filtered items are
   collapsed in place via class + data attributes only — never wrapped, no
   sibling nodes inserted into the React-owned parent. The reason text and
   both click affordances are pseudo-elements so the item subtree stays
   byte-compatible with what React expects. !important because we are
   overriding site CSS (and possibly inline virtualization sizing) on the
   site's own elements. */
.nf-filt-item:not(.nf-restored) {
  position: relative !important;
  height: 28px !important;
  min-height: 28px !important;
  max-height: 28px !important;
  padding: 0 !important;
  overflow: hidden !important;
  box-sizing: border-box !important;
  cursor: pointer;
}
.nf-filt-item:not(.nf-restored) > * {
  visibility: hidden !important;
}
.nf-filt-item:not(.nf-restored)::before {
  content: attr(data-nf-reason);
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 28px;
  padding: 0 10px;
  font: 12px/26px system-ui, -apple-system, Segoe UI, sans-serif;
  color: #57606a;
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  box-sizing: border-box;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  z-index: 2;
}
.nf-filt-item:not(.nf-restored):hover::before { background: #eaeef2; }
/* Restored state: the card renders normally; a small in-flow bar at the top
   (pseudo-element, so still zero inserted nodes) is the re-hide affordance.
   The click handler only honors clicks landing on the item element itself
   within the bar zone, so the card's own links/buttons keep working. */
.nf-filt-item.nf-restored::before {
  content: '↺ re-hide';
  display: block;
  height: 20px;
  padding: 0 10px;
  margin-bottom: 4px;
  font: 11px/18px system-ui, -apple-system, Segoe UI, sans-serif;
  color: #57606a;
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  box-sizing: border-box;
  cursor: pointer;
  user-select: none;
}
.mode-hide .nf-filt-item:not(.nf-restored) { display: none !important; }
/* Table rows need their own detached treatment: visibility:hidden cells
   still occupy their full height, and an absolutely-positioned reason bar
   contributes nothing to a row whose cells are gone. Hide the cells
   entirely and let the reason render as an anonymous cell so the row
   keeps a 28px footprint. No re-hide bar on restored rows — a block
   pseudo-element would be wrapped into an anonymous first cell and shift
   every real cell over by one column; the panel's HIDDEN list covers
   re-hide for tables. */
tr.nf-filt-item:not(.nf-restored) > * { display: none !important; }
tr.nf-filt-item:not(.nf-restored)::before {
  position: static;
  display: table-cell;
  height: 28px;
}
tr.nf-filt-item.nf-restored::before { content: none; }
tr.nf-companion-hidden { display: none !important; }
`;

/** Clicks on a restored detached item re-hide only when they land within
 *  this many px of the item's top — the pseudo-element bar zone. Anything
 *  lower is the card's own content. */
const DETACHED_BAR_PX = 40;

/** Items with these tags live inside table layout, where inserting a div
 *  wrapper is invalid HTML and breaks rendering of the whole table. */
const TABLE_PART_TAGS = new Set(['TR', 'TD', 'TH', 'TBODY', 'THEAD', 'TFOOT']);

/** Upper bound on the companion-row walk (HN needs 2: subtext + spacer). */
const MAX_COMPANION_ROWS = 3;

function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_EL_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_EL_ID;
  style.textContent = STYLES;
  doc.head.appendChild(style);
}

export interface RendererOptions {
  schema: Schema;
  /** Container element (`.joblist` for rolecast). The `mode-hide` class
   *  is toggled on this element in 1.8. */
  itemSet: Element;
  doc?: Document;
  /** Click handler the panel wires up to flip restored state. Receives the
   *  item id and the new `restored` value. Lands in 1.5. */
  onRestoreToggle?: (itemId: string, restored: boolean) => void;
}

export class Renderer {
  private readonly opts: Required<Pick<RendererOptions, 'schema' | 'itemSet' | 'doc'>> & {
    onRestoreToggle?: RendererOptions['onRestoreToggle'];
  };
  private readonly idByItem = new WeakMap<Element, string>();
  /** Per-item .filt wrapper — present iff the item is currently filtered. */
  private readonly wrapperByItem = new WeakMap<Element, HTMLElement>();
  /** Reverse lookup so click handlers (1.5) can resolve id → item. */
  private readonly itemById = new Map<string, Element>();
  private readonly restored = new Set<string>();
  /** Slice 5.7: items currently in the "checking" state (deep scan in
   *  flight). Cleared once the engine apply() resolves them. */
  private readonly checking = new Set<string>();
  /** Spinner element per checking item — held so we can remove it
   *  cleanly without re-querying. */
  private readonly checkMarkById = new Map<string, HTMLElement>();
  private nextId = 0;
  private lastSummaries: ItemSummary[] = [];
  /** `wrap` reparents into `.filt`; `detached` only mutates class/data
   *  attributes on the item. Starts from the schema, but flips to
   *  `detached` permanently if a React reconciler is caught reverting our
   *  wrappers (auto-fallback for unknown React sites). */
  private renderMode: 'wrap' | 'detached';
  /** Items currently filtered in detached mode, with their verdicts — the
   *  self-heal observer needs an iterable (WeakMap can't be walked) and the
   *  verdict to restore `data-nf-reason` after React strips it. */
  private readonly detachedFiltered = new Map<Element, ItemVerdict>();
  /** HN-style tables split one logical item across several <tr>s (title
   *  row + subtext row + spacer); only the title row matches itemSelector.
   *  Companion rows are hidden/shown in lock-step with their item. */
  private readonly companionsByItem = new Map<Element, Element[]>();
  /** Last verdict set, kept so the heal path can re-apply after the
   *  wrap → detached fallback without waiting for the next engine pass. */
  private lastVerdicts: Map<Element, ItemVerdict> | null = null;
  private healObserver: MutationObserver | null = null;
  private healQueued = false;

  constructor(opts: RendererOptions) {
    const doc = opts.doc ?? opts.itemSet.ownerDocument ?? document;
    this.opts = {
      schema: opts.schema,
      itemSet: opts.itemSet,
      doc,
      onRestoreToggle: opts.onRestoreToggle,
    };
    this.renderMode = opts.schema.renderMode ?? 'wrap';
    injectStyles(doc);
    // Document-level + capture so the toggle works even when the site's own
    // handlers (LinkedIn cards are role=button) would otherwise navigate.
    doc.addEventListener('click', this.onDocClick, true);
    this.installHealObserver();
  }

  /** Detach document listeners + the heal observer. Must be called when a
   *  new renderer replaces this one (re-mount) — a stale instance would
   *  otherwise keep healing items the new renderer no longer filters. */
  disconnect(): void {
    this.healObserver?.disconnect();
    this.healObserver = null;
    this.opts.doc.removeEventListener('click', this.onDocClick, true);
  }

  /** Apply a fresh set of verdicts. Idempotent — re-applying with the same
   *  inputs is a DOM no-op. Returns one summary per item, in input order. */
  apply(verdicts: Map<Element, ItemVerdict>): ItemSummary[] {
    this.lastVerdicts = verdicts;
    // Table parts can never be wrapped: a <div> wrapper inside <tbody>
    // is invalid table structure and collapses the whole table (seen
    // live on news.ycombinator.com — every passing row vanished). The
    // revert-detection below can't catch this because the wrapper stays
    // connected; the layout just breaks.
    if (this.renderMode === 'wrap' && this.tablePartItems(verdicts)) {
      this.switchToDetached();
    }
    // Auto-fallback: a wrapper we created is gone from the document while
    // its item survived — a framework reconciler ripped it out. Wrapping
    // will never stick on this page, so flip to detached for good.
    if (this.renderMode === 'wrap' && this.wrapRevertDetected()) {
      this.switchToDetached();
    }
    const summaries: ItemSummary[] = [];
    for (const [item, verdict] of verdicts) {
      // 6.1: virtualized lists recycle DOM elements — same Element
      // reference, new data-id. Detect the swap by comparing the
      // cached id (per Element) against the element's current
      // identity key (data-id when present). If they diverge, unwrap
      // + forget the old id before assigning a fresh one. The new
      // verdict drives the render path from a clean slate.
      this.handleRecycledItem(item);
      const id = this.ensureId(item);
      const label = this.readLabel(item);

      if (verdict.state === 'filtered') {
        if (this.renderMode === 'detached') {
          this.applyDetached(item, verdict, id);
        } else if (!this.wrapperByItem.has(item)) {
          this.wrap(item, verdict, id);
        } else {
          this.refreshSliver(item, verdict);
        }
      } else if (verdict.state === 'passing') {
        if (this.renderMode === 'detached') {
          if (this.detachedFiltered.has(item)) this.clearDetached(item, id);
        } else if (this.wrapperByItem.has(item)) {
          this.unwrap(item, id);
        }
      }

      // 5.7: the engine's verdict resolves the checking state once
      // deep data is in. Drop the checking flag + spinner now that
      // the verdict is definitive.
      if (this.checking.has(id) && verdict.state !== 'checking') {
        this.checking.delete(id);
        this.removeCheckMark(id);
      }

      // Reported state folds the per-item restored bit into the engine's
      // verdict so callers (the panel) see a single source of truth.
      const reportedState =
        verdict.state === 'filtered' && this.restored.has(id) ? 'restored' : verdict.state;

      const summary: ItemSummary = { id, state: reportedState };
      if (verdict.reason !== undefined) summary.reason = verdict.reason;
      if (label !== undefined) summary.label = label;
      summaries.push(summary);
    }
    this.lastSummaries = summaries;
    return summaries;
  }

  /** Flip a single item's restored flag. Reflected in the DOM (the wrapper
   *  gets `.restored`) and in subsequent summaries. */
  setRestored(itemId: string, restored: boolean): void {
    const item = this.itemById.get(itemId);
    if (!item) return;
    if (this.renderMode === 'detached') {
      if (!this.detachedFiltered.has(item)) return; // not filtered — nothing to restore
      if (restored) {
        this.restored.add(itemId);
        item.classList.add('nf-restored');
      } else {
        this.restored.delete(itemId);
        item.classList.remove('nf-restored');
      }
      if (item.tagName === 'TR') this.syncCompanions(item, !restored);
    } else {
      const wrapper = this.wrapperByItem.get(item);
      if (!wrapper) return; // item isn't filtered — nothing to restore
      if (restored) {
        this.restored.add(itemId);
        wrapper.classList.add('restored');
      } else {
        this.restored.delete(itemId);
        wrapper.classList.remove('restored');
      }
    }
    // Keep the cached summaries coherent so callers reading them between
    // engine runs see the latest restored bit.
    const summary = this.lastSummaries.find((s) => s.id === itemId);
    if (summary) summary.state = restored ? 'restored' : 'filtered';
  }

  /** Slice 5.7: mark an item as actively being deep-scanned. The
   *  renderer adds a small spinner indicator next to it; once the
   *  engine produces a `filtered` or `passing` verdict (next apply
   *  call), the spinner is removed and the verdict takes effect. */
  setChecking(itemId: string, on: boolean): void {
    const item = this.itemById.get(itemId);
    if (!item) return;
    if (on) {
      if (this.checking.has(itemId)) return;
      this.checking.add(itemId);
      const mark = this.opts.doc.createElement('span');
      mark.className = 'nf-check-mark';
      mark.dataset['nfId'] = itemId;
      mark.textContent = '⏳ checking…';
      item.appendChild(mark);
      this.checkMarkById.set(itemId, mark);
      // Update cached summary so the panel sees the checking state
      // without waiting for the next engine pass.
      const summary = this.lastSummaries.find((s) => s.id === itemId);
      if (summary) summary.state = 'checking';
    } else {
      this.checking.delete(itemId);
      this.removeCheckMark(itemId);
    }
  }

  /** Toggle the display mode on the item-set container. Slice 1.8 gate. */
  setMode(mode: DisplayMode): void {
    if (mode === 'hide') this.opts.itemSet.classList.add('mode-hide');
    else this.opts.itemSet.classList.remove('mode-hide');
  }

  /** Latest summaries (state + label + reason) for every item the engine
   *  has evaluated. Survives between renderer.apply() calls. */
  summaries(): readonly ItemSummary[] {
    return this.lastSummaries;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private ensureId(item: Element): string {
    let id = this.idByItem.get(item);
    if (id !== undefined) return id;
    // Prefer a stable per-item identity (data-id, then LinkedIn's
    // componentkey). The componentkey-derived id also lets
    // handleRecycledItem clean up when virtualization re-assigns the same
    // DOM node to a different job. Fall back to a synthetic monotonic id.
    id = this.currentIdentityKey(item) ?? `nf-${++this.nextId}`;
    this.idByItem.set(item, id);
    this.itemById.set(id, item);
    return id;
  }

  /** 6.1: identity-by-content for virtualized lists. The cached id
   *  for an element is stable as long as the element's data-id (or
   *  fallback synthetic id) stays the same. When a virtualizer
   *  recycles the element with a different data-id, we treat it as
   *  a new item — unwrap the old `.filt` wrapper (if any), drop the
   *  restored/checking flags scoped to the previous id, and clear
   *  the cache entry so ensureId() can re-mint. */
  private handleRecycledItem(item: Element): void {
    const cached = this.idByItem.get(item);
    if (cached === undefined) return;
    const current = this.currentIdentityKey(item);
    if (current === null) return; // synthetic id — no recycling signal
    if (cached === current) return;
    // Recycled. Reset everything keyed by the old id.
    if (this.wrapperByItem.has(item)) this.unwrap(item, cached);
    if (this.detachedFiltered.has(item)) this.clearDetached(item, cached);
    this.restored.delete(cached);
    if (this.checking.has(cached)) {
      this.checking.delete(cached);
      this.removeCheckMark(cached);
    }
    this.itemById.delete(cached);
    this.idByItem.delete(item);
  }

  private currentIdentityKey(item: Element): string | null {
    const dataId = item.getAttribute('data-id');
    if (dataId && dataId.length > 0) return dataId;
    // LinkedIn's new `/jobs/search-results/` LazyColumn keys each card by
    // `componentkey="job-card-component-ref-<jobId>"`. Use it (self-or-
    // descendant) so virtualization-recycled cards trigger wrapper unwrap
    // instead of carrying a stale filter verdict across job rotations.
    const componentHost = item.matches('[componentkey^="job-card-component-ref-"]')
      ? item
      : item.querySelector('[componentkey^="job-card-component-ref-"]');
    const key = componentHost?.getAttribute('componentkey');
    return key && key.length > 0 ? key : null;
  }

  private readLabel(item: Element): string | undefined {
    // The "title" field, when defined on the schema, is the natural label
    // for the HIDDEN list (1.7). Fall back to the first text-kind field.
    const fields = this.opts.schema.fields;
    const candidates = ['title', ...Object.keys(fields)];
    for (const name of candidates) {
      const f = fields[name];
      if (!f || f.kind !== 'text') continue;
      const el = item.querySelector(f.selector);
      const text = el?.textContent?.trim();
      if (text && text.length > 0) return text;
    }
    // Local/stub schemas often ship empty fields — without this fallback
    // the panel's HIDDEN list degrades to synthetic ids (nf-1, nf-4 …),
    // which is meaningless to the user (seen live on news.ycombinator.com).
    const whole = item.textContent?.replace(/\s+/g, ' ').trim();
    if (whole && whole.length > 0) {
      return whole.length > 64 ? `${whole.slice(0, 63)}…` : whole;
    }
    return undefined;
  }

  private wrap(item: Element, verdict: ItemVerdict, id: string): void {
    const doc = this.opts.doc;
    const layout = this.opts.schema.layout;
    const wrapper = doc.createElement('div');
    wrapper.className =
      layout === 'carousel'
        ? 'filt layout-carousel'
        : layout === 'grid'
          ? 'filt layout-grid'
          : 'filt';
    wrapper.dataset['nfId'] = id;

    const sliver = doc.createElement('button');
    sliver.type = 'button';
    sliver.className =
      layout === 'carousel' ? 'sliver-v' : layout === 'grid' ? 'ctile' : 'sliver';
    sliver.dataset['nfId'] = id;
    sliver.setAttribute('aria-label', `Restore hidden item: ${this.readLabel(item) ?? id}`);
    sliver.textContent = this.sliverText(verdict);
    sliver.addEventListener('click', () => this.opts.onRestoreToggle?.(id, true));

    const rehide = doc.createElement('button');
    rehide.type = 'button';
    rehide.className = 'rehide';
    rehide.dataset['nfId'] = id;
    rehide.setAttribute('aria-label', `Re-hide ${this.readLabel(item) ?? id}`);
    rehide.textContent = '↺ re-hide';
    rehide.addEventListener('click', () => this.opts.onRestoreToggle?.(id, false));

    // Slot the wrapper in where the item lives, then move the item inside.
    // We tag the item with .nf-card-hidden purely so the CSS rule that
    // hides it doesn't accidentally hit the rehide/sliver children — class
    // is removed on unwrap so the byte-identical contract for passing
    // items still holds.
    item.classList.add('nf-card-hidden');
    item.replaceWith(wrapper);
    wrapper.appendChild(item);
    wrapper.appendChild(sliver);
    wrapper.appendChild(rehide);

    this.wrapperByItem.set(item, wrapper);
    // restored flag carries across re-renders, so re-mirror it.
    if (this.restored.has(id)) wrapper.classList.add('restored');
  }

  private refreshSliver(item: Element, verdict: ItemVerdict): void {
    const wrapper = this.wrapperByItem.get(item);
    if (!wrapper) return;
    const sliver = wrapper.querySelector<HTMLButtonElement>('.sliver, .sliver-v, .ctile');
    if (sliver) sliver.textContent = this.sliverText(verdict);
  }

  private unwrap(item: Element, id: string): void {
    const wrapper = this.wrapperByItem.get(item);
    if (!wrapper) return;
    // Remove the .nf-card-hidden helper before reinstating the item so its
    // outerHTML matches the page's original markup byte-for-byte.
    item.classList.remove('nf-card-hidden');
    wrapper.replaceWith(item);
    this.wrapperByItem.delete(item);
    this.restored.delete(id);
  }

  // -------------------------------------------------------------------------
  // Detached mode + self-heal
  // -------------------------------------------------------------------------

  /** Idempotent: re-applying the expected state is what the heal loop does,
   *  so this must converge instead of generating fresh mutations forever —
   *  attributes are only written when they actually diverge. */
  private applyDetached(item: Element, verdict: ItemVerdict, id: string): void {
    this.detachedFiltered.set(item, verdict);
    const reason = this.sliverText(verdict);
    if (item.getAttribute('data-nf-reason') !== reason) {
      item.setAttribute('data-nf-reason', reason);
    }
    if (item.getAttribute('data-nf-id') !== id) {
      item.setAttribute('data-nf-id', id);
    }
    item.classList.add('nf-filt-item');
    if (this.restored.has(id)) item.classList.add('nf-restored');
    else item.classList.remove('nf-restored');
    if (item.tagName === 'TR') this.syncCompanions(item, !this.restored.has(id));
  }

  /** Following sibling <tr>s up to the next known item — the subtext /
   *  spacer rows that visually belong to this row. Capped so a generic
   *  table can't make the walk swallow unrelated rows. */
  private companionsOf(item: Element): Element[] {
    let companions = this.companionsByItem.get(item);
    if (companions) return companions;
    companions = [];
    let sib = item.nextElementSibling;
    while (
      sib &&
      sib.tagName === 'TR' &&
      companions.length < MAX_COMPANION_ROWS &&
      !(this.lastVerdicts?.has(sib) ?? false) &&
      !sib.classList.contains('nf-filt-item')
    ) {
      companions.push(sib);
      sib = sib.nextElementSibling;
    }
    this.companionsByItem.set(item, companions);
    return companions;
  }

  private syncCompanions(item: Element, hidden: boolean): void {
    for (const c of this.companionsOf(item)) {
      if (hidden) c.classList.add('nf-companion-hidden');
      else c.classList.remove('nf-companion-hidden');
    }
  }

  private clearDetached(item: Element, id: string): void {
    this.detachedFiltered.delete(item);
    item.classList.remove('nf-filt-item');
    item.classList.remove('nf-restored');
    item.removeAttribute('data-nf-reason');
    item.removeAttribute('data-nf-id');
    this.restored.delete(id);
    if (item.tagName === 'TR') {
      this.syncCompanions(item, false);
      this.companionsByItem.delete(item);
    }
  }

  private tablePartItems(verdicts: Map<Element, ItemVerdict>): boolean {
    const first = verdicts.keys().next();
    return !first.done && TABLE_PART_TAGS.has(first.value.tagName);
  }

  private wrapRevertDetected(): boolean {
    for (const item of this.itemById.values()) {
      const wrapper = this.wrapperByItem.get(item);
      if (wrapper && !wrapper.isConnected && item.isConnected) return true;
    }
    return false;
  }

  /** One-way: once a reconciler has been caught reverting wrappers there is
   *  no point ever wrapping again on this page. Connected wrappers are
   *  unwound by hand (not via unwrap()) so the restored flags survive the
   *  mode flip. */
  private switchToDetached(): void {
    this.renderMode = 'detached';
    for (const item of this.itemById.values()) {
      const wrapper = this.wrapperByItem.get(item);
      if (!wrapper) continue;
      item.classList.remove('nf-card-hidden');
      if (wrapper.isConnected) wrapper.replaceWith(item);
      this.wrapperByItem.delete(item);
    }
  }

  private installHealObserver(): void {
    this.healObserver = new MutationObserver(() => this.scheduleHeal());
    this.healObserver.observe(this.opts.itemSet, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-nf-reason', 'data-nf-id'],
    });
  }

  private scheduleHeal(): void {
    if (this.healQueued) return;
    this.healQueued = true;
    queueMicrotask(() => {
      this.healQueued = false;
      this.heal();
    });
  }

  /** Re-establish renderer-owned state that a framework re-render stripped.
   *  Only acts when expected and actual state diverge, so the observer
   *  feedback loop terminates: our own writes converge to a no-op pass. */
  private heal(): void {
    if (this.renderMode === 'wrap') {
      if (!this.wrapRevertDetected()) return;
      this.switchToDetached();
      if (this.lastVerdicts) this.apply(this.lastVerdicts);
      return;
    }
    for (const [item, verdict] of this.detachedFiltered) {
      if (!item.isConnected) continue;
      const id = this.idByItem.get(item);
      if (id === undefined) continue;
      if (this.detachedStateDiverged(item, verdict, id)) {
        this.applyDetached(item, verdict, id);
      }
    }
  }

  private detachedStateDiverged(item: Element, verdict: ItemVerdict, id: string): boolean {
    if (!item.classList.contains('nf-filt-item')) return true;
    if (item.getAttribute('data-nf-reason') !== this.sliverText(verdict)) return true;
    if (item.getAttribute('data-nf-id') !== id) return true;
    return item.classList.contains('nf-restored') !== this.restored.has(id);
  }

  private readonly onDocClick = (e: MouseEvent): void => {
    if (this.renderMode !== 'detached') return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    const itemEl = target.closest('.nf-filt-item');
    if (!itemEl || !this.detachedFiltered.has(itemEl)) return;
    const id = this.idByItem.get(itemEl);
    if (id === undefined) return;
    if (!itemEl.classList.contains('nf-restored')) {
      // Collapsed: the whole bar restores. Swallow the event so the site's
      // own card handler (role=button navigation) doesn't also fire.
      e.preventDefault();
      e.stopPropagation();
      this.opts.onRestoreToggle?.(id, true);
      return;
    }
    // Restored: only direct hits on the item element inside the top bar
    // zone re-hide. Clicks on descendants are the card's own links/buttons
    // and must pass through untouched.
    if (target !== itemEl) return;
    if (e.clientY - itemEl.getBoundingClientRect().top > DETACHED_BAR_PX) return;
    e.preventDefault();
    e.stopPropagation();
    this.opts.onRestoreToggle?.(id, false);
  };

  private sliverText(verdict: ItemVerdict): string {
    return verdict.reason ? `Hidden — ${verdict.reason}` : 'Hidden';
  }

  private removeCheckMark(itemId: string): void {
    const mark = this.checkMarkById.get(itemId);
    if (!mark) return;
    mark.remove();
    this.checkMarkById.delete(itemId);
  }
}
