# Sieve — Privacy Policy

_Last updated: 2026-05-25_

Sieve is an open-source Chrome extension that hides items on
the pages you visit. It is designed to keep your data on your device.

## Data we store on your device

The extension uses Chrome's storage APIs. Everything stored is keyed
locally to your browser profile. Specific keys:

- `nf:llm-settings` (`chrome.storage.local`) — your chosen LLM
  provider name, optional model override, and the API key you typed
  in. The key is **never transmitted to the developers** and never
  written to `chrome.storage.sync`.
- `nf:filters:<fingerprint>` (`chrome.storage.sync`) — your saved
  filter sets, indexed by a structural fingerprint of the page
  layout. Synced across your Chrome devices by Google.
- `nf:spend-ledger` (`chrome.storage.local`) — call-count meter for
  the LLM cap (per day, per month). No timestamps, no content.
- `nf:deep-warning-dismissed` (`chrome.storage.local`) — a single
  boolean recording that you dismissed the deep-scan ToS modal.
- `nf:deep-queue` (`chrome.storage.local`) — pending deep-scan
  items: `(fingerprint, itemUrl, status, attempts)`. Cleared when
  the scan completes.

## Data that leaves your device

There are two outbound destinations, both initiated by you:

1. **Your chosen LLM provider** (Anthropic or OpenAI) — only when you
   either (a) click Re-discover, or (b) click ✦ Suggest. The request
   payload is a structure-only, content-redacted skeleton of the
   page (`distill()` in `background/llm.ts`) plus, for suggestions,
   the literal phrases you've already typed. Page text, URLs, ARIA
   labels, and personal identifiers in the DOM are replaced with `…`
   before transmission. **No telemetry; no analytics; no data goes
   to Anthropic / the extension developer.**

2. **Detail pages on the site you're filtering** — only when you
   enable Deep Scan for a filter. The extension opens a hidden tab
   on the same origin (using a permission you grant) and reads the
   schema's `detailFieldSelectors` from the resulting page. No
   request leaves the origin you're already browsing.

We send nothing else. We do not collect analytics. We do not embed
third-party scripts.

## Permissions

- `sidePanel` — for the side panel UI.
- `tabs` — to display the active tab's origin in the panel.
- `scripting` — to register the content script on origins you enable.
- `alarms` — heartbeat for the deep-scan queue.
- `storage` — for the keys listed above.
- `optional_host_permissions: ["<all_urls>"]` — granted **only** for
  origins you explicitly enable. The extension never auto-injects
  into pages you haven't opted in to.

## Data we never collect

Anonymized usage stats, page content, browsing history, cookies,
passwords, form submissions, anything from origins you have not
enabled.

## Open source

Source is at [TODO insert repo URL]. PRs welcome.

## Contact

Issues / questions: [TODO insert email or issue tracker].
