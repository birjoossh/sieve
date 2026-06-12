// content/deep-text.ts — fetch each item's full detail text (LinkedIn job
// descriptions, article bodies) so the free-text keyword filter can match
// content that isn't on the card itself.
//
// Why this exists: LinkedIn (and most job boards) put only title / company /
// location on the list card; the actual description — where terms like
// "Mandarin", "on-site", "clearance" live — is on the detail page. The engine
// folds the text fetched here into ALL_TEXT_FIELD matching (engine.ts).
//
// Strategy: a same-origin fetch of a SERVER-RENDERED detail endpoint, then
// strip tags and match the whole response text. Whole-text matching degrades
// gracefully — a login-walled or empty response simply won't contain the
// keyword (a miss), never a false hide. For LinkedIn we hit the public
// `jobs-guest/jobs/api/jobPosting/<id>` endpoint, which is server-rendered
// (no JS needed) so a plain fetch sees the description. Other sites fall back
// to fetching the card's own anchor href.
//
// Throttled (small worker pool + spacing) and cached by URL so re-evaluating
// filters never re-fetches, and we don't hammer the origin.

/** A fetchable URL that returns server-rendered text for `item`'s detail, or
 *  null when the card exposes no usable link. */
export function itemDetailUrl(item: Element): string | null {
  // LinkedIn job card → public guest job-posting endpoint (server-rendered).
  // We probe several id sources because LinkedIn ships multiple coexisting
  // layouts. Order goes most-recent first so the new structure wins; older
  // pages fall through.
  //
  //   1. NEW (2026-06): `componentkey="job-card-component-ref-<id>"` on a
  //      <div role="button"> wrapper (LazyColumn-based /jobs/search-results/).
  //   2. LEGACY: `data-occludable-job-id` / `data-job-id` on the <li>
  //      (works for occluded cards too, where /jobs/view/ anchors don't render).
  //   3. Last-resort anchor: `a[href*="/jobs/view/<id>"]` (only for visible
  //      cards on the legacy layout).
  //
  // Self-or-descendant only — never an ancestor, which could be shared by
  // sibling cards and hand every item the same id.
  const componentHost = item.matches('[componentkey^="job-card-component-ref-"]')
    ? item
    : item.querySelector('[componentkey^="job-card-component-ref-"]');
  const componentKey = componentHost?.getAttribute('componentkey') ?? '';
  const newLayoutMatch = componentKey.match(/^job-card-component-ref-(\d+)$/);
  if (newLayoutMatch) {
    return `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${newLayoutMatch[1]}`;
  }

  const idHost = item.matches('[data-occludable-job-id]')
    ? item
    : item.querySelector('[data-occludable-job-id]') ??
      (item.matches('[data-job-id]') ? item : item.querySelector('[data-job-id]'));
  const jobId =
    idHost?.getAttribute('data-occludable-job-id') ?? idHost?.getAttribute('data-job-id');
  if (jobId && /^\d+$/.test(jobId)) {
    return `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
  }

  const jobLink = item.querySelector('a[href*="/jobs/view/"]');
  const m = (jobLink?.getAttribute('href') ?? '').match(/\/jobs\/view\/(\d+)/);
  if (m) return `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${m[1]}`;

  // Generic fallback: the card's first real anchor, resolved absolute.
  const anchor = item.querySelector('a[href]');
  const href = anchor?.getAttribute('href') ?? '';
  if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
    try {
      const base = item.ownerDocument?.defaultView?.location.href;
      return new URL(href, base).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/** Remove scripts/styles/tags and collapse whitespace so the response can be
 *  substring/regex-matched as plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fetch + strip one detail URL. Returns null on network error or a non-2xx
 *  status so the caller can treat it as "no extra text" rather than throwing. */
export async function fetchDetailText(
  url: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string | null> {
  return (await fetchDetailResult(url, fetcher)).text;
}

export interface DetailFetchResult {
  text: string | null;
  /** 429 — the origin wants us to back off, not to treat this as a miss. */
  rateLimited: boolean;
}

export async function fetchDetailResult(
  url: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<DetailFetchResult> {
  try {
    const res = await fetcher(url, { credentials: 'include' });
    if (res.status === 429) return { text: null, rateLimited: true };
    if (!res.ok) return { text: null, rateLimited: false };
    const html = await res.text();
    const text = stripHtml(html);
    return { text: text.length > 0 ? text : null, rateLimited: false };
  } catch {
    return { text: null, rateLimited: false };
  }
}

export interface DeepTextScannerOpts {
  /** Called once per item as its detail text resolves (non-null only). */
  onText: (item: Element, text: string) => void;
  /** Max concurrent fetches. LinkedIn rate-limits bursts, so keep it low. */
  concurrency?: number;
  /** Minimum ms between starting fetches (gentle pacing). */
  spacingMs?: number;
  /** Injectable for tests. Legacy shape — wrapped as never-rate-limited. */
  fetchText?: (url: string) => Promise<string | null>;
  /** Injectable for tests: full result incl. the rate-limit bit. Wins over
   *  fetchText when both are given. */
  fetchDetail?: (url: string) => Promise<DetailFetchResult>;
  /** Backoff schedule for 429 responses (ms). Injectable for tests. */
  backoffMs?: number[];
  /** url → text store. Defaults to a module-level cache SHARED across
   *  scanner instances: SPA remounts create a fresh scanner each time, and
   *  re-fetching 25 descriptions per remount tripped LinkedIn's rate limit
   *  (live: 9/10 jobs-guest fetches 4xx'd after a pagination's URL churn —
   *  description-dependent filters then silently stopped matching). Tests
   *  pass a fresh Map for isolation. */
  cache?: Map<string, string>;
}

const sharedTextCache = new Map<string, string>();
/** Shared like the cache and for the same reason: a remount mid-burst gets
 *  a fresh scanner, and instance-level in-flight tracking would let it
 *  re-request URLs the previous scanner already has on the wire. */
const sharedInFlight = new Set<string>();
/** Rate-limit cooldown, shared across instances — a 429 means the ORIGIN
 *  is throttling us; a freshly remounted scanner must not restart the
 *  hammering. Live numbers: LinkedIn's jobs-guest window is ~20 requests,
 *  so one page's scan eats the budget and page 2 went 48×429 / 0×200. */
const sharedCooldown = { until: 0, consecutive: 0 };

const DEFAULT_BACKOFF_MS = [4_000, 8_000, 16_000, 32_000, 60_000];
const MAX_FETCH_ATTEMPTS = 4;

/** Throttled, cached fetcher of per-item detail text. `scan()` is idempotent:
 *  items whose URL is already cached or in-flight are skipped, so it can be
 *  called on every filter change without redundant network. */
export class DeepTextScanner {
  private readonly onText: (item: Element, text: string) => void;
  private readonly concurrency: number;
  private readonly spacingMs: number;
  private readonly fetchDetail: (url: string) => Promise<DetailFetchResult>;
  private readonly backoffMs: number[];

  /** url → resolved text. Usually the shared module-level cache. */
  private readonly cache: Map<string, string>;
  /** urls currently being fetched — shared across instances. */
  private readonly inFlight = sharedInFlight;
  /** pending work: [item, url]. */
  private readonly queue: Array<[Element, string]> = [];
  private readonly attempts = new Map<string, number>();
  private active = 0;
  private stopped = false;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: DeepTextScannerOpts) {
    this.onText = opts.onText;
    this.concurrency = opts.concurrency ?? 3;
    this.spacingMs = opts.spacingMs ?? 250;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.fetchDetail =
      opts.fetchDetail ??
      (opts.fetchText
        ? async (u) => ({ text: await opts.fetchText!(u), rateLimited: false })
        : (u) => fetchDetailResult(u));
    this.cache = opts.cache ?? sharedTextCache;
  }

  /** Enqueue any items with a detail URL not already cached/in-flight. Items
   *  whose text is already cached are re-delivered to onText synchronously so
   *  a fresh evaluation picks them up without refetching. New work is ordered
   *  viewport-first: the origin's rate limit (~20 requests/window on
   *  LinkedIn) means we may only get a handful of fetches — spend them on
   *  the cards the user is looking at. */
  scan(items: Iterable<Element>): void {
    if (this.stopped) return;
    const fresh: Array<[Element, string]> = [];
    for (const item of items) {
      const url = itemDetailUrl(item);
      if (!url) continue;
      const cached = this.cache.get(url);
      if (cached !== undefined) {
        this.onText(item, cached);
        continue;
      }
      if (this.inFlight.has(url)) continue;
      if (this.queue.some(([, u]) => u === url)) continue;
      if ((this.attempts.get(url) ?? 0) >= MAX_FETCH_ATTEMPTS) continue;
      fresh.push([item, url]);
    }
    fresh.sort((a, b) => viewportDistance(a[0]) - viewportDistance(b[0]));
    this.queue.push(...fresh);
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  private pump(): void {
    if (this.stopped) return;
    const now = Date.now();
    if (now < sharedCooldown.until) {
      if (this.backoffTimer === null && this.queue.length > 0) {
        this.backoffTimer = setTimeout(() => {
          this.backoffTimer = null;
          this.pump();
        }, sharedCooldown.until - now + 50);
      }
      return;
    }
    while (!this.stopped && this.active < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      void this.run(next[0], next[1]);
    }
  }

  private async run(item: Element, url: string): Promise<void> {
    this.active += 1;
    this.inFlight.add(url);
    this.attempts.set(url, (this.attempts.get(url) ?? 0) + 1);
    try {
      const result = await this.fetchDetail(url);
      if (result.rateLimited) {
        // Origin is throttling: cool down and put the URL back (tail) for a
        // post-cooldown retry. Never cached, so a later scan can also pick
        // it up. Concurrent 429s from the same burst land together — they
        // escalate ONCE, not once each (3 in-flight failures used to jump
        // the schedule straight to 32s and stall the next page's scan).
        const now = Date.now();
        if (now >= sharedCooldown.until) {
          const step = Math.min(sharedCooldown.consecutive, this.backoffMs.length - 1);
          sharedCooldown.consecutive += 1;
          sharedCooldown.until = now + (this.backoffMs[step] ?? 60_000);
        }
        if (!this.stopped && (this.attempts.get(url) ?? 0) < MAX_FETCH_ATTEMPTS) {
          this.queue.push([item, url]);
        }
      } else {
        sharedCooldown.consecutive = 0;
        if (result.text !== null) {
          this.cache.set(url, result.text);
          if (!this.stopped) this.onText(item, result.text);
        }
      }
    } finally {
      this.inFlight.delete(url);
      this.active -= 1;
      if (this.spacingMs > 0) {
        setTimeout(() => this.pump(), this.spacingMs);
      } else {
        this.pump();
      }
    }
  }
}

/** Distance of the item's top edge from the viewport top — 0-ish for
 *  visible cards, growing for below-the-fold ones. Above-viewport cards
 *  rank by how far the user scrolled past them. */
function viewportDistance(item: Element): number {
  const top = item.getBoundingClientRect().top;
  return top >= 0 ? top : -top * 2;
}
