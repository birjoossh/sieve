#!/usr/bin/env node
// scripts/probe-linkedin-deep.mjs — extended probe. Waits longer for
// hydration, snapshots the DOM after networkidle, looks for ANY cluster of
// repeating elements that could be job cards (not just hand-picked
// selectors), and dumps detect()'s top-N candidates so we can see which
// cluster scored highest.

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
    viewport: { width: 1400, height: 900 },
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
  }
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (!t.includes('Allowlist') && !t.includes('voyager')) {
      // skip the noisy LinkedIn telemetry warnings
      console.log(`[page ${m.type()}]`, t.slice(0, 200));
    }
  });

  console.log(`navigating to ${URL}…`);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {
    console.log('(networkidle did not settle — proceeding)');
  });
  console.log('waiting 8s additional for SPA hydrate…');
  await page.waitForTimeout(8_000);

  console.log(`landed: ${page.url()}`);

  const testbedSource = readFileSync(TESTBED, 'utf8');
  await page.evaluate(testbedSource);

  const dump = await page.evaluate(() => {
    const nf = (window).__nf;
    const out = {};

    // 1. Top-level page state
    out.url = location.href;
    out.title = document.title;
    out.bodyClasses = document.body.className.slice(0, 200);
    out.totalElements = document.querySelectorAll('*').length;

    // 2. What detect() currently picks (using the production heuristic)
    const detected = nf.detect(document);
    if (detected) {
      out.detect = {
        tag: detected.tagName.toLowerCase(),
        classList: Array.from(detected.classList),
        childCount: detected.children.length,
        childrenSig: Array.from(detected.children).slice(0, 5).map((c) => ({
          tag: c.tagName.toLowerCase(),
          classes: Array.from(c.classList),
          descendants: c.getElementsByTagName('*').length,
          textSample: (c.textContent ?? '').trim().slice(0, 80),
        })),
      };
    } else {
      out.detect = null;
    }

    // 3. Look for ANY clusters of >=3 same-classlist siblings, sorted by
    //    score, regardless of class names. This shows what detect() COULD
    //    pick if it weren't fighting class-name drift.
    const sigOf = (el) => {
      const cls = Array.from(el.classList).sort().join('.');
      return cls ? `${el.tagName}.${cls}` : el.tagName;
    };
    const candidates = [];
    document.querySelectorAll('*').forEach((parent) => {
      const groups = new Map();
      for (const c of Array.from(parent.children)) {
        if (['SCRIPT','STYLE','LINK','META','NOSCRIPT','TEMPLATE','HEAD'].includes(c.tagName)) continue;
        const sig = sigOf(c);
        const list = groups.get(sig) ?? [];
        list.push(c);
        groups.set(sig, list);
      }
      for (const [sig, group] of groups) {
        if (group.length < 3) continue;
        let total = 0;
        for (const el of group) total += el.getElementsByTagName('*').length;
        const meanDescendants = total / group.length;
        const score = group.length * meanDescendants;
        // Sample text from first member to recognize the cluster
        const firstText = (group[0].textContent ?? '').trim().slice(0, 60);
        candidates.push({
          parentTag: parent.tagName.toLowerCase(),
          parentClasses: Array.from(parent.classList).slice(0, 4),
          sig,
          count: group.length,
          meanDescendants: Math.round(meanDescendants),
          score: Math.round(score),
          firstText,
        });
      }
    });
    candidates.sort((a, b) => b.score - a.score);
    out.topClusters = candidates.slice(0, 8);

    // 4. Look for elements containing job-card-like text. The user's
    //    screenshot showed "Vice President, AI Strategy & Transformation".
    //    See if that text exists in DOM at all.
    out.searches = {};
    for (const phrase of [
      'Vice President',
      'Top job picks',
      'Recent job searches',
      'Senior',
      'Strategy',
    ]) {
      const matches = [];
      // Walk all elements; collect first 3 that have this as their direct text
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n = walker.nextNode();
      while (n && matches.length < 3) {
        if ((n.textContent ?? '').includes(phrase)) {
          const el = n.parentElement;
          if (el) {
            // climb to the nearest "card-like" ancestor (an element with
            // siblings of the same tag)
            let ancestor = el;
            for (let i = 0; i < 6 && ancestor.parentElement; i++) {
              const p = ancestor.parentElement;
              const sameTagSiblings = Array.from(p.children).filter(
                (c) => c.tagName === ancestor.tagName,
              );
              if (sameTagSiblings.length >= 3) {
                matches.push({
                  ancestorTag: ancestor.tagName.toLowerCase(),
                  ancestorClasses: Array.from(ancestor.classList).slice(0, 4),
                  parentTag: p.tagName.toLowerCase(),
                  parentClasses: Array.from(p.classList).slice(0, 4),
                  sameTagSiblingCount: sameTagSiblings.length,
                });
                break;
              }
              ancestor = p;
            }
          }
        }
        n = walker.nextNode();
      }
      out.searches[phrase] = matches;
    }

    return out;
  });

  console.log('\n=== DEEP PROBE OUTPUT ===');
  console.log(JSON.stringify(dump, null, 2));
} finally {
  await browser.close();
}
