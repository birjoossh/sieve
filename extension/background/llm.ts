// background/llm.ts — DOM distillation (3.1) + provider call + Schema parser (3.2).
//
// **Distillation** (3.1): produce a structure-only, content-redacted
// skeleton of a DOM subtree suitable for sending to an LLM as a
// "describe this layout for me" input. The output is the **only** payload the
// extension sends to the user's chosen LLM provider — see `PRIVACY.md`
// (Slice 6.5). Nothing here may smuggle text content out.
//
// **Discovery** (3.2): post the distilled skeleton to the user's chosen
// provider (Anthropic / OpenAI) with their BYO key, parse the JSON
// response into a typed `Schema`. Pure orchestration: `fetcher` is
// injectable (defaults to `globalThis.fetch`) so tests drive it with
// canned responses without touching the network. Malformed responses
// throw a typed `SchemaParseError` — callers (SW message handler, panel
// re-discover button) can surface a clear reason instead of guessing
// at `JSON.parse` exceptions.
//
// `distill()` is **content-side only** (it dereferences `.classList`,
// `.children`, etc.). `discoverSchema()` runs **SW-side** — no DOM. Module
// load is DOM-safe (only TS types reference DOM globals at the top level),
// so importing this file into both surfaces is fine.
//
// What stays in the skeleton:
//   - tag names
//   - class lists (sorted, verbatim — selectors will reference these)
//   - role (a useful semantic hint that isn't content)
//   - id (root container only — useful landmark, leaked-content risk low)
//   - the nesting itself
// What's redacted (replaced with `…`):
//   - all text content
//   - aria-label, alt, title, placeholder (these are content too)
//   - href, src URLs (replaced with `#…` so "this is a link" survives)
// What's dropped entirely:
//   - style, data-* (often per-item ids / internal state), on* handlers
//   - comments
//   - script/style/link/meta/noscript/template subtrees
// Bounding:
//   - depth ≤ MAX_DEPTH (pathological pages don't blow up the prompt)
//   - runs of ≥COLLAPSE_THRESHOLD consecutive same-shape siblings collapse
//     to first + `… ×N more <shape>` (10 identical job cards become 1+1)
//
// Hardening deferred to 6.2: locale-sensitive class sort, larger denylist
// of "looks utility-generated" classes (CSS-in-JS hashes), and once the
// surrounding paths are async-friendly, a SHA-256 fingerprint of the
// distilled output for cache de-dupe.

import type { FieldKind, FieldSpec, LayoutKind, Schema } from '../shared/types.js';
import { SpendCapError, type SpendChecker } from './spend.js';

const NON_CONTENT_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'LINK',
  'META',
  'NOSCRIPT',
  'TEMPLATE',
]);

const REDACT_ATTRS = [
  'aria-label',
  'alt',
  'title',
  'placeholder',
  'value',
  'name',
  'for',
  'download',
] as const;
const URL_ATTRS = ['href', 'src', 'srcset', 'action', 'formaction'] as const;

const MAX_DEPTH = 8;
const COLLAPSE_THRESHOLD = 3;
const REDACTED = '…';
const INDENT = '  ';

/** Tag + sorted class list — the same "same-shape" signature
 *  fingerprint.ts and detect.ts use. Sibling collapse + the collapse-
 *  marker share this so any future tweak to shape ordering can't drift
 *  the two apart. */
function shapeOf(el: Element): string {
  const classes = Array.from(el.classList).sort().join('.');
  return classes ? `${el.tagName.toLowerCase()}.${classes}` : el.tagName.toLowerCase();
}

function elementChildren(parent: Element): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (NON_CONTENT_TAGS.has(child.tagName)) continue;
    out.push(child);
  }
  return out;
}

function hasVisibleText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 && (node.textContent ?? '').trim() !== '') return true;
  }
  return false;
}

