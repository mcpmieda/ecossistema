/**
 * `String(value)` for a value read from outside (a database row, a spreadsheet cell, a request):
 * the same text for primitives, null, undefined and any object with its own `toString` (Date, URL,
 * arrays…); only a plain object becomes its JSON instead of "[object Object]" (Sonar S6551).
 */
export function scalarTextV1(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    value === null ||
    value === undefined ||
    (typeof value !== 'object' && typeof value !== 'function')
  )
    return String(value as string | number | bigint | boolean | symbol | null | undefined);
  const own = value as { toString(): string };
  if (own.toString !== Object.prototype.toString) return own.toString();
  return JSON.stringify(value) ?? '';
}
