# Chrome Web Store Submission — Negative Filter

A step-by-step guide to publishing **Negative Filter** to the Chrome Web Store,
plus the pre-submission readiness audit (technical, branding, narrative).

_Last reviewed: 2026-06-13 · manifest version `0.1.0`_

---

## 1. Readiness verdict

**Technically ready to submit.** The build passes every Chrome Web Store
hard requirement; the items below are the only things to confirm before you
click "Submit for review."

### Must do before submitting

- [ ] **Make the GitHub repo public.** The privacy policy URL the store
      requires points at `https://github.com/birjoossh/sieve/blob/main/PRIVACY.md`.
      The store form rejects an unreachable privacy URL — open the repo (or host
      `PRIVACY.md` somewhere public) and confirm the link resolves in an
      incognito window.
- [ ] **Verify the developer-account contact email** in the dashboard
      (Account → Contact email), and complete email verification. Required.
- [ ] **Pay the one-time $5 developer registration fee** if this account hasn't
      published before.
- [ ] **Re-run `npm run package`** and upload the fresh `out/sieve-0.1.0.zip`
      (a panel-title branding fix landed 2026-06-13; the committed zip is current
      but rebuild to be safe).

### Optional before a 1.0 public launch

- [ ] Consider bumping `version` `0.1.0` → `1.0.0` in
      `extension/manifest.json` for a public debut (cosmetic; `0.1.0` is
      accepted).
- [ ] Decide whether to rename the `sieve-export-*.json` download and unify the
      `[sieve]` / `[negative-filter]` console prefixes — see §3. Cosmetic only.

---

## 2. Technical audit (all green)

| Check | Status | Notes |
|---|---|---|
| Manifest V3 | ✅ | `manifest_version: 3`, service-worker background, side panel |
| Required icons | ✅ | 16 / 32 / 48 / 128 px all present and exact-sized |
| No remote code | ✅ | No `eval`, `new Function`, `importScripts`, remote `<script>`. The only `innerHTML` reference is a comment forbidding it; panel renders page-derived text via `textContent` |
| External hosts | ✅ | Only `api.anthropic.com`, `api.openai.com` (user-key LLM calls) and `www.linkedin.com` (same-origin description fetch). All reached via runtime-granted host permissions, none at install |
| Permissions minimal | ✅ | `sidePanel`, `tabs`, `scripting`, `alarms`, `storage` — each justified (§4). No `<all_urls>` at install; host access is `optional_host_permissions`, granted per-site at a user gesture |
| Privacy posture | ✅ | Local-first; BYO LLM key; only a redacted, content-free DOM skeleton leaves the browser; per-day/-month spend cap; `PRIVACY.md` present |
| Package hygiene | ✅ | `out/sieve-0.1.0.zip` = 11 files; test-only `testbed/` and `*.js.map` excluded by `scripts/package.mjs` |
| Store assets | ✅ | 3 screenshots @ 1280×800, small tile @ 440×280, marquee @ 1400×560, 128 px store icon — all correct dimensions, all committed under `out/store-assets/` |
| Test suite | ✅ | 157 passing, 1 skipped (env-gated live LinkedIn spec) |

---

## 3. Branding / consistency / narrative findings

**Product name is "Negative Filter"; "sieve" is the internal codename** (repo
slug + zip artifact name). That split is intentional, but a few user-facing
leaks existed:

| Item | Where | Severity | Action |
|---|---|---|---|
| Panel tab title was `Sieve` | `extension/panel/panel.html` `<title>` | User-facing | **Fixed** → `Negative Filter` |
| `tabs` justification omitted SPA-nav use | `out/store-assets/listing.txt` | Consistency w/ PRIVACY.md | **Fixed** (now lists both uses) |
| Export download named `sieve-export-*.json` | `panel.ts` | Cosmetic (user sees filename) | Left as-is; rename to `negative-filter-export-*` if desired |
| Mixed console prefixes `[sieve]` (11×) / `[negative-filter]` (3×) | content/panel/sw | Cosmetic (devtools only) | Left as-is; unify if desired |
| Repo/privacy URLs use `…/sieve` | README, PRIVACY, listing | Intentional | Keep — just ensure the repo is public (§1) |

