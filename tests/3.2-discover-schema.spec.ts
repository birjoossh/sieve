// 3.2 — provider call + Schema parser.
//
// Gate from tasks.md:
//   "with a mock provider serving canned Schema responses, sending a
//    distilled DOM returns a typed Schema. Malformed response → typed error."
//
// All network is stubbed via `opts.fetcher` (no real HTTP). The mock fetch
// runs inside `page.evaluate` so it can also capture the request shape
// (URL, headers, body) for the request-side assertions.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface RunResult {
  ok: boolean;
  schema?: unknown;
  errorName?: string | undefined;
  errorReason?: string | undefined;
  call?: MockCall | undefined;
}

const GOOD_RESPONSE = {
  layout: 'list',
  itemSetSelector: '.joblist',
  itemSelector: '.joblist > .job',
  fields: {
    title: { kind: 'text', selector: '.title' },
    company: { kind: 'text', selector: '.company' },
    snippet: { kind: 'text', selector: '.snippet' },
  },
  detailLinkSelector: '.title a',
};

interface RunArgs {
  provider: 'anthropic' | 'openai';
  responseText: string;
  responseStatus?: number;
  fingerprint?: string;
  hint?: string;
}

async function runDiscover(args: RunArgs): Promise<RunResult> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ path: TESTBED });
    return await page.evaluate(async (a) => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      let captured: MockCall | undefined;

      const mockFetch: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        const headers: Record<string, string> = {};
        const h = init?.headers;
        if (h instanceof Headers) {
          h.forEach((v, k) => (headers[k] = v));
        } else if (Array.isArray(h)) {
          for (const [k, v] of h) headers[k] = v;
        } else if (h && typeof h === 'object') {
          for (const [k, v] of Object.entries(h)) headers[k] = String(v);
        }
        let body: unknown = init?.body;
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch {
            // leave as string
          }
        }
        captured = { url, method: init?.method ?? 'GET', headers, body };

        // Build the provider-shaped response wrapping the canned text.
        const status = a.responseStatus ?? 200;
        if (status !== 200) {
          return new Response(a.responseText, { status });
        }
        const payload =
          a.provider === 'anthropic'
            ? { content: [{ type: 'text', text: a.responseText }] }
            : { choices: [{ message: { content: a.responseText } }] };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      try {
        const opts: Parameters<typeof nf.discoverSchema>[1] = {
          provider: a.provider,
          apiKey: 'sk-test-key',
          fingerprint: a.fingerprint ?? 'fp123',
          fetcher: mockFetch,
          now: () => 1700000000000,
        };
        if (a.hint !== undefined) opts.hint = a.hint;
        const schema = await nf.discoverSchema(
          '<main class="joblist">\n  <article class="job">\n    <h2 class="title">…</h2>\n  </article>\n  … ×9 more <article.job>\n</main>',
          opts,
        );
        return { ok: true, schema, call: captured };
      } catch (err) {
        const e = err as Error & { reason?: string };
        return {
          ok: false,
          errorName: e.name,
          errorReason: e.reason ?? e.message,
          call: captured,
        };
      }
    }, args);
  } finally {
    await browser.close();
  }
}

