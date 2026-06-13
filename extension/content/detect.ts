// content/detect.ts — repeated-structure heuristic for finding the page's
// candidate item-set (the outer container of a repeating list / carousel /
// grid), plus the layout classifier that decides which renderer applies.
//
// Slice-2 role: replaces the hand-written `schema-stub` matching on
// unfamiliar pages. Selector generalization to feed `Schema.itemSetSelector`
// / `itemSelector` is 2.4's. This module answers two questions:
//   1. which DOM subtree on this page looks like a repeating-item set?
//      → `detect(root)`
//   2. is that subtree a list / carousel / grid?
//      → `classify(container)`
//
// Heuristic (cheap and robust enough for the Slice-2 fixtures):
//   1. Walk every Element under the root.
//   2. For each Element, group its **element children** by a structural
//      signature: `tagName.classSorted` (id / inline-style ignored — they're
//      typically unique-per-item, so they'd defeat grouping).
//   3. Pick the largest signature-group of size >= MIN_GROUP_SIZE.
//   4. Score that group: `groupSize * meanDescendantCount`. Multiplying by
//      descendant-count beats noisy false-positives (e.g. `<head>` with
//      `<meta><meta><meta>` — 3 siblings, 0 descendants each → score 0;
//      a `<nav>` with 4 `<a>` links → ~4; ten rich cards each with eight
//      descendants → ~80).
//   5. The Element whose top group wins globally is the item-set container.
//
// Pure: never mutates the DOM, never reads layout (offsetWidth / etc.).
// Returns the container Element, or null when nothing meets the threshold.

import { stableClasses, stableShape } from './stable-classes.js';

/** Tags that never carry user-visible repeating content — skipped wholesale
 *  to keep `<head>` / inline `<script>` blocks from competing. */
const NON_CONTENT_TAGS = new Set([
  'HEAD',
  'SCRIPT',
  'STYLE',
  'LINK',
  'META',
  'TITLE',
  'NOSCRIPT',
  'BASE',
  'TEMPLATE',
]);

/** Below 3 siblings, it's a tuple, not a list — skip. */
const MIN_GROUP_SIZE = 3;

/** Per-item descendant-count cap used in scoring. Without it the score
 *  (groupSize × meanDescendants) is dominated by a handful of *enormous*
 *  wrapper elements — on real SPAs (LinkedIn) a top-level cluster of 5 giant
 *  layout `<div>`s out-scored the actual 25-card job list, so detect()
 *  returned the wrapper and the generated selector matched a single element
 *  ("Detected: list · 1 item"). Capping the per-item term lets a long list of
 *  moderately-rich cards win over a few massive containers. 40 sits above a
 *  typical rich card's element count and well below a page-section wrapper's. */
const DESCENDANT_CAP = 40;

/** Structural signature for one Element. Used to group siblings: two
 *  siblings count as "structurally similar" iff their signatures match.
 *
 *  Includes tag + sorted class list. Deliberately excludes id and the
 *  child-tree shape — ids are unique per item by convention; full subtree
 *  shape would over-split when item content has minor variation (e.g. a
 *  card with vs without a "sale" badge). The class-list captures the
 *  level of similarity the renderer needs.
 */
function signatureOf(el: Element): string {
  // Volatile per-item / per-deploy class tokens (CSS-in-JS hashes, Ember
  // ids, etc.) are stripped via the shared filter so structurally-identical
  // cards group together. Before this, a list whose cards each carried a
  // unique generated class fragmented into singletons and detect() returned
  // null — the "No list detected" bug on real SPA sites.
  return stableShape(el);
}

function elementChildren(parent: Element): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (NON_CONTENT_TAGS.has(child.tagName)) continue;
    out.push(child);
  }
  return out;
}

interface Candidate {
  /** The container element (the parent of the matched sibling cluster). */
  container: Element;
  /** Members of the winning signature-group, in document order. */
  group: Element[];
  /** Signature shared by every member of `group`. */
  signature: string;
  /** groupSize * meanDescendantCount. Higher is better. */
  score: number;
}

/** Per-call descendant-count memo. detect() used to call
 *  `getElementsByTagName('*').length` per child per parent — Σ(subtree
 *  sizes) ≈ O(n × depth) — and it re-runs up to 3 seeded times plus once
 *  per mutation batch for 60s on undetected pages: real jank on 10k+-node
 *  SPAs. One post-order pass computes every count in O(n). Non-content
 *  subtrees are excluded (the old per-element count included them; the
 *  scoring is no worse for ignoring script/style nodes). */
