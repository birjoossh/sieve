import { defineConfig } from '@playwright/test';

// MV3 extensions can only be loaded into a persistent Chromium context, and the
// new headless mode (Playwright ≥1.49 default) is what makes that work without
// a visible browser. Per-test we launch with --load-extension; this config just
// sets the project-wide defaults.
export default defineConfig({
  testDir: 'tests',
  fullyParallel: false, // extension tests share a user-data dir per spec
  // Workers > 1 caused parallel full-extension specs to contend for
  // Chromium spawns / tmpdirs and intermittently fail (1.8 and 3.4
  // tipped this over once 3.4's full-ext spec landed). Sequential is
  // ~30s slower but reliably green; the project already opts out of
  // parallelism within a file via `fullyParallel: false`.
  workers: 1,
  // Full-extension specs occasionally lose to slow chromium spawn (we
  // saw 2.7 flake while passing in isolation, and a 21-min suite run
  // where ~25 chromium starts compounded). retries:1 absorbs that;
  // logic regressions still fail after both attempts. Don't ratchet
  // higher — masking real failures with retries is worse than slow.
  retries: 1,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    trace: 'retain-on-failure',
  },
});