function renderAttrs(el: Element, isRoot: boolean): string {
  const parts: string[] = [];
  if (el.classList.length > 0) {
    const sorted = Array.from(el.classList).sort().join(' ');
    parts.push(`class="${sorted}"`);
  }
  const role = el.getAttribute('role');
  if (role) parts.push(`role="${role}"`);
  if (isRoot && el.id) parts.push(`id="${el.id}"`);
  for (const a of REDACT_ATTRS) {
    if (el.hasAttribute(a) && (el.getAttribute(a) ?? '').trim() !== '') {
      parts.push(`${a}="${REDACTED}"`);
    }
  }
  for (const a of URL_ATTRS) {
    if (el.hasAttribute(a)) parts.push(`${a}="#${REDACTED}"`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function distillNode(el: Element, depth: number, isRoot: boolean): string[] {
  const tag = el.tagName.toLowerCase();
  const attrs = renderAttrs(el, isRoot);
  const indent = INDENT.repeat(depth);

  if (depth >= MAX_DEPTH) {
    return [`${indent}<${tag}${attrs}>${REDACTED}</${tag}>`];
  }

  const children = elementChildren(el);
  if (children.length === 0) {
    if (hasVisibleText(el)) {
      return [`${indent}<${tag}${attrs}>${REDACTED}</${tag}>`];
    }
    return [`${indent}<${tag}${attrs}/>`];
  }

  const out: string[] = [`${indent}<${tag}${attrs}>`];
  let i = 0;
  while (i < children.length) {
    const first = children[i] as Element;
    const sig = shapeOf(first);
    let j = i + 1;
    while (j < children.length && shapeOf(children[j] as Element) === sig) j++;
    const runLen = j - i;
    out.push(...distillNode(first, depth + 1, false));
    if (runLen >= COLLAPSE_THRESHOLD) {
      const more = runLen - 1;
      out.push(`${INDENT.repeat(depth + 1)}… ×${more} more <${sig}>`);
    } else {
      for (let k = i + 1; k < j; k++) {
        out.push(...distillNode(children[k] as Element, depth + 1, false));
      }
    }
    i = j;
  }
  out.push(`${indent}</${tag}>`);
  return out;
}

/** Produce a structure-only, content-redacted skeleton of `root` and its
 *  descendants. Pure — no DOM mutation, no layout reads. Output is stable
 *  on identical inputs (deterministic class sort, deterministic sibling
 *  collapse). Designed to be safe to send to an external LLM provider:
 *  every escape hatch for content (text, urls, aria-label/title/alt/
 *  placeholder, data-*, id-on-non-root) is closed by construction here,
 *  not by caller discipline.
 *
 *  Contract: callers pass the candidate **item-set container** (what
 *  `detect()` returns), not `document` or `document.documentElement` —
 *  `<head>` content (page title, meta description, og: tags) is *not*
 *  redacted by this function. */
export function distill(root: Element): string {
  return distillNode(root, 0, true).join('\n');
}

// ---------------------------------------------------------------------------
// 3.2 — provider call + Schema parser
// ---------------------------------------------------------------------------

import type { LlmProvider } from '../shared/types.js';
export type Provider = LlmProvider;

/** Thrown when the provider response can't be turned into a valid `Schema`.
 *  `reason` is a short human-readable string; `raw` holds the original
 *  response text (truncated) so the UI can offer "show details". */
export class SchemaParseError extends Error {
  readonly reason: string;
  readonly raw: string | undefined;
  constructor(reason: string, raw?: string) {
    super(`SchemaParseError: ${reason}`);
    this.name = 'SchemaParseError';
    this.reason = reason;
    this.raw = raw === undefined ? undefined : raw.slice(0, 500);
  }
}

export interface DiscoverOpts {
  provider: Provider;
  apiKey: string;
  /** Fingerprint of the detected item-set — stamped onto the returned
   *  Schema so the cache key is bound at construction time, not by the
   *  caller. Comes from `fingerprintItemSet()` in content/fingerprint.ts. */
  fingerprint: string;
  /** Provider model id. Defaults to a recent Sonnet / gpt-4o-class model. */
  model?: string;
  /** Optional base URL — for OpenAI-compatible (OpenRouter, LiteLLM,
   *  Ollama, vLLM) or Anthropic-compatible proxies. The provider-
   *  specific path is appended; trailing slashes on the base are
   *  normalized. */
  baseUrl?: string;
  /** Optional user correction hint (Slice 3.5 re-discover-with-hint). */
  hint?: string;
  /** Injectable fetch — defaults to `globalThis.fetch`. Tests pass a mock. */
  fetcher?: typeof fetch;
  /** Injectable clock — defaults to `Date.now`. Tests freeze it. */
  now?: () => number;
  /** 4.7 spend cap. Defaults to undefined (no cap enforced) — the SW
   *  wires a chromeStorageSpendChecker; tests pass a memorySpendChecker.
   *  When set, `canSpend(now)` is checked before the provider call
   *  (throws `SpendCapError`) and `recordSpend(now)` is invoked after
   *  a successful schema return. */
  spend?: SpendChecker;
}

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
};

const VALID_LAYOUTS: ReadonlySet<LayoutKind> = new Set(['list', 'carousel', 'grid']);
const VALID_FIELD_KINDS: ReadonlySet<FieldKind> = new Set([
  'text',
  'number',
  'date',
  'enum',
  'flag',
]);

/** Prompt template. Kept inline — Slice 3.5 freezes it as a golden if/when
 *  prompt drift becomes a regression risk. */
function buildPrompt(distilled: string, hint?: string): string {
  const hintLine = hint && hint.trim() !== '' ? `\nUser hint: ${hint.trim()}\n` : '';
  return `You are inspecting the structure of a web page to write CSS selectors that pick out a list of similar items.

Output ONLY a single JSON object — no prose, no markdown fences — matching this shape exactly:

{
  "layout": "list" | "carousel" | "grid",
  "itemSetSelector": <CSS selector for the outer container>,
  "itemSelector": <CSS selector for one repeating item within the container>,
  "fields": {
    "<fieldName>": { "kind": "text"|"number"|"date"|"enum"|"flag", "selector": <CSS selector inside one item> }
  },
  "detailLinkSelector"?: <CSS selector for the anchor → detail page>,
  "detailFieldSelectors"?: { "<fieldName>": <CSS selector on the detail page> }
}

The skeleton below has had text content redacted (\`…\`) and per-item attributes (data-*, ids, styles) stripped. Class names and structure are intact — base your selectors on those.

Skeleton:
${distilled}
${hintLine}`;
}

/** Strip ```json fences and surrounding prose; return the JSON object as a
 *  string. The LLM is told not to wrap, but real models do it anyway often
 *  enough that being lenient here saves a re-prompt round-trip. */
function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  // Fenced: ```json ... ``` or ``` ... ```
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fence?.[1]) return fence[1].trim();
  // Fallback: take from the first '{' to the last '}'.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.trim() !== '';
}

