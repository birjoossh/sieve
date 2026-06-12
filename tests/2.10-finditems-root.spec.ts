// 2.10 — findItems root resolution when itemSetSelector is not unique.
//
// YouTube's watch page produced an itemSetSelector matching FOUR elements,
// with the real list not first in document order — first-match scoping
// rooted findItems at an empty lookalike and mounted with 0 items while 20
// related videos sat in the right container. findItems must pick the
// candidate root that actually contains item matches, and honor an
// explicitly passed container (mount() hands over the detected element).

import { test, expect, chromium } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

const PAGE = `
  <div class="panel"><p>sidebar lookalike, no cards</p></div>
  <div class="panel"><span>another empty twin</span></div>
  <div class="panel">
    <div class="card">Alpha</div>
    <div class="card">Beta</div>
    <div class="card">Gamma</div>
    <div class="card">Delta</div>
  </div>
  <div class="panel"><div class="card">Stray solo card</div></div>
`;

test.describe('2.10 — findItems picks the right root among set-selector twins', () => {
  test('best-root heuristic + explicit knownItemSet override', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.setContent(PAGE);
      await page.addScriptTag({ path: TESTBED });

      const r = await page.evaluate(() => {
        const nf = window.__nf;
        const schema = {
          fingerprint: 'test:twins',
          layout: 'list' as const,
          itemSetSelector: 'div.panel',
          itemSelector: 'div.card',
          fields: {},
          source: 'local' as const,
          discoveredAt: 0,
        };
        const heuristic = nf.findItems(schema).map((el) => el.textContent);
        const explicit = nf
          .findItems(schema, document, document.querySelectorAll('div.panel')[3]!)
          .map((el) => el.textContent);
        return { heuristic, explicit };
      });

      // Heuristic: the 4-card panel wins over the empty twins AND over the
      // 1-card straggler.
      expect(r.heuristic).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
      // Explicit container short-circuits the heuristic entirely.
      expect(r.explicit).toEqual(['Stray solo card']);
    } finally {
      await browser.close();
    }
  });
});
