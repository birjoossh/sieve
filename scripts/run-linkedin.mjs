#!/usr/bin/env node
// scripts/run-linkedin.mjs — one-off: load the built extension, restore a
// LinkedIn session via li_at cookie, seed OpenRouter (OpenAI-compatible)
// as the LLM provider, then drive the panel through enable + re-discover
// on the user's jobs URL. Reports what the content script saw.
//
// Required env:
//   LI_AT                 LinkedIn auth cookie value
//   OPENROUTER_API_KEY    OpenRouter key (used as OpenAI-compatible)
// Optional env:
//   LINKEDIN_URL          target page (defaults to the recommended jobs URL)
//   OPENROUTER_MODEL      OpenRouter model slug (default: anthropic/claude-3.5-sonnet)
//   HEADFUL=1             show the browser window
//   HINT                  re-discover hint (default: "job cards in the main column")

import { chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');

const LI_AT = process.env['LI_AT'];
const OPENROUTER_API_KEY = process.env['OPENROUTER_API_KEY'];
const LINKEDIN_URL =
  process.env['LINKEDIN_URL'] ??
  'https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4419592663&discover=recommended&discoveryOrigin=JOBS_HOME_JYMBII';
const MODEL = process.env['OPENROUTER_MODEL'] ?? 'anthropic/claude-3.5-sonnet';
const HEADFUL = process.env['HEADFUL'] === '1';
const HINT = process.env['HINT'] ?? 'job cards in the main column';

if (!LI_AT) {
  console.error('LI_AT env var required (LinkedIn li_at cookie value).');
  process.exit(2);
}
if (!OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY env var required.');
  process.exit(2);
}
if (!existsSync(DIST)) {
  console.error(`dist/ missing — run \`npm run build\` first.`);
  process.exit(2);
}

const redact = (s) => s.replace(OPENROUTER_API_KEY, '«key»').replace(LI_AT, '«li_at»');
const log = (...a) => console.log(...a.map((x) => (typeof x === 'string' ? redact(x) : x)));

async function buildTestExtension() {
  const dir = await mkdtemp(join(tmpdir(), 'sieve-linkedin-ext-'));
  await cp(DIST, dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Promote <all_urls> from optional → required so the user-gesture
  // permission prompt no-ops (same trick the 0.6 spec uses).
  manifest['host_permissions'] = ['<all_urls>'];
  delete manifest['optional_host_permissions'];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

async function main() {
  const extDir = await buildTestExtension();
  const userDataDir = await mkdtemp(join(tmpdir(), 'sieve-linkedin-ud-'));
  log(`ext dir:  ${extDir}`);
  log(`user dir: ${userDataDir}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !HEADFUL,
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-sandbox',
    ],
    viewport: { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  });

  // li_at cookie — domain wildcard so both www and m subdomains work.
  await context.addCookies([
    {
      name: 'li_at',
      value: LI_AT,
      domain: '.linkedin.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
    },
  ]);

  const sw =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  log(`extension id: ${extId}`);

  // Open LinkedIn first so it's the active tab when the panel queries.
  const target = await context.newPage();

  // Collect sieve console lines from the LinkedIn page.
  const contentLog = [];
  target.on('console', (m) => {
    const text = m.text();
    if (text.includes('[sieve]') || text.toLowerCase().includes('error')) {
      contentLog.push(`[target.${m.type()}] ${text}`);
    }
  });

  log(`navigating to ${LINKEDIN_URL}`);
  await target.goto(LINKEDIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Let LinkedIn finish its hydration churn.
  await target.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {
    log('networkidle never settled (linkedin keeps polling) — proceeding anyway');
  });

  // Auth sanity: log the final URL — if it's /login or /authwall the cookie didn't take.
  log(`landed on: ${target.url()}`);
  if (/\/(login|authwall|checkpoint)/.test(target.url())) {
    log('AUTH FAILED — cookie did not restore session. Aborting before LLM call.');
    await target.screenshot({ path: resolve(ROOT, 'out', 'linkedin-auth-fail.png') });
    await context.close();
    process.exit(3);
  }

  // Open the panel tab.
  const panel = await context.newPage();
  panel.on('console', (m) => {
    const text = m.text();
    if (text.includes('[sieve]') || text.toLowerCase().includes('error')) {
      contentLog.push(`[panel.${m.type()}] ${text}`);
    }
  });
  await panel.goto(`chrome-extension://${extId}/panel.html`);

  // Seed LLM settings (OpenRouter via OpenAI-compatible adapter).
  await panel.evaluate(
    async ({ key, base, model }) => {
      await chrome.storage.local.set({
        'nf:llm-settings': {
          provider: 'openai',
          apiKey: key,
          baseUrl: base,
          model,
        },
      });
    },
    { key: OPENROUTER_API_KEY, base: 'https://openrouter.ai/api', model: MODEL },
  );
  log(`seeded LLM settings: provider=openai (via OpenRouter), model=${MODEL}`);

  // Bring LinkedIn back to front so tabs.query({active,lastFocusedWindow}) → LinkedIn.
  await target.bringToFront();
  // Force the panel to refresh its active-tab probe.
  await panel.bringToFront();
  await target.bringToFront();

  // Wait for the Enable button to render with the linkedin origin.
  log('waiting for Enable button to show linkedin.com origin…');
  await panel
    .waitForFunction(
      () => {
        const b = document.querySelector('button[data-action="enable-site"]');
        return b && /linkedin\.com/.test(b.textContent ?? '');
      },
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => log('Enable button never bound to linkedin origin — see screenshot'));

  await panel.screenshot({ path: resolve(ROOT, 'out', 'panel-before-enable.png') });

  // Click Enable.
  const enableBtn = await panel.$('button[data-action="enable-site"]');
  if (enableBtn) {
    await enableBtn.click();
    log('clicked Enable');
  } else {
    log('no Enable button found in panel — aborting');
    await context.close();
    process.exit(4);
  }

  // After enable, the content script needs the tab to reload to inject.
  await target.bringToFront();
  await target.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await target.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

  // Give discovery (cache miss → LLM call) up to 60s.
  log('waiting for discovery (cache miss → LLM call, up to 60s)…');
  const discovered = await panel
    .waitForFunction(
      () => {
        const mode = document.querySelector('[data-role="display-mode"]');
        const err = document.querySelector('#error-panel [data-error]');
        return { ok: !!mode, errKind: err?.getAttribute('data-error') ?? null };
      },
      undefined,
      { timeout: 60_000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => ({ ok: false, errKind: 'timeout' }));

  log(`first discovery outcome: ${JSON.stringify(discovered)}`);

  // If nothing detected, try Re-discover with the hint.
  if (!discovered.ok) {
    log(`firing Re-discover with hint: "${HINT}"`);
    const hintInput = await panel.$('[data-input="rediscover-hint"]');
    if (hintInput) {
      await hintInput.fill(HINT);
    } else {
      log('no hint input visible — panel may not have rendered rediscover row');
    }
    const rediscoverBtn = await panel.$('[data-action="rediscover"]');
    if (rediscoverBtn) {
      await rediscoverBtn.click();
      log('clicked Re-discover');
      const second = await panel
        .waitForFunction(
          () => {
            const mode = document.querySelector('[data-role="display-mode"]');
            const err = document.querySelector('#error-panel [data-error]');
            return { ok: !!mode, errKind: err?.getAttribute('data-error') ?? null };
          },
          undefined,
          { timeout: 60_000 },
        )
        .then((h) => h.jsonValue())
        .catch(() => ({ ok: false, errKind: 'timeout' }));
      log(`re-discover outcome: ${JSON.stringify(second)}`);
    } else {
      log('no Re-discover button visible');
    }
  }

  // Capture final panel state.
  const panelState = await panel.evaluate(() => {
    const txt = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
    const errors = Array.from(
      document.querySelectorAll('#error-panel [data-error]'),
    ).map((el) => ({
      kind: el.getAttribute('data-error'),
      text: el.textContent?.trim() ?? '',
    }));
    return {
      pageStatus: txt('#page-status'),
      filterListBlurb: txt('#filter-list'),
      hiddenSection: txt('#hidden-section'),
      errors,
    };
  });
  log('panel state:');
  log(JSON.stringify(panelState, null, 2));

  // If discovery worked, exercise the filter end-to-end so we know the
  // engine actually pins LinkedIn's cards. Type a phrase, hit Add, then
  // count `.filt` wrappers on the LinkedIn tab.
  const phrase = process.env['FILTER_PHRASE'] ?? 'senior';
  if (panelState.errors.length === 0) {
    log(`exercising filter with phrase: "${phrase}"`);
    const phraseInput = await panel.$(
      'input[type="text"], input[data-input="phrase"], input:not([type])',
    );
    if (phraseInput) {
      await phraseInput.fill(phrase);
      const addBtn = await panel.$('button[data-action="add-phrase"], button:has-text("Add")');
      if (addBtn) {
        await addBtn.click();
        log('clicked Add');
        await target.bringToFront();
        await target.waitForTimeout(1500);
        const counts = await target.evaluate(() => {
          const total = document.querySelectorAll(
            'li.scaffold-layout__list-item, li[data-occludable-job-id]',
          ).length;
          const filtered = document.querySelectorAll('.filt').length;
          const slivers = document.querySelectorAll('.sliver').length;
          return { total, filtered, slivers };
        });
        log(`filter counts: ${JSON.stringify(counts)}`);
      } else {
        log('no Add button found');
      }
    } else {
      log('no phrase input found');
    }
  }

  await panel.screenshot({ path: resolve(ROOT, 'out', 'panel-final.png') });
  await target.screenshot({ path: resolve(ROOT, 'out', 'linkedin-final.png') });

  log('--- console (filtered) ---');
  for (const line of contentLog.slice(-80)) log(line);

  log('done. Screenshots in out/. Close the window or Ctrl+C to exit.');
  if (HEADFUL) {
    // Keep the window open so the user can inspect.
    await new Promise((r) => setTimeout(r, 1000 * 60 * 5));
  }
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(extDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
