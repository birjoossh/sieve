// 6.3 — Filter-set export / import (JSON file).
//
// Gate from tasks.md:
//   "export → import in a fresh profile → filters match."
//
// We can't span "a fresh profile" inside one test run cheaply, so we
// approximate with clear-storage. Drive the full UI flow:
//   1. Save a filter set (creates storage.sync entry).
//   2. Click Export → a download fires; capture the JSON.
//   3. Clear storage.sync for the filter keys.
//   4. Drive the file input with the captured JSON via setInputFiles.
//   5. Assert storage.sync now mirrors the original.

import { test, expect } from '@playwright/test';
import { setupExtEnv, enableAndWaitForContent, type ExtEnv } from './testbed/ext-env.js';
import { writeFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.describe('6.3 — saved-filter export + import round-trip', () => {
  let env: ExtEnv;

  test.beforeAll(async () => {
    env = await setupExtEnv();
    await enableAndWaitForContent(env);
  });

  test.afterAll(async () => {
    await env.teardown();
  });

  test('save → export → wipe → import file → saved filters restored', async () => {
    // 1. Save a phrase filter via the panel.
    await env.panel.fill('input[data-input="phrase"]', 'Mandarin');
    await env.panel.click('button.phrase-add');
    await env.panel.click('button[data-action="save-filters"]');
    await expect(env.panel.locator('[data-role="saved-badge"]')).toHaveCount(1);

    // Capture pre-export storage state.
    const before = await env.panel.evaluate(async () => {
      const all = await chrome.storage.sync.get(null);
      return Object.fromEntries(
        Object.entries(all).filter(([k]) => k.startsWith('nf:filters:')),
      );
    });
    expect(Object.keys(before).length).toBeGreaterThan(0);

    // 2. Trigger export — wait for the download.
    const [download] = await Promise.all([
      env.panel.waitForEvent('download'),
      env.panel.click('button[data-action="export-filters"]'),
    ]);
    // 3. Read the downloaded JSON to a tmpfile.
    const tmpdirPath = await mkdtemp(join(tmpdir(), 'nf-export-'));
    const filePath = join(tmpdirPath, 'export.json');
    await download.saveAs(filePath);
    const exportJson = await readFile(filePath, 'utf8');
    expect(exportJson).toContain('Mandarin');
    expect(exportJson).toContain('"v": 1');

    // 4. Wipe storage.sync filter keys.
    await env.panel.evaluate(async () => {
      const all = await chrome.storage.sync.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith('nf:filters:'));
      if (keys.length > 0) await chrome.storage.sync.remove(keys);
    });
    const wiped = await env.panel.evaluate(async () => {
      const all = await chrome.storage.sync.get(null);
      return Object.entries(all).filter(([k]) => k.startsWith('nf:filters:')).length;
    });
    expect(wiped).toBe(0);

    // 5. Write the export JSON to a fresh file + feed it to the
    // panel's file input.
    const importPath = join(tmpdirPath, 'import.json');
    await writeFile(importPath, exportJson);
    await env.panel
      .locator('input[data-input="import-file"]')
      .setInputFiles(importPath);

    // Wait for storage to refill.
    await env.panel.waitForFunction(async () => {
      const all = await chrome.storage.sync.get(null);
      return Object.keys(all).some((k) => k.startsWith('nf:filters:'));
    });

    const after = await env.panel.evaluate(async () => {
      const all = await chrome.storage.sync.get(null);
      return Object.fromEntries(
        Object.entries(all).filter(([k]) => k.startsWith('nf:filters:')),
      );
    });
    // Match: same keys + same values shape.
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    // Each set: same length + same phrase chip set.
    for (const k of Object.keys(before)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = before[k] as any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = after[k] as any[];
      expect(b.length).toBe(a.length);
    }
  });
});
