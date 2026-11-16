/**
 * Joins a read already started by another request of this isolate, but never waits on it for longer
 * than `maxWaitMs`. In Workers and Pages Functions the I/O belongs to the
 * request that started it: when that request is cancelled, the promise never settles in the others
 * ("A hanging Promise was canceled"). Past the wait, the caller makes its own read instead.
 */
export async function joinFlightV1<T>(flight: Promise<T>, maxWaitMs: number, ownRead: () => Promise<T>): Promise<T> {
  const stale = Symbol('stale-flight');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      flight,
      new Promise<typeof stale>((resolve) => { timer = setTimeout(() => resolve(stale), Math.max(0, maxWaitMs)); }),
    ]);
    return result === stale ? ownRead() : (result as T);
  } finally {
    clearTimeout(timer);
  }
}
