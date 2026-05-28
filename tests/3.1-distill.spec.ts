// 3.1 — DOM distillation golden test.
//
// Gate from tasks.md:
//   "fixture DOM → frozen distilled output. Regenerate-on-PR."
//
// Three fixtures locked in (one per layout — list / carousel / grid) so any
// drift in either the distillation logic *or* in what counts as
// content-vs-structure shows up as a single-file diff in the PR. To refresh
// goldens after an intentional change:  UPDATE_GOLDEN=1 npx playwright test
// tests/3.1-distill.spec.ts
//
// Independent guard: a separate test asserts that no known content strings
// from rolecast.html survive the redaction — protects us from the
// regenerate-on-missing-file path silently bootstrapping a *broken* golden
// (e.g. if a future refactor accidentally lets data-* or aria-label
// content leak through, the regenerated file would still match itself, but
// the leak test would fail loudly).

import { test, expect, chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');
const GOLDEN_DIR = resolve(__dirname, 'golden');

const UPDATE = process.env.UPDATE_GOLDEN === '1';

interface DistillCase {
  fixture: string;
  containerSelector: string;
  goldenName: string;
}

const CASES: readonly DistillCase[] = [
  {
    fixture: 'rolecast.html',
    containerSelector: '.joblist',
    goldenName: 'rolecast.distilled.txt',
  },
  {
    fixture: 'carousel.html',
    containerSelector: '.carousel-track',
    goldenName: 'carousel.distilled.txt',
  },
  {
    fixture: 'grid.html',
    containerSelector: '.cs-grid',
    goldenName: 'grid.distilled.txt',
  },
];

async function distillFor(fixture: string, sel: string): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(resolve(FIXTURES, fixture)).href);
    await page.addScriptTag({ path: TESTBED });
    return await page.evaluate((selector) => {
      const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
      const root = document.querySelector(selector);
      if (!root) throw new Error(`no element matches ${selector}`);
      return nf.distill(root);
    }, sel);
  } finally {
    await browser.close();
  }
}

test.describe('3.1 — DOM distillation (golden)', () => {
  if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

  for (const c of CASES) {
    test(`${c.fixture} → ${c.goldenName}`, async () => {
      const actual = await distillFor(c.fixture, c.containerSelector);
      const goldenPath = resolve(GOLDEN_DIR, c.goldenName);
      if (UPDATE || !existsSync(goldenPath)) {
        writeFileSync(goldenPath, actual);
        // First-run bootstrap is intentional; reviewer reads the diff.
        // eslint-disable-next-line no-console
        console.log(`wrote golden: ${goldenPath}`);
      }
      const expected = readFileSync(goldenPath, 'utf-8');
      expect(actual).toBe(expected);
    });
  }

  test('no content leaks through redaction (rolecast denylist)', async () => {
    const distilled = await distillFor('rolecast.html', '.joblist');
    // Text content the LLM must never see.
    for (const phrase of [
      'Senior Backend Engineer',
      'Mandatory Mandarin',
      'Acme Robotics',
      'Mariner Defense',
      'Shanghai',
      '180k',
    ]) {
      expect(distilled, `text "${phrase}" must be redacted`).not.toContain(phrase);
    }
    // data-* values the LLM must never see (per-item ids).
    expect(distilled, 'data-id values must be redacted').not.toContain('r-001');
    expect(distilled, 'data-list-name values must be redacted').not.toContain('open-roles');
    // The id attribute should not appear on inner elements (root only).
    // No fixture root has an id; assert no inner element id either.
    expect(distilled).not.toMatch(/<article[^>]*\bid=/);
  });

  test('class-name signals survive (LLM needs them to write selectors)', async () => {
    const distilled = await distillFor('rolecast.html', '.joblist');
    expect(distilled).toContain('class="joblist"');
    expect(distilled).toContain('class="job"');
    expect(distilled).toContain('class="title"');
    expect(distilled).toContain('class="snippet"');
  });
});
