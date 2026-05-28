// 5.3 — content/detail.ts — read schema-defined detail fields in the hidden tab.
//
// Gate from tasks.md:
//   "on a fixture detail page, fields are extracted matching expected
//    values."
//
// Pure unit test: load role-detail.html, build a schema with detail
// selectors pointing at .salary / .seniority / .visa / .role-team /
// .role-description p, run extractDetailFields, assert each field's
// trimmed text matches.

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

const DETAIL_SCHEMA = {
  fingerprint: 'fixture:role:v1',
  layout: 'list' as const,
  itemSetSelector: '.this-only-matches-the-list-page',
  itemSelector: '.this-only-matches-the-list-page > article',
  fields: {},
  detailLinkSelector: 'a.role-link',
  detailFieldSelectors: {
    title: '.role-title',
    team: '.role-team',
    salary: '.salary',
    seniority: '.seniority',
    visa: '.visa',
    description: '.role-description p',
    missing: '.does-not-exist',
  },
  source: 'stub' as const,
  discoveredAt: 0,
};

test.describe('5.3 — extractDetailFields', () => {
  test('all schema-listed selectors extracted from role-detail.html', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(resolve(FIXTURES, 'role-detail.html')).href);
      await page.addScriptTag({ path: TESTBED });

      const fields = await page.evaluate((schema) => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        return nf.extractDetailFields(schema as never);
      }, DETAIL_SCHEMA);

      expect(fields).toEqual({
        title: 'Senior Backend Engineer',
        team: 'Platform — Hardware Integration',
        salary: '$180,000 – $220,000 USD',
        seniority: 'Senior (L5)',
        visa: 'No visa sponsorship',
        description: expect.stringContaining('multi-region orchestration plane'),
        // missing selector omitted — not a null/empty key.
      });
      // Sanity: missing key is not present at all.
      expect(Object.prototype.hasOwnProperty.call(fields, 'missing')).toBe(false);
    } finally {
      await browser.close();
    }
  });

  test('isDetailPage returns true on detail fixture, false on list fixture', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const detail = await browser.newPage();
      await detail.goto(pathToFileURL(resolve(FIXTURES, 'role-detail.html')).href);
      await detail.addScriptTag({ path: TESTBED });
      const detailResult = await detail.evaluate((schema) => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        return nf.isDetailPage(schema as never);
      }, DETAIL_SCHEMA);
      expect(detailResult).toBe(true);

      const list = await browser.newPage();
      await list.goto(pathToFileURL(resolve(FIXTURES, 'rolecast.html')).href);
      await list.addScriptTag({ path: TESTBED });
      // List page has .joblist — flip the schema so itemSetSelector matches.
      const listSchema = { ...DETAIL_SCHEMA, itemSetSelector: '.joblist' };
      const listResult = await list.evaluate((schema) => {
        const nf = (window as unknown as { __nf: typeof window['__nf'] }).__nf;
        return nf.isDetailPage(schema as never);
      }, listSchema);
      expect(listResult).toBe(false);
    } finally {
      await browser.close();
    }
  });
});
