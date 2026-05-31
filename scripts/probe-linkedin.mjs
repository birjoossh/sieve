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
  if (process.env.LI_AT) {
    await ctx.addCookies([
      {
        name: 'li_at',
        value: process.env.LI_AT,
        domain: '.linkedin.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
      },
    ]);
    console.log('[auth] li_at cookie set');
  }
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
    // Walk up from a known job card to see the actual hierarchy.
    const card = document.querySelector('li.scaffold-layout__list-item, li[data-occludable-job-id]');
    const chain = [];
    let el = card;
    while (el && chain.length < 6) {
      chain.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: Array.from(el.classList).slice(0, 6),
      });
      el = el.parentElement;
    }
    return {
      tag: detected.tagName.toLowerCase(),
      classList: Array.from(detected.classList),
      childCount: detected.children.length,
      layout,
      fingerprint: fp,
      firstChild: detected.firstElementChild?.tagName.toLowerCase() ?? null,
      firstChildClass: Array.from(detected.firstElementChild?.classList ?? []).slice(0, 6),
      stableSelectorCounts: {
        '.scaffold-layout__list-container': document.querySelectorAll('.scaffold-layout__list-container').length,
        '.scaffold-layout__list': document.querySelectorAll('.scaffold-layout__list').length,
        'li.scaffold-layout__list-item': document.querySelectorAll('li.scaffold-layout__list-item').length,
        'li[data-occludable-job-id]': document.querySelectorAll('li[data-occludable-job-id]').length,
        'ul:has(> li[data-occludable-job-id])': document.querySelectorAll('ul:has(> li[data-occludable-job-id])').length,
        'ul.scaffold-layout__list-container': document.querySelectorAll('ul.scaffold-layout__list-container').length,
        '.jobs-search-results-list': document.querySelectorAll('.jobs-search-results-list').length,
      },
      // Sample text from the first card's stub-schema field selectors so we
      // can sanity-check filter matching offline.
      firstCardFieldSamples: (() => {
        const c = document.querySelector('li[data-occludable-job-id]');
        if (!c) return null;
        const txt = (sel) => c.querySelector(sel)?.textContent?.trim().slice(0, 120) ?? null;
        return {
          title: txt('.job-card-list__title, .artdeco-entity-lockup__title, a[aria-label]'),
          company: txt('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle'),
          location: txt('.job-card-container__metadata-wrapper, .job-card-container__metadata-item, .artdeco-entity-lockup__caption'),
          snippet: (c.textContent ?? '').trim().slice(0, 160),
        };
      })(),
      cardChainUp: chain,
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