test.describe('3.2 — discoverSchema', () => {
  test('Anthropic happy path → typed Schema with fingerprint + source stamped', async () => {
    const r = await runDiscover({
      provider: 'anthropic',
      responseText: JSON.stringify(GOOD_RESPONSE),
      fingerprint: 'fp-rolecast',
    });
    expect(r.ok).toBe(true);
    expect(r.schema).toMatchObject({
      fingerprint: 'fp-rolecast',
      layout: 'list',
      itemSetSelector: '.joblist',
      itemSelector: '.joblist > .job',
      source: 'llm',
      discoveredAt: 1700000000000,
      detailLinkSelector: '.title a',
    });
    expect((r.schema as { fields: Record<string, unknown> }).fields).toEqual({
      title: { kind: 'text', selector: '.title' },
      company: { kind: 'text', selector: '.company' },
      snippet: { kind: 'text', selector: '.snippet' },
    });
  });

  test('Anthropic request shape: x-api-key + version header + distilled DOM in body', async () => {
    const r = await runDiscover({
      provider: 'anthropic',
      responseText: JSON.stringify(GOOD_RESPONSE),
    });
    expect(r.call?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r.call?.method).toBe('POST');
    expect(r.call?.headers['x-api-key']).toBe('sk-test-key');
    expect(r.call?.headers['anthropic-version']).toBe('2023-06-01');
    const body = r.call?.body as { messages?: Array<{ content: string }> };
    expect(body.messages?.[0]?.content).toContain('class="joblist"');
    expect(body.messages?.[0]?.content).toContain('"itemSetSelector"');
  });

  test('OpenAI happy path → typed Schema', async () => {
    const r = await runDiscover({
      provider: 'openai',
      responseText: JSON.stringify(GOOD_RESPONSE),
      fingerprint: 'fp-openai',
    });
    expect(r.ok).toBe(true);
    expect(r.schema).toMatchObject({
      fingerprint: 'fp-openai',
      source: 'llm',
      itemSelector: '.joblist > .job',
    });
  });

  test('OpenAI request shape: Authorization Bearer + chat-completions URL', async () => {
    const r = await runDiscover({
      provider: 'openai',
      responseText: JSON.stringify(GOOD_RESPONSE),
    });
    expect(r.call?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(r.call?.headers['authorization']).toBe('Bearer sk-test-key');
  });

  test('markdown-fenced JSON response is still parsed', async () => {
    const r = await runDiscover({
      provider: 'anthropic',
      responseText: '```json\n' + JSON.stringify(GOOD_RESPONSE) + '\n```',
    });
    expect(r.ok).toBe(true);
    expect((r.schema as { itemSetSelector: string }).itemSetSelector).toBe('.joblist');
  });

  test('non-JSON response → SchemaParseError', async () => {
    const r = await runDiscover({
      provider: 'anthropic',
      responseText: 'Sorry, I cannot help with that.',
    });
    expect(r.ok).toBe(false);
    expect(r.errorName).toBe('SchemaParseError');
    expect(r.errorReason).toMatch(/JSON/i);
  });

  test('missing itemSetSelector → SchemaParseError with specific reason', async () => {
    const r = await runDiscover({
      provider: 'anthropic',
      responseText: JSON.stringify({
        layout: 'list',
        itemSelector: '.job',
        fields: { title: { kind: 'text', selector: '.title' } },
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.errorName).toBe('SchemaParseError');
    expect(r.errorReason).toContain('itemSetSelector');
  });

  test('invalid layout value → SchemaParseError', async () => {
    const r = await runDiscover({
      provider: 'anthropic',
      responseText: JSON.stringify({
        ...GOOD_RESPONSE,
        layout: 'masonry',
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.errorName).toBe('SchemaParseError');
    expect(r.errorReason).toContain('layout');
  });

  test('field with unknown kind → SchemaParseError', async () => {
    const r = await runDiscover({
      provider: 'anthropic',
      responseText: JSON.stringify({
        ...GOOD_RESPONSE,
        fields: { title: { kind: 'paragraph', selector: '.title' } },
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.errorName).toBe('SchemaParseError');
    expect(r.errorReason).toContain('title');
  });

  test('empty fields object → SchemaParseError', async () => {
    const r = await runDiscover({
      provider: 'anthropic',
      responseText: JSON.stringify({ ...GOOD_RESPONSE, fields: {} }),
    });
    expect(r.ok).toBe(false);
    expect(r.errorReason).toContain('empty');
  });

  test('provider non-2xx → SchemaParseError with status', async () => {
    const r = await runDiscover({
      provider: 'anthropic',
      responseText: 'unauthorized',
      responseStatus: 401,
    });
    expect(r.ok).toBe(false);
    expect(r.errorName).toBe('SchemaParseError');
    expect(r.errorReason).toContain('401');
  });

  test('hint is forwarded in the prompt', async () => {
    const r = await runDiscover({
      provider: 'anthropic',
      responseText: JSON.stringify(GOOD_RESPONSE),
      hint: 'the title lives inside the h2, not the link',
    });
    const body = r.call?.body as { messages?: Array<{ content: string }> };
    expect(body.messages?.[0]?.content).toContain('the title lives inside the h2');
  });
});
