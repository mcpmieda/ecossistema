/**
 * Institutional labels transcribed from CONFIGURAÇÃO!H3:I16, inspected 2026-09-10.
 * Shared populated rows in the two inspected source templates agree; one template
 * additionally supplies COMPUTACAO/CT. Missing entries are not synthesized.
 * This catalogue is presentation metadata, never the identity of a subject.
 */
export const SOURCE_SUBJECT_PRESENTATION_V1 = Object.freeze([
  ['PORTUGUES', 'P'], ['MATEMATICA', 'M'], ['HISTORIA', 'H'], ['GEOGRAFIA', 'G'],
  ['CIENCIAS', 'C'], ['ARTE', 'A'], ['RELIGIAO', 'RL'], ['REDACAO', 'RD'],
  ['ED. FISICA', 'F'], ['ETICA', 'ET'], ['INGLES', 'I'], ['COMPUTACAO', 'CT'],
] as const);
const SOURCE_SUBJECT_ABBREVIATIONS_V1: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(SOURCE_SUBJECT_PRESENTATION_V1));
const SOURCE_SUBJECT_PRESENTATION_INDEX_V1 = new Map<string, number>(
  SOURCE_SUBJECT_PRESENTATION_V1.map(([name], index) => [name, index]));
function normalizeSourceSubjectNameV1(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').trim().replace(/\s+/gu, ' ').toUpperCase();
}
export function sourceSubjectPresentationOrderV1(name: string): number | null {
  return SOURCE_SUBJECT_PRESENTATION_INDEX_V1.get(normalizeSourceSubjectNameV1(name)) ?? null;
}
export function compareSourceSubjectPresentationV1(left: string, right: string): number {
  const leftIndex = sourceSubjectPresentationOrderV1(left);
  const rightIndex = sourceSubjectPresentationOrderV1(right);
  return (
    (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER) ||
    left.localeCompare(right, 'pt-BR')
  );
}
export function sourceSubjectAbbreviationV1(name: string): string | null {
  const key = normalizeSourceSubjectNameV1(name);
  return SOURCE_SUBJECT_ABBREVIATIONS_V1[key] ?? null;
}
