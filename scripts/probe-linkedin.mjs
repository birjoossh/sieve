#!/usr/bin/env node
// scripts/probe-linkedin.mjs — one-shot probe of detect/fingerprint
// against linkedin.com/jobs/. Not a permanent test; meant to be run
// by hand to debug the discover pipeline on real sites.

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTBED = resolve(__dirname, '..', 'dist', 'testbed', 'runtime.js');

const URL = process.argv[2] ?? 'https://www.linkedin.com/jobs/';
const HEADLESS = process.env.HEADLESS !== '0';

const browser = await chromium.launch({
  headless: HEADLESS,
  channel: 'chromium',
});
try {
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  page.on('console', (m) => console.log(`[page ${m.type()}]`, m.text()));

  console.log(`navigating to ${URL}…`);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  console.log('waiting 6s for SPA hydrate…');
  await page.waitForTimeout(6_000);

  // Dump the URL after redirects, the title, the body's first-class
  // structure summary.
  const info = await page.evaluate(() => {
    const summary = (root) => {
      const out = [];
      const stack = [{ el: root, depth: 0 }];
      while (stack.length && out.length < 80) {
        const { el, depth } = stack.shift();
        const cls = Array.from(el.classList).slice(0, 5).join('.');
        const tag = el.tagName.toLowerCase();
        const children = el.children?.length ?? 0;
        out.push(`${' '.repeat(depth)}${tag}${cls ? '.' + cls : ''} (${children} children)`);
        if (depth < 5) {
          for (const c of Array.from(el.children).slice(0, 5)) {
            stack.push({ el: c, depth: depth + 1 });
          }
        }
      }
      return out.join('\n');
    };
    return {
      url: window.location.href,
      title: document.title,
      bodyClass: document.body.className.slice(0, 200),
      summary: summary(document.body),
    };
  });
  console.log('--- page info ---');
  console.log('URL after redirects :', info.url);
  console.log('Title               :', info.title);
  console.log('Body class          :', info.bodyClass);
  console.log('--- body summary ---');
  console.log(info.summary);

  console.log('\nloading testbed via evaluate (CSP-friendly)…');
  // page.evaluate(source) bypasses CSP because it goes through CDP's
  // Runtime.evaluate, not via <script>. addScriptTag injects an
  // inline element which LinkedIn's CSP rejects.
  const testbedSource = readFileSync(TESTBED, 'utf8');
  await page.evaluate(testbedSource);

  const probe = await page.evaluate(() => {
    const nf = (window).__nf;
    const detected = nf.detect(document);
    if (!detected) return { detected: null };
    const layout = nf.classify(detected);
    const fp = nf.fingerprintItemSet(detected);
    return {
      tag: detected.tagName.toLowerCase(),
      classList: Array.from(detected.classList),
      childCount: detected.children.length,
      layout,
      fingerprint: fp,
      firstChild: detected.firstElementChild?.tagName.toLowerCase() ?? null,
      firstChildClass: Array.from(detected.firstElementChild?.classList ?? []).slice(0, 6),
    };
  });
  console.log('\n--- detect/fingerprint result ---');
  console.log(JSON.stringify(probe, null, 2));

  if (!HEADLESS) {
    console.log('\n[HEADLESS=0] sleeping 30s so you can inspect…');
    await page.waitForTimeout(30_000);
  }
} finally {
  await browser.close();
}
