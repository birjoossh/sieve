// background/queue.ts — persistent deep-scan queue.
//
// Slice 5 spawns hidden tabs to read detail pages for the deep-path
// predicates. The queue holds (fingerprint, itemUrl) tuples between SW
// suspensions: MV3 SWs are killed aggressively (~30s idle), so the
// runtime state has to survive in `chrome.storage.local`. A
// `chrome.alarms` heartbeat wakes the SW periodically to drain the
// queue.
//
// Invariants:
//   - Items are keyed by `(fingerprint, itemUrl)` and dedup on enqueue.
//     This prevents requeuing the same detail page when the user
//     re-scrolls or the engine re-evaluates after a filter edit.
//   - Each item has a `status`: pending → in-flight → done | failed.
//     `in-flight` items rescued from a stale storage snapshot (SW
//     died mid-process) are reset to pending on init() so the next
//     drain re-tries them.
//   - Attempts counter capped at MAX_ATTEMPTS — items that fail
//     repeatedly are kept as `failed` and surfaced in the panel for
//     manual inspection (6.4 error UI).

const STORAGE_KEY = 'nf:deep-queue';
const ALARM_NAME = 'nf-deep-queue-heartbeat';
const HEARTBEAT_MINUTES = 1;
const MAX_ATTEMPTS = 3;

export type QueueStatus = 'pending' | 'in-flight' | 'done' | 'failed';

export interface QueueItem {
  fingerprint: string;
  itemUrl: string;
  status: QueueStatus;
  /** ms-epoch when first enqueued. Drives FIFO ordering on dequeue. */
  enqueuedAt: number;
  attempts: number;
  /** Set when status === 'failed' — the last error message (truncated). */
  lastError?: string;
}

function keyOf(item: Pick<QueueItem, 'fingerprint' | 'itemUrl'>): string {
  return `${item.fingerprint}::${item.itemUrl}`;
}

/** Pure helper: merge a batch of newly-enqueued items into an existing
 *  list, deduping by key. Existing items keep their status — only new
 *  keys join. */
export function mergeEnqueue(
  existing: readonly QueueItem[],
  add: ReadonlyArray<Pick<QueueItem, 'fingerprint' | 'itemUrl'>>,
  now: number,
): QueueItem[] {
  const byKey = new Map<string, QueueItem>();
  for (const e of existing) byKey.set(keyOf(e), e);
  for (const a of add) {
    const k = keyOf(a);
    if (byKey.has(k)) continue;
    byKey.set(k, {
      fingerprint: a.fingerprint,
      itemUrl: a.itemUrl,
      status: 'pending',
      enqueuedAt: now,
      attempts: 0,
    });
  }
  return Array.from(byKey.values());
}

/** Reset any `in-flight` items back to pending — call on SW startup
 *  before drains so a mid-process restart doesn't strand items. */
export function reviveInFlight(items: readonly QueueItem[]): QueueItem[] {
  return items.map((i) => (i.status === 'in-flight' ? { ...i, status: 'pending' } : i));
}

/** FIFO over pending items. Returns null when nothing's pending. */
export function nextPending(items: readonly QueueItem[]): QueueItem | null {
  let oldest: QueueItem | null = null;
  for (const i of items) {
    if (i.status !== 'pending') continue;
    if (oldest === null || i.enqueuedAt < oldest.enqueuedAt) oldest = i;
  }
  return oldest;
}

export function markStatus(
  items: readonly QueueItem[],
  key: string,
  patch: Partial<QueueItem>,
): QueueItem[] {
  return items.map((i) => (keyOf(i) === key ? { ...i, ...patch } : i));
}

// ---- Persistent surface --------------------------------------------------

export interface QueueIO {
  load(): Promise<QueueItem[]>;
  save(items: QueueItem[]): Promise<void>;
}

