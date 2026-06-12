// background/throttle.ts — concurrency limiter + jitter + backoff.
//
// Decision #16 (DESIGN.md): the deep path must not look like a
// scraper. Three knobs:
//   - Per-domain concurrency cap (semaphore — no more than N hidden
//     tabs to one origin in flight).
//   - Per-acquire jitter (0..jitterMs random delay) so we don't burst
//     N parallel requests on a single tick.
//   - Exponential backoff when the host returns a 429 or a known
//     Cloudflare challenge marker — back off the *whole domain*, not
//     just the failed request, so a banged-on origin gets time to
//     recover.
//
// Pure local state per (Throttler instance, domain). Persisting
// backoff state across SW restarts is overkill for the deep path's
// 1-minute heartbeat cadence; if the SW dies, the next wake-up
// re-discovers the 429 organically.

export type ThrottleOutcome = 'ok' | 'rate-limited';

export interface ThrottlerOpts {
  concurrency: number;
  /** Random delay range per acquire, in ms. Default 0–200ms. */
  jitterMs?: number;
  /** Backoff schedule for repeated rate-limit hits, in ms.
   *  Default: 500, 1000, 2000, 4000, 8000. Final entry repeats. */
  backoffMs?: readonly number[];
  /** Sleep impl. Tests pass a fake that records calls and resolves
   *  synchronously. */
  sleep?: (ms: number) => Promise<void>;
  /** Random impl. Tests pass a deterministic stub. */
  random?: () => number;
}

const DEFAULT_BACKOFF: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000];

export class Throttler {
  private readonly concurrency: number;
  private readonly jitterMs: number;
  private readonly backoffMs: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  /** In-flight count + waiter queue, per domain. */
  private domains = new Map<string, DomainState>();

  constructor(opts: ThrottlerOpts) {
    this.concurrency = opts.concurrency;
    this.jitterMs = opts.jitterMs ?? 200;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  /** Acquire a slot for `domain`. Resolves when the caller may proceed.
   *  Caller MUST call the returned `release` function once (typically
   *  via try/finally) so subsequent waiters can advance. */
  async acquire(domain: string): Promise<() => void> {
    const state = this.stateFor(domain);

    // Jitter BEFORE contending for a slot — uniform [0, jitterMs). Each
    // caller de-synchronizes independently; sleeping it while holding the
    // slot starved healthy domains' waiters for no politeness gain.
    if (this.jitterMs > 0) {
      await this.sleep(Math.floor(this.random() * this.jitterMs));
    }

    // Wait for room in the semaphore.
    while (state.inFlight >= this.concurrency) {
      await new Promise<void>((r) => state.waiters.push(r));
    }
    state.inFlight += 1;

    // Backoff is deliberately slept while HOLDING the slot: a 429'd domain
    // should see its whole pipeline pause, not have other waiters slip
    // through the freed slot mid-cooldown.
    if (state.backoffUntil > Date.now()) {
      const remaining = state.backoffUntil - Date.now();
      await this.sleep(remaining);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.inFlight = Math.max(0, state.inFlight - 1);
      const next = state.waiters.shift();
      if (next) next();
    };
  }

  /** Caller signals an outcome — used to escalate / decay the backoff
   *  for that domain. */
  reportOutcome(domain: string, outcome: ThrottleOutcome): void {
    const state = this.stateFor(domain);
    if (outcome === 'rate-limited') {
      const idx = Math.min(state.consecutive429, this.backoffMs.length - 1);
      const delay = this.backoffMs[idx] ?? this.backoffMs[this.backoffMs.length - 1] ?? 0;
      state.consecutive429 += 1;
      state.backoffUntil = Date.now() + delay;
    } else {
      state.consecutive429 = 0;
      state.backoffUntil = 0;
    }
  }

  /** Snapshot for tests — current in-flight + backoff state. */
  inspect(domain: string): { inFlight: number; consecutive429: number; backoffUntil: number } {
    const s = this.stateFor(domain);
    return {
      inFlight: s.inFlight,
      consecutive429: s.consecutive429,
      backoffUntil: s.backoffUntil,
    };
  }

  private stateFor(domain: string): DomainState {
    let s = this.domains.get(domain);
    if (!s) {
      s = { inFlight: 0, waiters: [], consecutive429: 0, backoffUntil: 0 };
      this.domains.set(domain, s);
    }
    return s;
  }
}

interface DomainState {
  inFlight: number;
  waiters: Array<() => void>;
  consecutive429: number;
  backoffUntil: number;
}
