/** A JSON object: not null and not an array. */
export function isPlainRecordV1(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