**Narrative — consistent and strong.** The "say what you *don't* want, once,
and keep it out of view everywhere" framing is uniform across `README.md`, the
store `listing.txt`, and `PRIVACY.md`. The privacy story (local-first, BYO key,
redacted payloads, no analytics) is the same in all three. Header `<h1>` in the
panel correctly reads "Negative Filter". Minor voice nit (non-blocking): the
manifest `description` ("Hide items that fail your filters…") is slightly more
mechanical than the listing/README lead ("Hide what you don't want to see") —
fine to leave, or align the manifest to the warmer line.

---

## 4. Step-by-step posting guide

### Step 0 — One-time account setup
1. Go to the **Chrome Web Store Developer Dashboard**:
   <https://chrome.google.com/webstore/devconsole>.
2. Sign in with the Google account that will own the listing.
3. Pay the **one-time $5 registration fee** (first publish only).
4. Under **Account**, set and **verify the contact email** (publishing is
   blocked until verified).

### Step 1 — Build the upload artifact
```bash
npm run typecheck      # sanity: must be clean
npm test               # full Playwright suite — must be green
npm run package        # → out/sieve-0.1.0.zip  (build + zip)
```
The zip must contain only the runtime files (no `testbed/`, no `.map`) — the
package script already enforces this. Confirm with `unzip -l out/sieve-0.1.0.zip`.

### Step 2 — Create the listing
1. Dashboard → **Items** → **+ New item**.
2. **Upload** `out/sieve-0.1.0.zip`. Wait for the manifest to parse with no
   errors.

### Step 3 — Store listing tab
Copy from `out/store-assets/listing.txt`:
- **Name:** `Negative Filter`
- **Summary** (≤132 chars): the one-liner in `listing.txt`.
- **Description:** the long body in `listing.txt`.
- **Category:** Productivity.
- **Language:** English.
- **Store icon:** `extension/icons/icon128.png` (128×128).
- **Screenshots** (1280×800, upload in this order):
  1. `out/store-assets/panel-hero-1280x800.png`
  2. `out/store-assets/hn-filtered-1280x800.png`
  3. `out/store-assets/github-filtered-1280x800.png`
- **Small promo tile:** `out/store-assets/tile-small-440x280.png`
- **Marquee promo tile:** `out/store-assets/marquee-1400x560.png`

### Step 4 — Privacy practices tab
1. **Single purpose** — paste the single-purpose statement from `listing.txt`.
2. **Permission justifications** — paste the per-permission notes from
   `listing.txt` §"Permissions justification" (covers `sidePanel`, `tabs`,
   `scripting`, `storage`, `alarms`, and the `<all_urls>` optional host
   permission).
3. **Data usage** — declare **"Website content"** only; purpose **app
   functionality**; **not sold**, **not shared** with third parties beyond the
   user's chosen LLM provider. Check **does NOT collect** for everything else
   (no analytics, no PII, no auth info). Full wording in `listing.txt`.
4. **Privacy policy URL** — the public `PRIVACY.md` URL (§1). Required.
5. Affirm you comply with the **Developer Program Policies**.

### Step 5 — Distribution
- **Visibility:** Public (or Unlisted for a soft launch).
- **Regions:** all, unless restricting.

### Step 6 — Submit
1. Click **Submit for review**.
2. Review typically takes a few hours to a few days. Extensions that request
   broad host access (even optional `<all_urls>`) can draw extra scrutiny — the
   single-purpose statement + per-site opt-in narrative is what clears it, so
   make sure Step 4 is filled in precisely.

### Step 7 — After approval
- The listing goes live automatically (Public) at a `chromewebstore.google.com`
  URL.
- Update `README.md`'s "From the Chrome Web Store" line with the live link.

---

## 5. Publishing an update later
1. Bump `version` in `extension/manifest.json` (Chrome requires a strictly
   higher version per upload).
2. `npm test && npm run package`.
3. Dashboard → the item → **Package** → upload the new zip → **Submit for
   review**. Listing copy and assets persist between versions; only re-edit
   what changed.

---

## 6. Quick reference — file map
- Build artifact: `out/sieve-<version>.zip` (via `npm run package`)
- Listing copy + review-form text: `out/store-assets/listing.txt`
- Screenshots / promo tiles: `out/store-assets/*.png`
- Store icon: `extension/icons/icon128.png`
- Privacy policy: `PRIVACY.md`
