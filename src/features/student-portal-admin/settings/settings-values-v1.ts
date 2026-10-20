import type { z } from 'zod';
import {
  policyScopeV1,
  SHIFT_LABELS_V1,
  type PolicyScopeV1,
} from '../../../../shared/student-portal-contracts/core-v1';
import {
  calendarV1,
  settingsOverrideV1,
  type EffectiveSettingsV1,
} from '../../../../shared/student-portal-contracts/policy-v1';

export type SettingsFieldV1 = keyof EffectiveSettingsV1['value'];
export type CalendarV1 = z.infer<typeof calendarV1>;
export const SETTINGS_LABELS_V1: Record<SettingsFieldV1, string> = {
  accessEnabled: 'Acesso ao Portal',
  accessSchedule: 'Agendamentos de acesso',
  showPartials: 'Notas de cada atividade',
  autoUpdate: 'Publicar notas novas sozinho',
  showFinalResult: 'Resultado anual',
  showTermClosing: 'Fechamento do trimestre',
  termClosingConclusive: 'Tipo de orientação',
  showFrequency: 'Frequência no Portal',
  allowedPeriods: 'Períodos permitidos',
  risk: 'Segurança do acesso',
  calendar: 'Datas',
};
export const PERIODS_V1 = ['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'] as const;
export const CALENDAR_LABELS_V1 = {
  accessStartsAt: 'Permitir acesso a partir de',
  accessEndsAt: 'Encerrar acesso em',
  finalDisclosureEndsAt: 'Ocultar resultado final em',
  enrollmentStartsAt: 'Início das matrículas',
  yearStartsAt: 'Início do ano e 1º trimestre',
  t1EndsAt: 'Encerramento do 1º trimestre',
  t2StartsAt: 'Início do 2º trimestre',
  t2EndsAt: 'Encerramento do 2º trimestre',
  t3StartsAt: 'Início do 3º trimestre',
  t3EndsAt: 'Encerramento do 3º trimestre',
  recoveriesStartAt: 'Início das recuperações',
  yearEndsAt: 'Encerramento do ano letivo',
  finalDisclosureAt: 'Divulgação do resultado final',
} as const;
export function settingsScopeKeyV1(input: PolicyScopeV1): string {
  const scope = policyScopeV1.parse(input);
  return scope.kind === 'school'
    ? 'school:2026'
    : scope.kind === 'class'
      ? `class:2026:${scope.classId}`
      : scope.kind === 'shift'
        ? `shift:2026:${scope.shift}`
        : `account:2026:${scope.accountId.toLowerCase()}`;
}
export function settingsScopeLabelV1(scope: PolicyScopeV1): string {
  return scope.kind === 'school'
    ? 'Escola · 2026'
    : scope.kind === 'class'
      ? `Turma ${scope.classId} · 2026`
      : scope.kind === 'shift'
        ? `Turno ${SHIFT_LABELS_V1[scope.shift]} · 2026`
        : 'Aluno · 2026';
}
export function ownsSettingV1(settings: EffectiveSettingsV1, field: SettingsFieldV1) {
  return settingsScopeKeyV1(settings.sources[field]) === settingsScopeKeyV1(settings.scope);
}

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
/** Presentation conversion only, independent of the operator's computer timezone. */
export function calendarInputV1(instant: string | null): string {
  if (instant === null) return '';
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
export function calendarInstantV1(input: string): string | null {
  if (input === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u.test(input))
    throw new Error('Informe data e horário completos.');
  const local = input.length === 16 ? input + ':00' : input;
  const naive = Date.parse(local + 'Z');
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 19) !== local)
    throw new Error('Data ou horário inválido.');
  let candidate = naive;
  for (let attempt = 0; attempt < 3; attempt++) {
    const difference = Date.parse(calendarInputV1(new Date(candidate).toISOString()) + 'Z') - naive;
    candidate -= difference;
    if (difference === 0) break;
  }
  if (calendarInputV1(new Date(candidate).toISOString()) !== local)
    throw new Error('Esse horário não existe no fuso de São Paulo.');
  return new Date(candidate).toISOString().replace('.000Z', 'Z');
}
export function singleSettingV1(field: SettingsFieldV1, value: unknown) {
  return settingsOverrideV1.parse({ [field]: value });
}
export function calendarChangeLabelV1(key: string): string {
  if (key in CALENDAR_LABELS_V1) return CALENDAR_LABELS_V1[key as keyof typeof CALENDAR_LABELS_V1];
  if (key === 'disclosure') return 'Data única de divulgação';
  if (key === 'disclosure.endsAt') return 'Ocultar notas em';
  const ending = key.startsWith('disclosure.endsAt.');
  const period = key.slice(ending ? 'disclosure.endsAt.'.length : 'disclosure.'.length);
  const label = period.startsWith('REC')
    ? `da recuperação ${period.slice(3)}`
    : `do ${period.slice(1)}º trimestre`;
  return ending ? `Ocultar notas ${label}` : `Divulgação ${label}`;
}
/** Review information; the backend still decides actual eligibility and immediate effects. */
export function changedPastDatesV1(before: CalendarV1, after: CalendarV1, now: number): string[] {
  const dates = (calendar: CalendarV1): Record<string, string | null> => ({
    ...Object.fromEntries(
      Object.keys(CALENDAR_LABELS_V1).map((key) => [
        key,
        calendar[key as keyof typeof CALENDAR_LABELS_V1] ?? null,
      ]),
    ),
    ...(calendar.disclosure.mode === 'per-period'
      ? Object.fromEntries(
          PERIODS_V1.map((period) => [
            `disclosure.endsAt.${period}`,
            calendar.disclosure.mode === 'per-period'
              ? (calendar.disclosure.endsAt?.[period] ?? null)
              : null,
          ]),
        )
      : {}),
    ...(calendar.disclosure.mode === 'single'
      ? {
          disclosure: calendar.disclosure.at,
          'disclosure.endsAt': calendar.disclosure.endsAt ?? null,
        }
      : Object.fromEntries(
          PERIODS_V1.map((period) => [
            `disclosure.${period}`,
            calendar.disclosure.mode === 'per-period' ? calendar.disclosure.at[period] : null,
          ]),
        )),
  });
  const left = dates(before),
    right = dates(after);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(
    (key) =>
      left[key] !== right[key] &&
      [left[key], right[key]].some((value) => value != null && Date.parse(value) <= now),
  );
}
