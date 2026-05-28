// shared/deep-prefs.ts — preferences around the deep-scan flow.
//
// 5.6 ships one bit: has the user dismissed the first-use ToS modal?
// `storage.local` (per-device) — this isn't security-sensitive, but
// nothing about the deep-path opt-in should ride sync to other
// devices the user may want to keep light-touch.

const STORAGE_KEY = 'nf:deep-warning-dismissed';

export async function isDeepWarningDismissed(): Promise<boolean> {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  return r[STORAGE_KEY] === true;
}

export async function dismissDeepWarning(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: true });
}

export async function resetDeepWarning(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
