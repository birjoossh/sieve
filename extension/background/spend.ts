// background/spend.ts — usage ledger + cap checker for LLM calls.
//
// Decision #14 (DESIGN.md): the extension never silently bills the user.
// Hard caps on per-day and per-month call counts prevent runaway spend
// even when the LLM path is invoked autonomously (mutation observer
// firing on a page that re-renders aggressively, etc.).
//
// We track *call counts* rather than dollar cost — pre-call token
// estimation is unreliable and the user's actual price depends on the
// provider's billing cycle. A per-day call cap is the user-comprehensible
// proxy that matches the LLM-budget hand-off in 4.7's UI.
//
// Storage:
//   chrome.storage.local key 'nf:spend-ledger' → SpendLedger
//   - dailyEpoch / monthlyEpoch are integer epoch indices (LOCAL calendar
//     days since 1970, local months since 1970×12) so rollover is just
//     `!==`, no parsing. Local, not UTC: "50 calls today" must reset at
//     the user's midnight, not at 8am for someone in UTC+8.
//
// Caps are the hard-coded DEFAULT_CAPS below (50/day, 1000/month).
// User-configurable caps via LlmSettings remain future work — nothing in
// shared/settings.ts carries cap fields yet, and sw.ts constructs the
// checker with the defaults unconditionally.

export interface SpendLedger {
  dailyEpoch: number;
  dailyCount: number;
  monthlyEpoch: number;
  monthlyCount: number;
}

export interface SpendCaps {
  daily: number;
  monthly: number;
}

export const DEFAULT_CAPS: SpendCaps = { daily: 50, monthly: 1000 };

const STORAGE_KEY = 'nf:spend-ledger';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function epochDay(now: number): number {
  // Shift by the local timezone offset so the index increments at the
  // user's local midnight rather than UTC's.
  const offsetMs = new Date(now).getTimezoneOffset() * 60_000;
  return Math.floor((now - offsetMs) / MS_PER_DAY);
}

function epochMonth(now: number): number {
  const d = new Date(now);
  return d.getFullYear() * 12 + d.getMonth();
}

function emptyLedger(now: number): SpendLedger {
  return {
    dailyEpoch: epochDay(now),
    dailyCount: 0,
    monthlyEpoch: epochMonth(now),
    monthlyCount: 0,
  };
}

/** Roll the ledger forward to `now` — zero counts whose epoch is stale.
 *  Pure: caller decides whether to persist. */
export function rollLedger(ledger: SpendLedger, now: number): SpendLedger {
  const d = epochDay(now);
  const m = epochMonth(now);
  let next = ledger;
  if (d !== ledger.dailyEpoch) {
    next = { ...next, dailyEpoch: d, dailyCount: 0 };
  }
  if (m !== ledger.monthlyEpoch) {
    next = { ...next, monthlyEpoch: m, monthlyCount: 0 };
  }
  return next;
}

export type SpendCheck =
  | { ok: true }
  | { ok: false; reason: 'spend-cap-reached'; period: 'day' | 'month' };

/** Test the ledger against the caps. Caller may persist the rolled
 *  ledger or hand it on to `recordSpend` (which rolls again). */
export function checkLedger(
  ledger: SpendLedger,
  caps: SpendCaps,
  now: number,
): SpendCheck {
  const rolled = rollLedger(ledger, now);
  if (rolled.dailyCount >= caps.daily) {
    return { ok: false, reason: 'spend-cap-reached', period: 'day' };
  }
  if (rolled.monthlyCount >= caps.monthly) {
    return { ok: false, reason: 'spend-cap-reached', period: 'month' };
  }
  return { ok: true };
}

/** Increment the ledger by one call, rolling stale epochs first. */
export function incrementLedger(ledger: SpendLedger, now: number): SpendLedger {
  const rolled = rollLedger(ledger, now);
  return {
    ...rolled,
    dailyCount: rolled.dailyCount + 1,
    monthlyCount: rolled.monthlyCount + 1,
  };
}

// ---- chrome.storage.local persistence ------------------------------------

export async function loadLedger(now: number = Date.now()): Promise<SpendLedger> {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  const raw = r[STORAGE_KEY];
  if (!raw || typeof raw !== 'object') return emptyLedger(now);
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj['dailyEpoch'] !== 'number' ||
    typeof obj['dailyCount'] !== 'number' ||
    typeof obj['monthlyEpoch'] !== 'number' ||
    typeof obj['monthlyCount'] !== 'number'
  ) {
    return emptyLedger(now);
  }
  return rollLedger(
    {
      dailyEpoch: obj['dailyEpoch'],
      dailyCount: obj['dailyCount'],
      monthlyEpoch: obj['monthlyEpoch'],
      monthlyCount: obj['monthlyCount'],
    },
    now,
  );
}

export async function saveLedger(ledger: SpendLedger): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: ledger });
}

export async function clearLedger(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

// ---- Pluggable surface (testable, async-friendly) ------------------------

/** Async checker for the LLM call path. The default impl reads/writes
 *  storage.local; tests pass an in-memory impl via DiscoverOpts.spend. */
export interface SpendChecker {
  canSpend(now: number): Promise<SpendCheck>;
  recordSpend(now: number): Promise<void>;
}

export function chromeStorageSpendChecker(caps: SpendCaps = DEFAULT_CAPS): SpendChecker {
  return {
    async canSpend(now: number): Promise<SpendCheck> {
      const ledger = await loadLedger(now);
      return checkLedger(ledger, caps, now);
    },
    async recordSpend(now: number): Promise<void> {
      const ledger = await loadLedger(now);
      await saveLedger(incrementLedger(ledger, now));
    },
  };
}

/** In-memory checker for tests. Pre-seed with `ledger`, optionally
 *  scoped caps. */
export function memorySpendChecker(initial: SpendLedger, caps: SpendCaps = DEFAULT_CAPS): SpendChecker {
  let ledger = initial;
  return {
    async canSpend(now: number): Promise<SpendCheck> {
      return checkLedger(ledger, caps, now);
    },
    async recordSpend(now: number): Promise<void> {
      ledger = incrementLedger(ledger, now);
    },
  };
}

/** Public snapshot for UI consumption (panel surfaces "N / cap today"). */
export interface SpendStatus {
  dailyUsed: number;
  dailyCap: number;
  monthlyUsed: number;
  monthlyCap: number;
  capReached: boolean;
  cappedPeriod: 'day' | 'month' | null;
}

export async function getSpendStatus(
  now: number = Date.now(),
  caps: SpendCaps = DEFAULT_CAPS,
): Promise<SpendStatus> {
  const ledger = rollLedger(await loadLedger(now), now);
  const check = checkLedger(ledger, caps, now);
  return {
    dailyUsed: ledger.dailyCount,
    dailyCap: caps.daily,
    monthlyUsed: ledger.monthlyCount,
    monthlyCap: caps.monthly,
    capReached: !check.ok,
    cappedPeriod: check.ok ? null : check.period,
  };
}

export class SpendCapError extends Error {
  readonly reason = 'spend-cap-reached' as const;
  readonly period: 'day' | 'month';
  constructor(period: 'day' | 'month') {
    super(`spend-cap-reached:${period}`);
    this.name = 'SpendCapError';
    this.period = period;
  }
}
