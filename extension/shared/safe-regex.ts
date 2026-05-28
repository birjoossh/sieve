// shared/safe-regex.ts — guard against catastrophic-backtracking regex.
//
// Filters can carry user-typed regex (Slice 4.1's predicate `op: 'regex'`).
// A naïve `new RegExp(pattern)` would happily compile `(a+)+b` and then
// hang the engine on a 25-character input. The guard rejects that class
// up-front with a typed error the panel can surface.
//
// Two cheap checks, both static:
//   1. Pattern length cap — bounds the compile-time cost and keeps the
//      user-typed surface trivially auditable.
//   2. Nested-quantifier detection — a quantified group (`(...)+` or
//      `(...)*`) whose contents *also* contain `+` or `*` is the canonical
//      ReDoS recipe. Catches `(a+)+`, `(.*)*`, `(\w+)+`, `(a|b+)+`, etc.
//
// What this does NOT catch: backreference-based ReDoS, alternation
// without an inner quantifier (`(a|aa)+`), unbounded `{n,}` rare in
// practice. Slice 6 ("hardening + ship") replaces this with the
// `safe-regex` package once the dep budget is opened; until then this
// keeps the common cases out and is auditable in 20 lines.

export class UnsafeRegexError extends Error {
  readonly reason: string;
  readonly pattern: string;
  constructor(reason: string, pattern: string) {
    super(`UnsafeRegexError: ${reason}`);
    this.name = 'UnsafeRegexError';
    this.reason = reason;
    this.pattern = pattern;
  }
}

const MAX_REGEX_LENGTH = 256;

/** Matches a quantified group whose body contains a `+` or `*` — i.e. a
 *  nested quantifier. Handles `(a+)+`, `(.+|x)+`, `(\w+){2,}`, etc. */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*?{]/;

export function safeCompileRegex(pattern: string, flags?: string): RegExp {
  if (pattern.length === 0) {
    throw new UnsafeRegexError('empty pattern', pattern);
  }
  if (pattern.length > MAX_REGEX_LENGTH) {
    throw new UnsafeRegexError(
      `length ${pattern.length} exceeds cap ${MAX_REGEX_LENGTH}`,
      pattern,
    );
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    throw new UnsafeRegexError('nested quantifier (ReDoS risk)', pattern);
  }
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UnsafeRegexError(`syntax: ${msg}`, pattern);
  }
}