function isFieldSpec(x: unknown): x is FieldSpec {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  if (!isNonEmptyString(r['selector'])) return false;
  if (typeof r['kind'] !== 'string' || !VALID_FIELD_KINDS.has(r['kind'] as FieldKind)) {
    return false;
  }
  if ('deep' in r && r['deep'] !== undefined && typeof r['deep'] !== 'boolean') {
    return false;
  }
  return true;
}

function isStringRecord(x: unknown): x is Record<string, string> {
  if (typeof x !== 'object' || x === null) return false;
  for (const v of Object.values(x)) {
    if (typeof v !== 'string') return false;
  }
  return true;
}

/** Validate the parsed JSON object matches the `Schema` contract and return
 *  the fully-typed Schema with `source`, `fingerprint`, `discoveredAt`
 *  stamped from the caller's context. Throws `SchemaParseError` with a
 *  specific reason on any shape violation. */
function validateSchemaShape(
  obj: unknown,
  fingerprint: string,
  now: number,
  raw: string,
): Schema {
  if (typeof obj !== 'object' || obj === null) {
    throw new SchemaParseError('response is not a JSON object', raw);
  }
  const r = obj as Record<string, unknown>;

  if (typeof r['layout'] !== 'string' || !VALID_LAYOUTS.has(r['layout'] as LayoutKind)) {
    throw new SchemaParseError(`invalid layout: ${JSON.stringify(r['layout'])}`, raw);
  }
  if (!isNonEmptyString(r['itemSetSelector'])) {
    throw new SchemaParseError('itemSetSelector missing or empty', raw);
  }
  if (!isNonEmptyString(r['itemSelector'])) {
    throw new SchemaParseError('itemSelector missing or empty', raw);
  }
  if (typeof r['fields'] !== 'object' || r['fields'] === null) {
    throw new SchemaParseError('fields missing or not an object', raw);
  }

  const fields: Record<string, FieldSpec> = {};
  for (const [name, spec] of Object.entries(r['fields'] as Record<string, unknown>)) {
    if (!isFieldSpec(spec)) {
      throw new SchemaParseError(`field "${name}" has invalid FieldSpec`, raw);
    }
    fields[name] = spec;
  }
  if (Object.keys(fields).length === 0) {
    throw new SchemaParseError('fields object is empty', raw);
  }

  const schema: Schema = {
    fingerprint,
    layout: r['layout'] as LayoutKind,
    itemSetSelector: r['itemSetSelector'],
    itemSelector: r['itemSelector'],
    fields,
    source: 'llm',
    discoveredAt: now,
  };
  // Optional fields: drop silently when the model emits the wrong shape
  // (e.g. null, {}). The required core (layout/selectors/fields) is what
  // gates discovery; losing detail navigation is degradation, not failure.
  if ('detailLinkSelector' in r && isNonEmptyString(r['detailLinkSelector'])) {
    schema.detailLinkSelector = r['detailLinkSelector'];
  }
  if ('detailFieldSelectors' in r && isStringRecord(r['detailFieldSelectors'])) {
    schema.detailFieldSelectors = r['detailFieldSelectors'];
  }
  return schema;
}

