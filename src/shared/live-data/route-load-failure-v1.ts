export type RouteLoadFailureV1 = 'module-load' | 'render';

/** Classify known browser module errors without copying messages, URLs or student data into logs. */
export function routeLoadFailureV1(error: unknown): RouteLoadFailureV1 {
  if (!(error instanceof Error)) return 'render';
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to load module script|Unable to preload CSS/iu.test(error.message)
    ? 'module-load'
    : 'render';
}

const STALE_MODULE_RELOAD_KEY = '__gradebookStaleModuleReloadAt';
const STALE_MODULE_RELOAD_WINDOW_MS = 60_000;

/** A module missing after a deploy reloads the page once a minute at most, never in a loop. */
export function shouldReloadFailedModuleV1(
  error: unknown,
  navigation: Pick<History, 'state' | 'replaceState'>,
  now: number,
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (
    !/Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
      message,
    )
  )
    return false;
  try {
    const previousState = navigation.state;
    const state: Record<string, unknown> =
      previousState && typeof previousState === 'object' && !Array.isArray(previousState)
        ? (previousState as Record<string, unknown>)
        : {};
    const last = Number(state[STALE_MODULE_RELOAD_KEY]);
    if (last > 0 && now - last >= 0 && now - last < STALE_MODULE_RELOAD_WINDOW_MS) return false;
    navigation.replaceState({ ...state, [STALE_MODULE_RELOAD_KEY]: now }, '');
    return true;
  } catch {
    return false;
  }
}