type DescendantCounts = Map<Element, number>;

function computeDescendantCounts(root: Element): DescendantCounts {
  const counts: DescendantCounts = new Map();
  // Iterative post-order: push unvisited, re-push as visited, children first.
  const stack: Array<[Element, boolean]> = [[root, false]];
  while (stack.length > 0) {
    const [node, visited] = stack.pop()!;
    if (NON_CONTENT_TAGS.has(node.tagName)) continue;
    if (!visited) {
      stack.push([node, true]);
      for (const child of Array.from(node.children)) {
        if (!NON_CONTENT_TAGS.has(child.tagName)) stack.push([child, false]);
      }
    } else {
      let total = 0;
      for (const child of Array.from(node.children)) {
        if (NON_CONTENT_TAGS.has(child.tagName)) continue;
        total += 1 + (counts.get(child) ?? 0);
      }
      counts.set(node, total);
    }
  }
  return counts;
}

/** Best candidate for one parent Element — the largest qualifying
 *  signature-group amongst its children. Null when no group meets the
 *  minimum size. */
function evaluateParent(parent: Element, counts: DescendantCounts): Candidate | null {
  const children = elementChildren(parent);
  if (children.length < MIN_GROUP_SIZE) return null;

  const groups = new Map<string, Element[]>();
  for (const child of children) {
    const sig = signatureOf(child);
    const list = groups.get(sig);
    if (list) list.push(child);
    else groups.set(sig, [child]);
  }

  let best: Candidate | null = null;
  for (const [sig, group] of groups) {
    if (group.length < MIN_GROUP_SIZE) continue;
    // Mean descendant count across the group — element descendants only,
    // text nodes are not part of the structural shape we care about.
    let total = 0;
    for (const el of group) total += counts.get(el) ?? 0;
    const meanDescendants = total / group.length;
    const score = group.length * Math.min(meanDescendants, DESCENDANT_CAP);
    if (!best || score > best.score) {
      best = { container: parent, group, signature: sig, score };
    }
  }

  // Fallback: residual per-item class noise that no strip pattern catches
  // (e.g. a site's own `state-7f3a` tokens) still fragments the stable-class
  // groups above. When that leaves *no* qualifying class-group, retry the
  // grouping by tag name alone. Only triggers when class-grouping found
  // nothing — so clean fixtures, where a class-group already wins, are
  // unaffected and never regress.
  if (!best) best = evaluateParentByTag(parent, children, counts);
  return best;
}

/** Tag-only fallback grouping: cluster the parent's children by bare tag
 *  name, ignoring classes entirely. The same scoring (size × mean
 *  descendants) picks the richest cluster. Used only when stable-class
 *  grouping yields nothing, so it can rescue lists whose per-item class
 *  noise defeats the pattern filter without affecting normal pages. */
function evaluateParentByTag(
  parent: Element,
  children: Element[],
  counts: DescendantCounts,
): Candidate | null {
  const groups = new Map<string, Element[]>();
  for (const child of children) {
    const list = groups.get(child.tagName);
    if (list) list.push(child);
    else groups.set(child.tagName, [child]);
  }

  let best: Candidate | null = null;
  for (const [tag, group] of groups) {
    if (group.length < MIN_GROUP_SIZE) continue;
    let total = 0;
    for (const el of group) total += counts.get(el) ?? 0;
    const meanDescendants = total / group.length;
    const score = group.length * Math.min(meanDescendants, DESCENDANT_CAP);
    if (!best || score > best.score) {
      best = { container: parent, group, signature: tag, score };
    }
  }
  return best;
}

import type { LayoutKind } from '../shared/types.js';

/** Classify a container element as `list | carousel | grid` from its
 *  computed style. Container axis + overflow are the cheapest robust signal:
 *
 *  - `display: grid` (or any `*-grid` variant) → `grid`. CSS grid is
 *    overwhelmingly used for actual visual grids; nothing else paints that
 *    way by accident.
 *  - Horizontal flex / inline-flex with an overflow-x of `auto`/`scroll` →
 *    `carousel`. Flex alone isn't enough (a top-nav is also row-flex), but
 *    the overflow flag is what makes a track *scrollable* and therefore a
 *    carousel rather than a static row.
 *  - Everything else → `list`. Default block flow with stacked children is
 *    the dominant case; we don't try to distinguish "vertical flex list"
 *    from "block list" since both render the same horizontal-sliver.
 *
 *  Pure: read-only, no DOM writes. Requires the element to be in a layout
 *  tree so `getComputedStyle` returns meaningful values — call it after
 *  detect() has produced the container.
 */
