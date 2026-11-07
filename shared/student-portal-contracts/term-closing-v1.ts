import { z } from 'zod';
import { TERM_CLOSING_CATALOG_V1 } from './term-closing-catalog-v1';

/*
 * Fechamento do trimestre (#1132). Spec: docs/student-portal/TRIMESTER_CLOSING_SPEC.md.
 * The server emits only message codes and variant indices; this catalog is the single source of
 * wording for the student page and the admin preview. The school approved it on 2026-09-23 (D6); the
 * feature stays behind the `showTermClosing` policy (off by default), which the school turns on.
 * R1: phrases never carry numbers, ranges or activity names; only `{disciplina}`, `{lista}` and
 * `{trimestre}` placeholders are filled at render time.
 */
export { TERM_CLOSING_CATALOG_V1 };

export type TermClosingCodeV1 = keyof typeof TERM_CLOSING_CATALOG_V1;
const codes = Object.keys(TERM_CLOSING_CATALOG_V1) as [TermClosingCodeV1, ...TermClosingCodeV1[]];
const termClosingCodeV1 = z.enum(codes);
export const TERM_CLOSING_PERIODS_V1 = ['T1', 'T2', 'T3'] as const;
export type TermClosingPeriodV1 = (typeof TERM_CLOSING_PERIODS_V1)[number];
/** `conclusion`: closed trimesters, past tense. `progress`: the trimester in progress. */
export const TERM_CLOSING_MODES_V1 = ['conclusion', 'progress'] as const;
export type TermClosingModeV1 = (typeof TERM_CLOSING_MODES_V1)[number];
/** Message kind regardless of mode: `progress.weight.x` and `weight.x` are both a weight. */
const termClosingKindV1 = (code: string) => code.replace(/^progress\./u, '').split('.')[0]!;
const modeOfCodeV1 = (code: string): TermClosingModeV1 => (code.startsWith('progress.') ? 'progress' : 'conclusion');

export const termClosingMessageV1 = z
  .object({ code: termClosingCodeV1, variant: z.number().int().nonnegative() })
  .strict()
  .refine((value) => value.variant < TERM_CLOSING_CATALOG_V1[value.code].length, 'Unknown variant');
export type TermClosingMessageV1 = z.infer<typeof termClosingMessageV1>;

const prefixed = (kind: string) =>
  termClosingMessageV1.refine((value) => termClosingKindV1(value.code) === kind, 'Unexpected message kind');

/** One trimester reading of one subject. `good` carries only the recognition line (D5). */
export const termClosingV1 = z
  .object({
    period: z.enum(TERM_CLOSING_PERIODS_V1),
    mode: z.enum(TERM_CLOSING_MODES_V1),
    level: z.enum(['attention', 'point', 'good']),
    conclusion: termClosingMessageV1.refine(
      (value) => ['conclusion', 'line'].includes(termClosingKindV1(value.code)),
      'Unexpected conclusion',
    ),
    weight: prefixed('weight').optional(),
    strength: prefixed('strength').optional(),
    action: prefixed('action').optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.level === 'good'
        ? termClosingKindV1(value.conclusion.code) === 'line' && !value.weight && !value.strength && !value.action
        : termClosingKindV1(value.conclusion.code) === 'conclusion' && value.weight !== undefined,
    'Closing pieces do not match its level',
  )
  .refine(
    (value) =>
      [value.conclusion, value.weight, value.strength, value.action].every(
        (message) => !message || modeOfCodeV1(message.code) === value.mode,
      ),
    'Messages must match the closing mode',
  );
export type TermClosingV1 = z.infer<typeof termClosingV1>;

/** Boletim summary of the most recent closed trimester (D4, D11). */
export const termClosingSummaryV1 = z
  .object({
    period: z.enum(TERM_CLOSING_PERIODS_V1),
    mode: z.enum(TERM_CLOSING_MODES_V1),
    message: prefixed('summary'),
    attentionSubjectIds: z.array(z.number().int().positive()).max(100),
  })
  .strict();
export type TermClosingSummaryV1 = z.infer<typeof termClosingSummaryV1>;

const ORDINAL_V1: Record<TermClosingPeriodV1, string> = { T1: '1º', T2: '2º', T3: '3º' };
/** "Fechamento do 1º trimestre" (D10), or "Acompanhamento do 2º trimestre" in progress mode. */
export const termClosingLabelV1 = (period: TermClosingPeriodV1, mode: TermClosingModeV1 = 'conclusion') =>
  // "Relatório" matches the admin tab name (Relatório de notas, 27/09/2026).
  `${mode === 'progress' ? 'Acompanhamento' : 'Relatório'} do ${ORDINAL_V1[period]} trimestre`;

/** Subject labels arrive upper-case from the BN; sentences use only the first letter capitalized. */
export function subjectSentenceLabelV1(label: string): string {
  return label
    .toLocaleLowerCase('pt-BR')
    .replace(/(^|[\s./-])(\p{L})/gu, (_match, lead: string, letter: string) => lead + letter.toLocaleUpperCase('pt-BR'));
}

function joinListV1(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} e ${items.at(-1)}`;
}

/** Renders one message; the only inputs are catalog text, the trimester and subject names. */
export function renderTermClosingMessageV1(
  message: TermClosingMessageV1,
  context: { period: TermClosingPeriodV1; subjects?: readonly string[] },
): string {
  const text: string = TERM_CLOSING_CATALOG_V1[message.code][message.variant] ?? '';
  const list = (context.subjects ?? []).map(subjectSentenceLabelV1);
  const plural = list.length > 1;
  return text
    .replaceAll('{trimestre}', `${ORDINAL_V1[context.period]} trimestre`)
    .replaceAll('{lista}', joinListV1(list))
    .replaceAll('{pede}', plural ? 'pedem' : 'pede')
    .replaceAll('{merece}', plural ? 'merecem' : 'merece')
    .replace(/^([a-zà-ú])/u, (letter) => letter.toLocaleUpperCase('pt-BR'));
}
