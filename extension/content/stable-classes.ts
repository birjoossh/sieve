// content/stable-classes.ts — shared "is this class stable across items?"
// filter, used by BOTH detect.ts (sibling grouping / selector generalization)
// and fingerprint.ts (cache-key shape).
//
// Why this exists: real sites attach per-item / per-deploy class tokens to
// otherwise-identical cards — CSS-in-JS hashes (`css-1abc23`), CSS-module
// suffixes (`Card__a8K2`), styled-jsx ids (`jsx-12345`), styled-components
// (`sc-1x2y`), and Ember view ids surfaced as classes. If grouping keys off
// the *full* class list, every structurally-identical card gets a different
// signature, never groups into an item-set, and detect() returns null → the
// panel shows "No list detected." fingerprint.ts already stripped these;
// detect.ts did not, which is the bug this module centralizes the fix for.
//
// Kept deliberately conservative: a stable hand-written class wrongly
// stripped could over-merge genuinely-different elements, so each pattern
// targets a recognizable generated-token shape and requires a hash-like
// tail. Anything we can't confidently classify as generated is KEPT.
// detect.ts pairs this with a tag-only fallback for the residual case where
// per-item class noise doesn't match any pattern.

const VOLATILE_CLASS_PATTERNS: ReadonlyArray<RegExp> = [
  /^css-[a-z0-9]{4,}$/i, // emotion / linaria
  /^_[a-z0-9_-]{3,}$/i, // leading-underscore (Next.js, CSS modules)
  /^[a-z][\w-]*__[a-z0-9]*\d[a-z0-9]*$/i, // CSS modules: Card__a8K2 (hash suffix
  // must contain a digit — otherwise this also ate real BEM elements like
  // `scaffold-layout__list`, merging unrelated containers on real sites)
  /^jsx-\d{4,}$/i, // styled-jsx
  /^sc-[a-z0-9]{4,}$/i, // styled-components
  /^ember\d+$/i, // Ember view ids surfaced as classes
];

/** Long, separator-less, mixed-case alphanumeric tokens are almost always
 *  generated per-item/per-deploy hashes — e.g. LinkedIn's
 *  `KJlVgtRnHLfDQHwLjbGsAsABHadXLGBDvvc` or atomic-CSS atoms. Real
 *  hand-written classes use hyphens/underscores or are short/single-case
 *  (`scaffold-layout__list-item`, `occludable-update`, `relative`, `p0`), so
 *  requiring BOTH an uppercase and a lowercase letter and length ≥ 10 with no
 *  separators keeps those safe while catching the hashes that were splitting
 *  real LinkedIn job cards into ungroupable singletons. */
function isHashToken(cls: string): boolean {
  return /^[A-Za-z0-9]{10,}$/.test(cls) && /[a-z]/.test(cls) && /[A-Z]/.test(cls);
}

/** True when `cls` looks like a generated, per-item/per-deploy token that
 *  should be excluded from structural signatures. */
export function isVolatileClass(cls: string): boolean {
  if (isHashToken(cls)) return true;
  for (const re of VOLATILE_CLASS_PATTERNS) {
    if (re.test(cls)) return true;
  }
  return false;
}

/** Sorted, volatile-stripped class list for one element, joined with `.`.
 *  Empty string when the element has no stable classes. */
export function stableClasses(el: Element): string {
  return Array.from(el.classList)
    .filter((c) => !isVolatileClass(c))
    .sort()
    .join('.');
}

/** Structural signature shared by detect() and fingerprint(): tag name plus
 *  the stable class list. Two elements are "the same shape" iff this matches. */
export function stableShape(el: Element): string {
  const classes = stableClasses(el);
  return classes ? `${el.tagName}.${classes}` : el.tagName;
}
