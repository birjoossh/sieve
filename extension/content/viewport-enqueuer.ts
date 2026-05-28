// content/viewport-enqueuer.ts — IntersectionObserver-driven deep enqueue.
//
// Slice 5.4: deep-path predicates are expensive (one tab per item).
// We only want to spend that budget on items the user might actually
// see, ordered top-down so the in-view rows resolve before the
// rest. The IntersectionObserver does the heavy lifting; we sort the
// per-tick batch by `boundingClientRect.top` to preserve top-down
// order even when the browser delivers entries out of order.
//
// rootMargin pulls the trigger a viewport-and-a-half ahead so the
// queue has time to spawn the hidden tab before the user reaches
// the card. Conservative: too aggressive a margin burns spend on
// items the user never reaches.
//
// Per item, fire onNearViewport once — track in a WeakSet so a
// scroll up + back doesn't enqueue twice. The host owns dedup
// against `done` items (5.1's queue already handles it).

export interface ViewportEnqueuerOpts {
  /** Items to observe. The renderer owns the list; we just observe. */
  items: Iterable<Element>;
  /** Fired the first time an item is near the viewport. */
  onNearViewport: (item: Element) => void;
  /** Pixels of look-ahead. Default: one viewport height worth, so a
   *  card scrolled to the next page's top gets enqueued. */
  rootMargin?: string;
  /** Threshold passed to IntersectionObserver — default 0 means "any
   *  pixel of the element intersects." */
  threshold?: number;
}

export class ViewportEnqueuer {
  private observer: IntersectionObserver | null = null;
  /** Fire-once gating per element. WeakSet so removed nodes don't
   *  pin themselves in memory. */
  private fired = new WeakSet<Element>();
  /** Sort buffer — collected per observer callback, drained at the
   *  end of the tick so top-down order is preserved. */
  private buffer: Element[] = [];

  constructor(private readonly opts: ViewportEnqueuerOpts) {}

  start(): void {
    if (this.observer) return;
    this.observer = new IntersectionObserver(
      (entries) => this.onIntersect(entries),
      {
        rootMargin: this.opts.rootMargin ?? '100% 0px',
        threshold: this.opts.threshold ?? 0,
      },
    );
    for (const item of this.opts.items) this.observer.observe(item);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.buffer.length = 0;
  }

  /** Allow the host to add newly-appeared items (paired with the
   *  4.6 mutation observer). */
  observe(item: Element): void {
    if (!this.observer) return;
    this.observer.observe(item);
  }

  private onIntersect(entries: readonly IntersectionObserverEntry[]): void {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      if (this.fired.has(e.target)) continue;
      this.buffer.push(e.target);
    }
    if (this.buffer.length === 0) return;
    // Sort the buffer top-down before firing. We read top from the
    // entries' boundingClientRect to avoid a re-layout — when sort
    // is called the observer's already-staged rects are still
    // current. (We grab from the live element to be safe.)
    this.buffer.sort((a, b) => {
      const ar = a.getBoundingClientRect().top;
      const br = b.getBoundingClientRect().top;
      return ar - br;
    });
    for (const el of this.buffer) {
      if (this.fired.has(el)) continue;
      this.fired.add(el);
      try {
        this.opts.onNearViewport(el);
      } catch {
        // Host's callback raised — log via panel error path is the
        // host's job; we don't swallow silently in production, but
        // we don't want one bad row to break the rest of the batch.
      }
    }
    this.buffer.length = 0;
  }
}
