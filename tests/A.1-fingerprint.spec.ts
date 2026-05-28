// A.1 — Spike: layout fingerprint strategy.
//
// Gate from tasks.md:
//   load each captured HTML; assert fingerprint is *stable* within layout
//   (same key across captures) and *distinct* across layouts. 5 / 5
//   fixtures must pass.
//
// Captures used (5):
//   - rolecast.html       — list  (canonical)
//   - rolecast-v2.html    — list  (different content, count, attrs; same shape)
//   - carousel.html       — carousel (canonical)
//   - carousel-v2.html    — carousel (different content, count, attrs; same shape)
//   - grid.html           — grid
//
// Strategy under test: extension/content/fingerprint.ts (modal-shape hash).
// See its file comment for the four-strategy comparison + rationale.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

const FIXTURE_FILES = [
  'rolecast.html',
  'rolecast-v2.html',
  'carousel.html',
  'carousel-v2.html',
  'grid.html',
] as const;

type Fixture = (typeof FIXTURE_FILES)[number];

async function fingerprintFor(file: Fixture): Promise<string | null> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(resolve(FIXTURES, file)).href);
    await page.addScriptTag({ path: TESTBED });
    return await page.evaluate(() => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const container = nf.detect(document);
      if (!container) return null;
      return nf.fingerprintItemSet(container);
    });
  } finally {
    await browser.close();
  }
}

test.describe('A.1 — fingerprint stability + distinctness', () => {
  test('all 5 fixtures produce a fingerprint', async () => {
    const fps = new Map<Fixture, string | null>();
    for (const f of FIXTURE_FILES) fps.set(f, await fingerprintFor(f));
    for (const [f, fp] of fps) {
      expect(fp, `${f} must yield a fingerprint`).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  test('rolecast → same fingerprint as rolecast-v2 (list, content varies)', async () => {
    const a = await fingerprintFor('rolecast.html');
    const b = await fingerprintFor('rolecast-v2.html');
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  test('carousel → same fingerprint as carousel-v2 (carousel, content varies)', async () => {
    const a = await fingerprintFor('carousel.html');
    const b = await fingerprintFor('carousel-v2.html');
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  test('rolecast ≠ carousel ≠ grid (layouts distinct)', async () => {
    const list = await fingerprintFor('rolecast.html');
    const carousel = await fingerprintFor('carousel.html');
    const grid = await fingerprintFor('grid.html');
    expect(list).not.toBeNull();
    expect(carousel).not.toBeNull();
    expect(grid).not.toBeNull();
    const seen = new Set([list, carousel, grid]);
    expect(seen.size, 'three layouts → three distinct fingerprints').toBe(3);
  });
});