export function classify(container: Element): LayoutKind {
  const style = getComputedStyle(container);
  const display = style.display;
  if (display === 'grid' || display === 'inline-grid') return 'grid';

  if (display === 'flex' || display === 'inline-flex') {
    const direction = style.flexDirection;
    const horizontal = direction === 'row' || direction === 'row-reverse';
    const overflowX = style.overflowX;
    const scrolls = overflowX === 'auto' || overflowX === 'scroll';
    if (horizontal && scrolls) return 'carousel';
  }
  return 'list';
}

/** Walk every Element under `root` (including `root` itself when it's an
 *  Element) and return the best container for any of them. */
export function detect(root: Document | Element): Element | null {
  const startEl: Element = root instanceof Document ? root.documentElement : root;
  if (!startEl) return null;

  // Subtree sizes computed once for the whole walk — see DescendantCounts.
  const counts = computeDescendantCounts(startEl);

  let best: Candidate | null = null;

  // Iterative walk (avoid recursion for very deep DOMs). Skip non-content
  // subtrees entirely — no children of <head>/<script> can win.
  const stack: Element[] = [startEl];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (NON_CONTENT_TAGS.has(node.tagName)) continue;

    const cand = evaluateParent(node, counts);
    if (cand && (!best || cand.score > best.score)) best = cand;

    for (const child of Array.from(node.children)) {
      if (!NON_CONTENT_TAGS.has(child.tagName)) stack.push(child);
    }
  }

  return best?.container ?? null;
}

// ---------------------------------------------------------------------------
// Selector generalization (2.4)
// ---------------------------------------------------------------------------

/** Result of generalize(): both halves of a Schema's selectors.
 *  `itemSetSelector` is the outer container; `itemSelector` is the absolute
 *  selector for every structurally-similar sibling inside it. */
export interface GeneralizedSelectors {
  itemSetSelector: string;
  itemSelector: string;
}

/** A single-element selector built from tag + sorted class list. Mirrors
 *  the structural signature used by detect(), so the two modules agree on
 *  what counts as "the same kind of element."
 *
 *  Falls back to bare tag when classList is empty or all classes are
 *  unstable-looking (e.g. utility-generated hashes). Slice-2 fixtures all
 *  use stable hand-written classes; class-stability heuristics are 6.2's
 *  problem (fingerprint hardening).
 */
function leafSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  // Mirror signatureOf(): drop volatile per-item classes so the generated
  // selector matches every same-shape sibling, not just the picked card.
  const classes = stableClasses(el);
  if (classes === '') return tag;
  const escaped = classes
    .split('.')
    .map((c) => `.${CSS.escape(c)}`)
    .join('');
  return `${tag}${escaped}`;
}

/** Build the shortest selector that uniquely identifies `el` inside
 *  `el.ownerDocument`, ascending only as far as needed.
 *
 *  Priority order:
 *    1. `#id` if the element has one (and it actually resolves to itself).
 *    2. `tag.classes` alone if it's already unique document-wide.
 *    3. Prepend ancestor selectors with `>` until uniqueness is reached.
 *    4. Bail out at <body>/<html> and just return whatever path we have —
 *       that's still good enough to seed a Schema; Slice 3's LLM gets a
 *       cleaner shot when this happens.
 */
function uniqueSelectorFor(el: Element): string {
  const doc = el.ownerDocument;
  if (!doc) return leafSelector(el);

  // 1. An id is the cheapest unique handle.
  if (el.id) {
    const idSel = `#${CSS.escape(el.id)}`;
    if (doc.querySelector(idSel) === el) return idSel;
  }

  // 2. Walk up, composing `path > ancestorPath` until the whole selector
  //    matches exactly the element we're describing.
  let path = leafSelector(el);
  if (doc.querySelector(path) === el) return path;

  let cursor: Element | null = el.parentElement;
  while (cursor && cursor !== doc.documentElement) {
    if (cursor.id) {
      const prefixed = `#${CSS.escape(cursor.id)} > ${path}`;
      if (doc.querySelector(prefixed) === el) return prefixed;
    }
    const ancestor = leafSelector(cursor);
    path = `${ancestor} > ${path}`;
    if (doc.querySelector(path) === el) return path;
    cursor = cursor.parentElement;
  }
  return path;
}

