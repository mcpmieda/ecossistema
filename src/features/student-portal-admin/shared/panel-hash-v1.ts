/**
 * View state kept in the address (owner request 29/09/2026): with automatic reads paused the
 * administrator reloads by hand, so the chosen class or shift and an open student record come
 * back after a reload. Only identifiers of the ADM's own view; never a mark or a credential.
 */
export function readPanelHashParamV1(key: string): string | null {
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get(key);
}

/** Sets (string) or removes (null) the given keys; other keys, such as `area`, are kept. */
export function writePanelHashParamsV1(values: Record<string, string | null>) {
  const [path, query = ''] = window.location.hash.split('?');
  const params = new URLSearchParams(query);
  for (const [key, value] of Object.entries(values))
    if (value === null) params.delete(key);
    else params.set(key, value);
  const next = `${path}?${params.toString()}`;
  // replaceState: no hashchange event and no history entry per click.
  if (next !== window.location.hash) window.history.replaceState(window.history.state, '', next);
}

const ACCOUNT_ID_V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function panelHashAccountIdV1(key: string): string | null {
  const value = readPanelHashParamV1(key);
  return value && ACCOUNT_ID_V1.test(value) ? value.toLowerCase() : null;
}

const PANEL_OWNER_KEY_V1 = 'pa-panel-owner-v1';
const PANEL_KEYS_V1 = ['turma', 'turno', 'ficha', 'aluno'] as const;
/** Short fingerprint only, so the per-tab marker never holds the identity key itself. */
function fingerprintV1(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1)
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0; // NOSONAR: UTF-16 code units on purpose, so the stored hash stays the same
  return (hash >>> 0).toString(36);
}
/**
 * The restored view belongs to the administrator who left it: another identity in the same tab
 * starts clean. Storage failures (private mode) simply start clean as well.
 */
export function claimPanelHashV1(identityKey: string) {
  const owner = fingerprintV1(identityKey);
  let previous: string | null;
  try {
    previous = window.sessionStorage.getItem(PANEL_OWNER_KEY_V1);
    window.sessionStorage.setItem(PANEL_OWNER_KEY_V1, owner);
  } catch {
    previous = null;
  }
  if (previous !== owner)
    writePanelHashParamsV1(Object.fromEntries(PANEL_KEYS_V1.map((key) => [key, null])));
}

const PANEL_FIRST_ROWS_KEY_V1 = 'pa-first-rows-v1';
/**
 * The accounts on the first rows of a list, kept for this tab like the view in the address: after
 * a reload their photos are asked for while the list is still being read. Identifiers only, never
 * a name or an image, and only for the administrator and the view that left them.
 */
export function readPanelFirstRowsV1(view: string, limit: number): string[] {
  try {
    const saved: unknown = JSON.parse(
      window.sessionStorage.getItem(PANEL_FIRST_ROWS_KEY_V1) ?? 'null',
    );
    if (typeof saved !== 'object' || saved === null) return [];
    const { view: owner, accountIds } = saved as { view?: unknown; accountIds?: unknown };
    if (owner !== fingerprintV1(view) || !Array.isArray(accountIds)) return [];
    return accountIds
      .filter((id): id is string => typeof id === 'string' && ACCOUNT_ID_V1.test(id))
      .slice(0, limit)
      .map((id) => id.toLowerCase());
  } catch {
    return [];
  }
}
export function writePanelFirstRowsV1(view: string, accountIds: readonly string[]) {
  try {
    window.sessionStorage.setItem(
      PANEL_FIRST_ROWS_KEY_V1,
      JSON.stringify({ view: fingerprintV1(view), accountIds }),
    );
  } catch {
    // Storage unavailable (private mode): nothing is kept and the list asks as it arrives.
  }
}
