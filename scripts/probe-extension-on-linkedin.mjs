#!/usr/bin/env node
// scripts/probe-extension-on-linkedin.mjs — load the real extension,
// enable linkedin.com, navigate to /jobs/search, and capture every
// extension-emitted log + the panel's reported state. Tells us what
// the live discover path actually does.
//
// Stubs out the LLM call by pre-seeding chrome.storage.local with a
// schema for the fingerprint detect() computes against the live page.

import { chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROD_DIST = resolve(__dirname, '..', 'dist');
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

const TARGET_URL = process.argv[2] ?? 'https://www.linkedin.com/jobs/search?keywords=software';

async function buildTestExtension() {
  const dir = await mkdtemp(join(tmpdir(), 'nf-ext-probe-'));
  await cp(PROD_DIST, dir, { recursive: true });
  const mp = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(mp, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  delete manifest.optional_host_permissions;
  await writeFile(mp, JSON.stringify(manifest, null, 2));
  return dir;
}

const extDir = await buildTestExtension();
const userDataDir = await mkdtemp(join(tmpdir(), 'nf-ud-probe-'));

const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false, // need a real Chromium for the extension
  channel: 'chromium',
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--no-sandbox',
  ],
  viewport: null,
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
console.log('extension id:', extId);

// Log everything from SW, content, panel.
sw.on('console', (m) => console.log(`[sw ${m.type()}]`, m.text()));

const captureLogs = (label, pg) => {
  pg.on('console', (m) => console.log(`[${label} ${m.type()}]`, m.text()));
  pg.on('pageerror', (e) => console.log(`[${label} pageerror]`, e.message));
};

// 1. Open LinkedIn search.
const fixture = await ctx.newPage();
captureLogs('fix', fixture);
console.log('navigating to', TARGET_URL);
await fixture.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
console.log('waiting 5s for hydrate…');
await fixture.waitForTimeout(5_000);

// 2. Compute the fingerprint via the testbed (inline-evaluate to dodge CSP).
const testbedSource = readFileSync(TESTBED, 'utf8');
await fixture.evaluate(testbedSource);
const detected = await fixture.evaluate(() => {
  const nf = window.__nf;
  const el = nf.detect(document);
  if (!el) return null;
  return {
    tag: el.tagName.toLowerCase(),
    classList: Array.from(el.classList).slice(0, 6),
    childCount: el.children.length,
    layout: nf.classify(el),
    fingerprint: nf.fingerprintItemSet(el),
  };
});
console.log('--- detect on live page ---');
console.log(JSON.stringify(detected, null, 2));

if (!detected) {
  console.log('!! detect returned null — root cause for "No list detected".');
  process.exit(0);
}

// 3. Pre-seed the schema cache + LLM key + open the panel.
const panel = await ctx.newPage();
captureLogs('pnl', panel);
await panel.goto(`chrome-extension://${extId}/panel.html`);
await panel.waitForTimeout(200);
await panel.evaluate(
  async ({ fp, itemSetSelector, itemSelector }) => {
    await chrome.storage.local.set({
      'nf:llm-settings': { provider: 'anthropic', apiKey: 'sk-stub' },
      [`nf:schema:${fp}`]: {
        fingerprint: fp,
        layout: 'list',
        itemSetSelector,
        itemSelector,
        fields: {
          title: { kind: 'text', selector: 'h3,h2,a' },
          snippet: { kind: 'text', selector: 'p,div' },
        },
        source: 'llm',
        discoveredAt: Date.now(),
      },
    });
  },
  {
    fp: detected.fingerprint,
    itemSetSelector: 'ul.jobs-search__results-list',
    itemSelector: 'ul.jobs-search__results-list > li',
  },
);
console.log('seeded schema cache + dummy LLM key.');

// 4. Enable the LinkedIn origin via the SW + reload the LinkedIn tab.
await sw.evaluate(async () => {
  // Same path the panel's Enable button drives in production.
  await chrome.scripting.registerContentScripts([
    {
      id: 'nf:https://www.linkedin.com',
      matches: ['https://www.linkedin.com/*'],
      js: ['content.js'],
      runAt: 'document_idle',
      world: 'ISOLATED',
    },
  ]).catch((e) => console.log('registerContentScripts:', e.message));
});
console.log('content script registered on linkedin.com. reloading fixture…');
await fixture.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
console.log('waiting 8s for content init + retries…');
await fixture.waitForTimeout(8_000);

// 5. Report panel state.
const reported = await panel.evaluate(async () => {
  // The panel's view of the active content tab depends on which tab
  // is in front. We don't ship to the panel's tab here; we just
  // read storage directly to see what's persisted + ask content
  // for its current state.
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  const tabId = tabs[0]?.id;
  if (!tabId) return { error: 'no linkedin tab found' };
  try {
    const reply = await chrome.tabs.sendMessage(tabId, {
      t: 'getState',
      v: 1,
    });
    return { reply };
  } catch (e) {
    return { error: String(e) };
  }
});
console.log('--- content getState ---');
console.log(JSON.stringify(reported, null, 2));

console.log('\nleaving the browser open for 60s — inspect by hand if needed.');
await new Promise((r) => setTimeout(r, 60_000));

await ctx.close();
rmSync(userDataDir, { recursive: true, force: true });
rmSync(extDir, { recursive: true, force: true });
