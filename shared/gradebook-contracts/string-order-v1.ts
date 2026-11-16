/**
 * Stable order for opaque/canonical contract strings.
 *
 * This is deliberately locale-explicit so runtime/engine defaults cannot change
 * canonicalization, cache keys or structural equality checks.
 */
export function compareCanonicalStringsV1(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

/** Built once: `localeCompare` with options builds a collator on every comparison. */
const PT_BR_NUMERIC_COLLATOR_V1 = new Intl.Collator('pt-BR', { numeric: true });

/** Human-facing Portuguese labels with numeric segments (for example 1º, 2º, 10º). Same order as `left.localeCompare(right, 'pt-BR', { numeric: true })`. */
export function comparePtBrNumericLabelsV1(left: string, right: string): number {
  return PT_BR_NUMERIC_COLLATOR_V1.compare(left, right);
}
