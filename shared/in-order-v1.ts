/**
 * Runs one step after the other, never two at once. For work whose order is the point: migrations,
 * statements on a single database connection, a key derivation bounded in memory.
 * A failing step stops the sequence and rejects with its error.
 */
export async function inOrderV1<T>(
  items: Iterable<T>,
  step: (item: T) => Promise<unknown>,
): Promise<void> {
  let previous: Promise<unknown> = Promise.resolve();
  for (const item of items) previous = previous.then(() => step(item));
  await previous;
}
