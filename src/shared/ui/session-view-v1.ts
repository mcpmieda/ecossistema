/*
 * What the operator had chosen on a screen (a class, a period, a tab), kept for this browser
 * tab so a reload returns to the same view, and saved to the person's account so another
 * session, on any computer, opens on the same view (owner request of 12/11/2026). Only
 * identifiers of choices are kept, never names, marks or any other academic data, and the
 * screen revalidates them against what it reads.
 */
import {
  VIEW_PREFERENCE_KEY_PATTERN_V1,
  VIEW_PREFERENCE_MAX_VALUE_CHARS_V1,
  viewPreferencesResponseSchemaV1,
} from '../../../shared/gradebook-contracts/settings/view-preferences-v1';

const PREFIX_V1 = 'ecossistema-view-v1:';
const OWNER_KEY_V1 = 'ecossistema-view-owner-v1';
const ROUTE_V1 = '/api/gradebook/view-preferences';
const FLUSH_DELAY_MS_V1 = 800;
const LOAD_TIMEOUT_MS_V1 = 2500;

/** The last address of the Centro, restored when it opens without one. */
export const LAST_ADDRESS_KEY_V1 = 'platform-address';
const ADDRESS_PATTERN_V1 = /^#\/[a-z0-9-]{1,48}(?:\?[a-z0-9=&_.-]{0,120})?$/u;

let accountSync = false;
let listening = false;
let pending: Record<string, unknown> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function readSessionViewV1<T>(key: string, parse: (value: unknown) => T | null): T | null {
  try {
    const stored = window.sessionStorage.getItem(PREFIX_V1 + key);
    return stored === null ? null : parse(JSON.parse(stored) as unknown);
  } catch {
    // Blocked storage or a malformed entry: the screen simply opens on its defaults.
    return null;
  }
}

/** The stored view as a plain record, for screens that check each field themselves. */
export function readSessionRecordV1(key: string): Readonly<Record<string, unknown>> | null {
  return readSessionViewV1(key, (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null,
  );
}

export const storedIdV1 = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

function sendPending(keepalive = false): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  const views = pending;
  pending = {};
  if (Object.keys(views).length === 0) return;
  void fetch(ROUTE_V1, {
    method: 'PUT',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    keepalive,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ views }),
  }).catch(() => {
    // The account copy is a convenience; this tab still keeps the view.
  });
}

export function writeSessionViewV1(key: string, value: unknown): void {
  let text: string;
  try {
    text = JSON.stringify(value);
    window.sessionStorage.setItem(PREFIX_V1 + key, text);
  } catch {
    // Persistence is a convenience; the screen works without it.
    return;
  }
  if (!accountSync || !VIEW_PREFERENCE_KEY_PATTERN_V1.test(key)) return;
  if (text.length > VIEW_PREFERENCE_MAX_VALUE_CHARS_V1) return;
  pending[key] = value;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => sendPending(), FLUSH_DELAY_MS_V1);
}

function clearTabViews(): void {
  for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = window.sessionStorage.key(index);
    if (key?.startsWith(PREFIX_V1)) window.sessionStorage.removeItem(key);
  }
}

async function readAccountViews(): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS_V1);
  try {
    const response = await fetch(ROUTE_V1, {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const parsed = viewPreferencesResponseSchemaV1.safeParse(await response.json());
    return parsed.success && parsed.data.state === 'ready' ? parsed.data.views : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Called once the account is known and before any screen reads its view. A tab that changes
 * hands forgets the previous person's choices; the account's saved views fill what this tab
 * has not chosen yet; an address-less opening goes back to the last area used.
 */
export async function startAccountViewsV1(owner: string, openedWithoutAddress: boolean): Promise<void> {
  try {
    if (window.sessionStorage.getItem(OWNER_KEY_V1) !== owner) {
      clearTabViews();
      window.sessionStorage.setItem(OWNER_KEY_V1, owner);
    }
  } catch {
    // Without tab storage the account views still apply for this load.
  }
  const views = await readAccountViews();
  accountSync = true;
  if (views) {
    for (const [key, value] of Object.entries(views)) {
      try {
        if (window.sessionStorage.getItem(PREFIX_V1 + key) === null)
          window.sessionStorage.setItem(PREFIX_V1 + key, JSON.stringify(value));
      } catch {
        break;
      }
    }
    const address = views[LAST_ADDRESS_KEY_V1];
    if (openedWithoutAddress && typeof address === 'string' && ADDRESS_PATTERN_V1.test(address))
      window.history.replaceState(null, '', address);
  }
  if (listening) return;
  listening = true;
  window.addEventListener('pagehide', () => sendPending(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sendPending(true);
  });
}

/** Records the address the person is on, so the next opening returns to it. */
export function rememberAddressV1(hash: string): void {
  if (ADDRESS_PATTERN_V1.test(hash)) writeSessionViewV1(LAST_ADDRESS_KEY_V1, hash);
}
