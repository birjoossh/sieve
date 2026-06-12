// content/mutations.ts — MutationObserver that re-evaluates the engine
// when new items appear in the watched item-set.
//
// Slice 1 captured items once at init() (memory.md 2026-05-23): "never
// re-query itemSelector after the renderer wraps." Re-running
// `findItems` would lose wrapped cards because `.joblist > .job` no
// longer matches `.joblist > .filt > .job`. Slice 4.6 keeps that
// invariant — instead of re-querying everything, we watch for added
// nodes that match the original item shape and append them to the
// stable list.
//
// Debounce reasoning: real sites (LinkedIn feed, Twitter/X) commit a
// batch via one `appendChild` of a DocumentFragment, but also commit
// per-row (one mutation per appended row). A microtask debounce
// collapses both into one engine pass.
//
// What we DON'T do here:
//   - We don't re-detect the item-set. The watcher's container is
//     fixed at start(). If the host site rebuilds the whole .joblist
//     (rare; usually means SPA navigation), that's a fresh page-detect
//     event handled outside this watcher.
//   - We don't react to *removals*. Items removed from the DOM
//     naturally drop out of the engine's per-frame evaluation; the
//     renderer holds no references that survive removal.

export interface MutationWatcherOpts {
  /** The container whose direct children are the engine's items. Same
   *  element the renderer mounts on. */
  itemSet: Element;
  /** CSS selector the engine uses for items. We filter added nodes by
   *  matches() against this so unrelated elements (sliver wrappers,
   *  the renderer's own injected markup) don't get added as items. */
  itemSelector: string;
  /** Fired once per debounced batch of added items that match the
   *  schema. Engine runs in the host; we only enumerate. */
  onItemsAdded: (added: Element[]) => void;
}

export class MutationWatcher {
  private observer: MutationObserver | null = null;
  private pending = new Set<Element>();
  private flushScheduled = false;

  constructor(private readonly opts: MutationWatcherOpts) {}

  start(): void {
    if (this.observer) return;
    this.observer = new MutationObserver((mutations) => {
      this.queue(mutations);
    });
    // subtree is required: virtualized lists (LinkedIn's v2 LazyColumn
    // pagination) replace a nested wrapper whose CHILDREN are the cards —
    // with childList-only on the itemSet, those cards never surface and
    // filters silently stop applying on page 2 (user-reported live).
    this.observer.observe(this.opts.itemSet, { childList: true, subtree: true });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.pending.clear();
    this.flushScheduled = false;
  }

  private queue(mutations: MutationRecord[]): void {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        // Exact item shape only: matches() against the schema's
        // itemSelector — but NEVER renderer-owned nodes. For a classed
        // selector they self-skip, but a tag-only scoped selector
        // (`div.list > div`, github.com search) matches the renderer's
        // own `.filt` wrapper: ingesting it loops forever (wrap →
        // observe wrapper → treat as item → filter → wrap the wrapper).
        if (this.isRendererNode(node)) continue;
        if (this.matchesItem(node)) {
          this.pending.add(node);
        } else if (node.childElementCount > 0) {
          // The added node may be a WRAPPER carrying items (LazyColumn
          // pagination swaps a whole page wrapper in one mutation).
          for (const nested of this.queryItems(node)) {
            if (!this.isRendererNode(nested)) this.pending.add(nested);
          }
        }
      }
    }
    if (this.pending.size === 0) return;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private isRendererNode(el: Element): boolean {
    return el.matches('.filt, .sliver, .sliver-v, .ctile, .rehide, .nf-check-mark');
  }

  private matchesItem(el: Element): boolean {
    try {
      return el.matches(this.opts.itemSelector);
    } catch {
      // Defensive: an itemSelector with `:has()` on a really old
      // engine can throw — drop rather than crash the observer.
      return false;
    }
  }

  private queryItems(root: Element): Element[] {
    try {
      return Array.from(root.querySelectorAll(this.opts.itemSelector));
    } catch {
      return [];
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.pending.size === 0) return;
    const added = Array.from(this.pending);
    this.pending.clear();
    this.opts.onItemsAdded(added);
  }
}
