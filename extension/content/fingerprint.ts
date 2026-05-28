// content/fingerprint.ts — structural fingerprint for a detected item-set.
//
// Spike-A choice: a *modal-shape* structural hash. Schema cache (Slice 3) is
// keyed on this string, so the contract it has to honor is:
//
//   1. **Stable** — same fingerprint across visits when the layout is the
//      same and only the items differ (different content, different counts,
//      a few interspersed sponsored / promo cards).
//   2. **Distinct** — different fingerprint when the layout is *materially*
//      different (jobs list vs product carousel vs course grid).
//   3. **Pure** — no DOM mutation, no layout reads. Deterministic on the same
//      element subtree.
//
// Strategies considered (4 — picked #4):
//   1. Plain `outerHTML` hash. Out: every content change re-hashes; cache
//      would be useless for any real site.
//   2. Tag-tree hash (recursive `(tag (children))`). Out: still varies with
//      item count, sponsored insertions, A/B perturbations.
//   3. Container `tag.classSorted` only. Out: distinct enough for our 3
//      fixtures but trivially collides — a different list page on the same
//      site with the same wrapper class would alias.
//   4. **Modal-shape hash** (chosen): container `tag.classSorted` +
//      most-common child shape (recursive, depth-bounded). Item count and
//      ordering ignored. Outliers in the child cluster are smoothed by
//      taking the *mode*, not all-shapes. Class lists are sorted so
//      attribute order is irrelevant. Volatile attributes (id, data-*,
//      style, aria-*) are excluded — they're per-item by convention.
//
// Why depth-bounded recursion (DEPTH=3 here): one level alone collides
// across very different cards (e.g. two list pages whose cards both wrap an
// img + h2 + p); three levels of element-tree distinguish a job card's
// `.meta > .location | .comp` from a product card's `.price > .badge`.
// Going deeper buys nothing on real layouts and only inflates the hash
// surface for transient content variations.
//
// Slice 6.2 ("fingerprint hardening") revisits to:
//   - drop utility-generated class hashes (CSS-in-JS, Tailwind JIT) before
//     the sort,
//   - swap FNV-1a for crypto.subtle.digest('SHA-256', …) once everything
//     downstream is async-friendly,
//   - widen the strategy comparison once we have ≥2 real-site captures.

const DEPTH = 3;

/** 6.2: utility-class noise filter. CSS-in-JS (Linaria/styled-components/
 *  emotion) and Tailwind JIT emit per-deploy hashes like `css-1xyz3a`,
 *  `_1f9p`, `Atoms_root__a8K2`. They look meaningful but change every
 *  deploy → cache miss + unnecessary LLM call. We drop them before the
 *  sort.
 *
 *  Heuristic patterns:
 *    - `css-<base36>`     emotion / linaria
 *    - `_<short hash>`    leading-underscore (Next.js, CSS modules)
 *    - `<word>__<hash>`   CSS modules `module_root__xyz`
 *    - `<word>_<word>__<hash>` Atoms_root__a8K2
 *    - `jsx-<digits>`     styled-jsx
 *
 *  Anything we can't classify stays — better to fingerprint a stable
 *  hand-written class than to over-filter. */
const UTILITY_CLASS_PATTERNS: ReadonlyArray<RegExp> = [
  /^css-[a-z0-9]{4,}$/i,
  /^_[a-z0-9_-]{3,}$/i,
  /^[a-z][\w-]*__[a-z0-9]{4,}$/i,
  /^jsx-\d{4,}$/i,
  /^sc-[a-z0-9]{4,}$/i,
];

function isUtilityClass(cls: string): boolean {
  for (const re of UTILITY_CLASS_PATTERNS) {
    if (re.test(cls)) return true;
  }
  return false;
}

/** Tag + sorted, utility-stripped class list. Mirrors detect.ts's
 *  `signatureOf` so the two modules stay in sync on what counts as "the
 *  same shape." Ids and all attributes other than class are excluded
 *  by design — see file comment. */
function nodeShape(el: Element): string {
  const classes = Array.from(el.classList)
    .filter((c) => !isUtilityClass(c))
    .sort()
    .join('.');
  return classes ? `${el.tagName}.${classes}` : el.tagName;
}

const NON_CONTENT_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'LINK',
  'META',
  'NOSCRIPT',
  'TEMPLATE',
]);

function elementChildren(parent: Element): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (NON_CONTENT_TAGS.has(child.tagName)) continue;
    out.push(child);
  }
  return out;
}

/** Recursive shape: tag.classSorted plus a sorted list of children's
 *  recursive shapes (one level shallower). The sort is what makes the hash
 *  insensitive to sibling ordering — a layout that occasionally swaps two
 *  fields shouldn't change fingerprint.
 *
 *  Sort *as strings* (not by frequency) because at this depth nodes are
 *  the same shape iff their full text is the same — frequency-bucketing
 *  would collapse genuinely-different siblings (e.g. `.title` vs `.price`)
 *  into one bin. */
function recursiveShape(el: Element, depth: number): string {
  if (depth === 0) return nodeShape(el);
  const children = elementChildren(el)
    .map((c) => recursiveShape(c, depth - 1))
    .sort();
  return children.length === 0 ? nodeShape(el) : `${nodeShape(el)}(${children.join(',')})`;
}

/** Most frequent element of an array. Ties broken by *string-sorted first*
 *  so the result is deterministic. Returns null on an empty array. */
function modeOf(xs: readonly string[]): string | null {
  if (xs.length === 0) return null;
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: { value: string; count: number } | null = null;
  // Sort for tie-break determinism.
  const sorted = [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [value, count] of sorted) {
    if (!best || count > best.count) best = { value, count };
  }
  return best?.value ?? null;
}

/** FNV-1a 32-bit. Browser-safe sync hash — good enough for a cache key
 *  (collision risk is dominated by structural similarity, not hash width).
 *  Slice 6.2 swaps for SHA-256 once the surrounding paths are async. */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // Multiply by FNV prime mod 2^32. The bit-shift trick avoids ever
    // leaving 32-bit territory in JS.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Build the fingerprint for a detected item-set. Hashing inputs:
 *
 *    container shape  | modal child recursive shape
 *
 *  Item count, ordering, content, and non-modal child shapes are all
 *  deliberately excluded.
 *
 *  Empty container (no element children that survive NON_CONTENT_TAGS) →
 *  null. Callers should treat that as "no detection, no fingerprint" rather
 *  than substituting a sentinel. */
export function fingerprintItemSet(itemSet: Element): string | null {
  const children = elementChildren(itemSet);
  if (children.length === 0) return null;

  const childShapes = children.map((c) => recursiveShape(c, DEPTH));
  const modal = modeOf(childShapes);
  if (modal === null) return null;

  const containerShape = nodeShape(itemSet);
  return fnv1a32(`${containerShape}|${modal}`);
}