/** Default IO: chrome.storage.local. */
export const chromeQueueIO: QueueIO = {
  async load(): Promise<QueueItem[]> {
    const r = await chrome.storage.local.get(STORAGE_KEY);
    const raw = r[STORAGE_KEY];
    if (!Array.isArray(raw)) return [];
    const out: QueueItem[] = [];
    for (const x of raw) {
      if (typeof x !== 'object' || x === null) continue;
      const o = x as Record<string, unknown>;
      if (typeof o['fingerprint'] !== 'string') continue;
      if (typeof o['itemUrl'] !== 'string') continue;
      if (
        o['status'] !== 'pending' &&
        o['status'] !== 'in-flight' &&
        o['status'] !== 'done' &&
        o['status'] !== 'failed'
      ) continue;
      if (typeof o['enqueuedAt'] !== 'number') continue;
      if (typeof o['attempts'] !== 'number') continue;
      const item: QueueItem = {
        fingerprint: o['fingerprint'],
        itemUrl: o['itemUrl'],
        status: o['status'],
        enqueuedAt: o['enqueuedAt'],
        attempts: o['attempts'],
      };
      if (typeof o['lastError'] === 'string') item.lastError = o['lastError'];
      out.push(item);
    }
    return out;
  },
  async save(items: QueueItem[]): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: items });
  },
};

/** In-memory IO for tests. Holds the items in a closure; lets the spec
 *  simulate "SW death" by reusing the same underlying Map across queue
 *  instances. */
export function memoryQueueIO(initial: readonly QueueItem[] = []): QueueIO {
  let store: QueueItem[] = [...initial];
  return {
    async load() {
      return [...store];
    },
    async save(items) {
      store = [...items];
    },
  };
}

/** The PersistentQueue is the live surface — instances are cheap, and
 *  the storage IO is the source of truth across instances (so creating
 *  a new instance with the same IO simulates SW restart). */
export class PersistentQueue {
  constructor(
    private readonly io: QueueIO = chromeQueueIO,
    private readonly now: () => number = Date.now,
  ) {}

  /** Init: revive in-flight → pending so a mid-drain crash doesn't
   *  strand items. Call once on SW startup. */
  async init(): Promise<void> {
    const items = await this.io.load();
    const revived = reviveInFlight(items);
    if (revived.some((r, i) => r !== items[i])) await this.io.save(revived);
  }

  async enqueue(
    batch: ReadonlyArray<Pick<QueueItem, 'fingerprint' | 'itemUrl'>>,
  ): Promise<void> {
    const items = await this.io.load();
    const merged = mergeEnqueue(items, batch, this.now());
    if (merged.length !== items.length) await this.io.save(merged);
  }

  /** Pop the oldest pending item and mark it in-flight. Returns null
   *  when nothing's pending. Caller must call `markDone` or
   *  `markFailed` to settle. */
  async checkout(): Promise<QueueItem | null> {
    const items = await this.io.load();
    const next = nextPending(items);
    if (!next) return null;
    const key = keyOf(next);
    const updated = markStatus(items, key, {
      status: 'in-flight',
      attempts: next.attempts + 1,
    });
    await this.io.save(updated);
    return { ...next, status: 'in-flight', attempts: next.attempts + 1 };
  }

  async markDone(item: Pick<QueueItem, 'fingerprint' | 'itemUrl'>): Promise<void> {
    const items = await this.io.load();
    const updated = markStatus(items, keyOf(item), { status: 'done' });
    await this.io.save(updated);
  }

  async markFailed(
    item: Pick<QueueItem, 'fingerprint' | 'itemUrl'>,
    error: string,
  ): Promise<void> {
    const items = await this.io.load();
    const target = items.find((i) => keyOf(i) === keyOf(item));
    if (!target) return;
    // Items that have hit MAX_ATTEMPTS stay failed; otherwise they
    // bounce back to pending so the next drain retries them.
    const nextStatus: QueueStatus =
      target.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    const updated = markStatus(items, keyOf(item), {
      status: nextStatus,
      lastError: error.slice(0, 200),
    });
    await this.io.save(updated);
  }

  async snapshot(): Promise<QueueItem[]> {
    return await this.io.load();
  }

  async pending(): Promise<QueueItem[]> {
    return (await this.io.load()).filter((i) => i.status === 'pending');
  }
}

// ---- Alarm heartbeat ------------------------------------------------------

/** Install the heartbeat alarm. Idempotent — calling repeatedly is a
 *  no-op. The SW's onAlarm listener calls `onTick` (typically drains a
 *  bounded number of items). */
export async function installHeartbeat(
  onTick: () => Promise<void>,
): Promise<void> {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    void onTick();
  });
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: HEARTBEAT_MINUTES,
    });
  }
}

export const QUEUE_INTERNALS = {
  STORAGE_KEY,
  ALARM_NAME,
  HEARTBEAT_MINUTES,
  MAX_ATTEMPTS,
} as const;