interface ProviderResult {
  text: string;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function callAnthropic(
  prompt: string,
  opts: DiscoverOpts,
  fetcher: typeof fetch,
): Promise<ProviderResult> {
  const base = opts.baseUrl ?? 'https://api.anthropic.com';
  // OpenRouter + LiteLLM accept Bearer auth even on the Anthropic
  // shape; the upstream Anthropic API uses x-api-key. We send both so
  // callers don't have to think about it — gateways that don't
  // recognize x-api-key just ignore it.
  const res = await fetcher(joinUrl(base, '/v1/messages'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.apiKey,
      authorization: `Bearer ${opts.apiKey}`,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: opts.model ?? DEFAULT_MODEL.anthropic,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SchemaParseError(`Anthropic ${res.status}: ${body.slice(0, 200)}`, body);
  }
  const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  if (text === '') {
    throw new SchemaParseError('Anthropic response had no text content', JSON.stringify(json));
  }
  return { text };
}

async function callOpenAI(
  prompt: string,
  opts: DiscoverOpts,
  fetcher: typeof fetch,
): Promise<ProviderResult> {
  const base = opts.baseUrl ?? 'https://api.openai.com';
  const res = await fetcher(joinUrl(base, '/v1/chat/completions'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model ?? DEFAULT_MODEL.openai,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SchemaParseError(`OpenAI ${res.status}: ${body.slice(0, 200)}`, body);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content ?? '';
  if (text === '') {
    throw new SchemaParseError('OpenAI response had no content', JSON.stringify(json));
  }
  return { text };
}

/** Discover a `Schema` from a distilled DOM skeleton.
 *
 *  Flow: build prompt → call provider with `opts.apiKey` → extract the JSON
 *  object from the response (lenient about ```json fences) → validate the
 *  shape against the `Schema` contract → stamp `fingerprint`, `source:
 *  'llm'`, `discoveredAt` → return.
 *
 *  Throws `SchemaParseError` for: non-2xx provider response, missing/empty
 *  text in the response, non-JSON response body, or any Schema-shape
 *  violation. `JSON.parse` failures are also wrapped in `SchemaParseError`
 *  so callers only need one catch arm. */
export async function discoverSchema(distilled: string, opts: DiscoverOpts): Promise<Schema> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const now = opts.now ?? Date.now;

  // 4.7: spend cap check fires BEFORE the provider call so a blocked
  // call costs the user nothing (zero network) and surfaces a typed
  // error the panel can render. The check is opt-in via opts.spend
  // — current 3.x callers (tests) leave it undefined and proceed
  // unchecked, matching their original semantics.
  if (opts.spend) {
    const check = await opts.spend.canSpend(now());
    if (!check.ok) throw new SpendCapError(check.period);
  }

  const prompt = buildPrompt(distilled, opts.hint);

  const result =
    opts.provider === 'anthropic'
      ? await callAnthropic(prompt, opts, fetcher)
      : await callOpenAI(prompt, opts, fetcher);

  const jsonText = extractJsonObject(result.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SchemaParseError(`response is not valid JSON: ${msg}`, result.text);
  }
  const schema = validateSchemaShape(parsed, opts.fingerprint, now(), result.text);
  // Record spend only on a successfully parsed Schema — provider 5xx +
  // malformed JSON don't move the meter.
  if (opts.spend) await opts.spend.recordSpend(now());
  return schema;
}

// ---------------------------------------------------------------------------
// 4.8 — phrase suggestions
// ---------------------------------------------------------------------------

export interface SuggestPhrasesOpts {
  provider: Provider;
  apiKey: string;
  /** Existing phrases the user has already typed — feed the LLM so the
   *  suggestions complement rather than duplicate. */
  existing: readonly string[];
  /** Plain-English description of what the user is trying to exclude
   *  ("jobs requiring Mandarin language fluency"). Built by the panel
   *  from the active filter's field + polarity. */
  intent: string;
  model?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  spend?: SpendChecker;
}

const SUGGEST_PROMPT_HEADER = `You suggest additional phrases that match the user's exclusion intent.

Output ONLY a single JSON object with this exact shape:
{ "suggestions": ["phrase one", "phrase two", ...] }

Suggest up to 6 short, distinct phrases. Don't repeat anything in "existing". Each phrase should be a literal substring that would appear in an item's text — not regex, not bullet syntax.`;

function buildSuggestPrompt(opts: SuggestPhrasesOpts): string {
  const existing = opts.existing.length === 0 ? '(none yet)' : opts.existing.join(', ');
  return `${SUGGEST_PROMPT_HEADER}

Intent: ${opts.intent}
Existing phrases: ${existing}`;
}

function parseSuggestions(raw: string): string[] {
  const obj = JSON.parse(extractJsonObject(raw)) as { suggestions?: unknown };
  if (!Array.isArray(obj.suggestions)) {
    throw new SchemaParseError('suggestions field missing or not an array', raw);
  }
  const out: string[] = [];
  for (const v of obj.suggestions) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed.length > 0 && trimmed.length <= 80) out.push(trimmed);
  }
  return out;
}

/** Ask the LLM for additional phrases that fit an exclusion intent.
 *  Honors the same spend-cap contract as `discoverSchema`. Returns
 *  deduped (case-insensitive) string array, possibly empty. */
export async function suggestPhrases(opts: SuggestPhrasesOpts): Promise<string[]> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const now = opts.now ?? Date.now;

  if (opts.spend) {
    const check = await opts.spend.canSpend(now());
    if (!check.ok) throw new SpendCapError(check.period);
  }

  const prompt = buildSuggestPrompt(opts);
  const callOpts: DiscoverOpts = {
    provider: opts.provider,
    apiKey: opts.apiKey,
    // Suggestions are fingerprint-agnostic. We pass a synthetic value
    // so we can reuse the provider plumbing without forking it.
    fingerprint: 'suggest',
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    fetcher,
  };
  const result =
    opts.provider === 'anthropic'
      ? await callAnthropic(prompt, callOpts, fetcher)
      : await callOpenAI(prompt, callOpts, fetcher);

  let suggestions: string[];
  try {
    suggestions = parseSuggestions(result.text);
  } catch (err) {
    if (err instanceof SchemaParseError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new SchemaParseError(`suggestions response is not valid JSON: ${msg}`, result.text);
  }

  if (opts.spend) await opts.spend.recordSpend(now());

  // De-dupe against existing (case-insensitive) since the LLM doesn't
  // always honor the "don't repeat" instruction.
  const seen = new Set(opts.existing.map((p) => p.toLowerCase()));
  const out: string[] = [];
  for (const s of suggestions) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}