/** Given a picked example element, produce {itemSetSelector, itemSelector}
 *  such that itemSelector matches every structurally-similar sibling of
 *  the picked element under its immediate parent.
 *
 *  Returns null when there's no meaningful generalization — e.g. the
 *  picked element is detached, or it's a one-off with no same-shape
 *  siblings (then there's no "item set" at all).
 */
export function generalize(picked: Element): GeneralizedSelectors | null {
  const parent = picked.parentElement;
  if (!parent) return null;

  // The leaf signature defines the sibling cluster we're generalizing to.
  const leaf = leafSelector(picked);
  const sameShapeSiblings = Array.from(parent.children).filter(
    (c) => leafSelector(c) === leaf,
  );
  if (sameShapeSiblings.length < MIN_GROUP_SIZE) return null;

  const itemSetSelector = uniqueSelectorFor(parent);
  const itemSelector = `${itemSetSelector} > ${leaf}`;

  // Final sanity: the composed selector must round-trip — querySelectorAll
  // from the document needs to land on exactly our sibling cluster (no
  // extras from elsewhere on the page, no misses). If it doesn't, the
  // parent path wasn't unique enough — return null and let the caller
  // either fall back to detect() or re-prompt the user.
  const doc = picked.ownerDocument;
  if (doc) {
    const matched = Array.from(doc.querySelectorAll(itemSelector));
    if (matched.length !== sameShapeSiblings.length) return null;
    for (const sib of sameShapeSiblings) {
      if (!matched.includes(sib)) return null;
    }
  }

  return { itemSetSelector, itemSelector };
}

/** Build robust selectors for an already-detected item-set container without
 *  the LLM. Unlike generalize() (which is strict and parent-relative for the
 *  manual picker), this is lenient: it keys off the *modal* stable-class shape
 *  among the container's children and returns a global `itemSelector`. It's
 *  what lets keyword filtering work on real SPA lists where the LLM either
 *  isn't available or returns a selector matching a single card.
 *
 *  Returns null when the container has no qualifying repeated child shape.
 *  `count` is how many elements the returned itemSelector matches document-
 *  wide, so callers can compare it against an LLM selector and keep whichever
 *  captures more items. */
export function localizeItemSet(
  itemSet: Element,
): { itemSetSelector: string; itemSelector: string; count: number } | null {
  const children = elementChildren(itemSet);
  if (children.length < MIN_GROUP_SIZE) return null;

  // Modal stable-class shape among the children — tolerant of a few cards
  // carrying an extra state class (viewed / promoted / selected).
  const counts = new Map<string, { count: number; sample: Element }>();
  for (const child of children) {
    const sig = signatureOf(child);
    const entry = counts.get(sig);
    if (entry) entry.count += 1;
    else counts.set(sig, { count: 1, sample: child });
  }
  let modal: { count: number; sample: Element } | null = null;
  for (const entry of counts.values()) {
    if (!modal || entry.count > modal.count) modal = entry;
  }
  if (!modal || modal.count < MIN_GROUP_SIZE) return null;

  const doc = itemSet.ownerDocument;
  if (!doc) return null;

  const leaf = leafSelector(modal.sample);
  const itemSetSelector = uniqueSelectorFor(itemSet);
  const scoped = `${itemSetSelector} > ${leaf}`;

  // Prefer the scoped selector when it covers the modal group; fall back to
  // the bare leaf only when scoping (via a hashed/ambiguous container path)
  // LOSES cards. Never prefer the leaf for matching MORE — a generic leaf
  // like `div` matches the whole page (seen live on github.com search:
  // bare `div` → 212 "items" including header decorations).
  //
  // The reported `count` is always measured WITHIN the container: findItems
  // re-scopes a bare-leaf selector via bestRoot anyway, and discover.ts
  // compares this count against the LLM selector's — a document-wide leaf
  // count (lookalikes outside the container) made an over-broad local
  // selector beat a correct LLM one.
  const scopedCount = safeCount(doc, scoped);
  const leafCount = safeCount(itemSet, leaf);
  let itemSelector: string;
  let count: number;
  if (scopedCount >= modal.count) {
    itemSelector = scoped;
    count = scopedCount;
  } else {
    itemSelector = leaf;
    count = leafCount;
  }
  if (count < MIN_GROUP_SIZE) return null;
  return { itemSetSelector, itemSelector, count };
}

/** querySelectorAll length that never throws on a malformed selector. */
function safeCount(root: ParentNode, selector: string): number {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}
