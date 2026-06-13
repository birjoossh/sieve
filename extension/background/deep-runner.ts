// background/deep-runner.ts — drives one queue item end-to-end.
//
// Slice 5.2: open a hidden tab pointing at the detail URL, wait for
// the content script in that tab to extract the schema-defined detail
// fields (5.3), close the tab, hand the extracted record back to the
// queue caller.
//
// Hidden tab UX choice: `chrome.tabs.create({active:false})` rather
// than offscreen documents — Decision #6 in DESIGN.md. Offscreen docs
// don't run page JS (and many detail pages need JS to render the
// fields we read in 5.3).
//
// Pluggable surface so the spec can drive runOne without spawning a
// real tab in headless when we just want to validate the lifecycle
// contract.

export interface DetailRecord {
  /** The URL the runner opened. Echoed back so the queue can key the
   *  result against the (fingerprint, itemUrl) tuple. */
  itemUrl: string;
  /** Field values extracted from the detail page. Schema-keyed (5.3
   *  defines the field names). */
  fields: Record<string, string>;
  /** ms it took to spawn + read + tear down. Used to gate the
   *  throttle in 5.5. */
  durationMs: number;
}

export interface DeepRunnerOpts {
  /** Inject the tabs surface — defaults to `chrome.tabs`. Tests pass
   *  an in-memory stub. */
  tabs?: TabsLike;
  /** Wait for the detail-content script in the spawned tab to signal
   *  ready. Defaults to a chrome.runtime.onMessage subscription
   *  filtering on `{t:'detailReady', tabId}`. Tests inject a
   *  resolver that completes synchronously. */
  awaitDetail?: (tabId: number) => Promise<Record<string, string>>;
  /** Hard timeout — if the content script never signals back, the
   *  runner gives up and rejects so the queue can mark failed and
   *  retry. Default 15s. */
  timeoutMs?: number;
  /** When set, the detail URL must be on this origin (the list page's).
   *  Queue items derive from page DOM — a hidden tab must not be
   *  steerable to an arbitrary site. */
  allowedOrigin?: string;
  now?: () => number;
}

/** The slice of chrome.tabs we use. Subset so tests can stub it. */
export interface TabsLike {
  create(props: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
  remove(tabId: number): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function chromeTabsLike(): TabsLike {
  return {
    create: (p) => chrome.tabs.create(p),
    remove: (id) => chrome.tabs.remove(id),
  };
}

interface DetailAwaiter {
  promise: Promise<Record<string, string>>;
  /** Detach the message listener. Must run when the timeout wins the
   *  race: a leaked listener accumulates one per timed-out run, and a
   *  LATE detailReady from a recycled tabId would resolve the wrong
   *  item's fields. Safe to call after normal resolution too. */
  cancel: () => void;
}

function defaultAwaitDetail(tabId: number): DetailAwaiter {
  let listener: ((raw: unknown, sender: chrome.runtime.MessageSender) => false) | null = null;
  const promise = new Promise<Record<string, string>>((resolveOuter, reject) => {
    listener = (raw, sender): false => {
      if (sender.tab?.id !== tabId) return false;
      if (typeof raw !== 'object' || raw === null) return false;
      const r = raw as Record<string, unknown>;
      if (r['t'] !== 'detailReady') return false;
      if (listener !== null) chrome.runtime.onMessage.removeListener(listener);
      if (typeof r['fields'] !== 'object' || r['fields'] === null) {
        reject(new Error('detailReady missing fields'));
        return false;
      }
      resolveOuter(r['fields'] as Record<string, string>);
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
  });
  return {
    promise,
    cancel: () => {
      if (listener !== null) chrome.runtime.onMessage.removeListener(listener);
    },
  };
}

export async function runOne(
  itemUrl: string,
  opts: DeepRunnerOpts = {},
): Promise<DetailRecord> {
  const tabs = opts.tabs ?? chromeTabsLike();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;

  // Queue items derive from page DOM — never open a hidden tab on a
  // non-web scheme (chrome://, file:, javascript:) or, when the caller
  // pins an origin, off the list page's own site.
  let parsed: URL;
  try {
    parsed = new URL(itemUrl);
  } catch {
    throw new Error(`deep-runner: invalid detail URL: ${itemUrl}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`deep-runner: refusing non-http(s) detail URL: ${itemUrl}`);
  }
  if (opts.allowedOrigin !== undefined && parsed.origin !== opts.allowedOrigin) {
    throw new Error(
      `deep-runner: detail URL origin ${parsed.origin} is outside ${opts.allowedOrigin}`,
    );
  }

  const start = now();
  const tab = await tabs.create({ url: itemUrl, active: false });
  if (tab.id === undefined) {
    throw new Error('chrome.tabs.create returned a tab without an id');
  }
  const tabId = tab.id;

  const awaiter: DetailAwaiter = opts.awaitDetail
    ? { promise: opts.awaitDetail(tabId), cancel: () => undefined }
    : defaultAwaitDetail(tabId);

  // race(awaitDetail, timeout)
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`deep-runner timed out after ${timeout}ms`));
    }, timeout);
  });

  let fields: Record<string, string>;
  try {
    fields = await Promise.race([awaiter.promise, timeoutPromise]);
  } finally {
    awaiter.cancel();
    if (timer !== null) clearTimeout(timer);
    // Always close the tab — leaving hidden tabs around is a UX bug
    // and a memory leak. tabs.remove swallows a non-existent id (the
    // user could have closed the tab manually) via .catch.
    await tabs.remove(tabId).catch(() => undefined);
  }

  return {
    itemUrl,
    fields,
    durationMs: now() - start,
  };
}
