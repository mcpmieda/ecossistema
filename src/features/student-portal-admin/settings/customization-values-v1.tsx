import type { ReactNode } from 'react';
import type { AdminCommandV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import type { PolicyScopeV1, ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import type { CustomizationRowV1, PublicationContextItemV1 } from '../../../../shared/student-portal-contracts/customizations-v1';
import type { EffectiveSettingsV1 } from '../../../../shared/student-portal-contracts/policy-v1';
import { SETTINGS_LABELS_V1, type SettingsFieldV1 } from './settings-values-v1';
import { SettingsValueSummaryV1 } from './settings-editors-v1';

export type CustomizationAreaV1 = 'settings' | 'publication';
export type OpenCustomizationV1 = (row: CustomizationRowV1, area: CustomizationAreaV1) => void;
export type CustomizationResetCommandV1 = Extract<AdminCommandV1, { operation: 'publication-inherit' | 'settings-inherit' | 'block' }>;
export interface CustomizationResetChoiceV1 {
  id: string;
  label: string;
  current: ReactNode;
  inherited: ReactNode;
  command: (idempotencyKey: string) => CustomizationResetCommandV1;
}
export const customizationPeriodV1 = (period: string) => period.startsWith('REC')
  ? `Recuperação ${period.slice(3)}` : `${period.slice(1)}º trimestre`;
const publicationStateLabelV1 = (revision: string | null) => revision === null ? 'não publicado' : 'publicado';
export function publicationDifferenceV1(item: PublicationContextItemV1, scope: PolicyScopeV1) {
  const target = scope.kind === 'class' ? 'esta turma' : 'este aluno';
  const sameStatus = Boolean(item.current.revision) === Boolean(item.school.revision);
  return `${customizationPeriodV1(item.period)}: ${publicationStateLabelV1(item.current.revision)} para ${target}. Padrão da escola: ${publicationStateLabelV1(item.school.revision)}${sameStatus && item.current.revision !== item.school.revision ? ' em outra versão das notas' : ''}.`;
}
export function publicationResetChoiceV1(scope: Exclude<ScopeV1, { kind: 'school' }>, item: PublicationContextItemV1,
  publicationVersion: number): CustomizationResetChoiceV1 | null {
  if (!item.customized || item.ownVersion === null) return null;
  const expectedDecisionVersion = item.ownVersion;
  return {
    id: `publication:${item.period}`, label: `Publicação do ${customizationPeriodV1(item.period)}`,
    current: publicationStateLabelV1(item.current.revision),
    inherited: `${publicationStateLabelV1(item.inherited.revision)} · ${item.inherited.source?.kind === 'class' ? 'padrão da turma' : 'padrão da escola'}`,
    command: (idempotencyKey) => ({ contractVersion: 1, operation: 'publication-inherit', scope,
      period: item.period, expectedVersion: publicationVersion, expectedDecisionVersion, confirmed: true, idempotencyKey }),
  };
}
export function customizationResetChoicesV1(row: CustomizationRowV1): CustomizationResetChoiceV1[] {
  const scope = row.scope;
  // A shift owns options only: it never has publication choices to reset.
  const choices = scope.kind === 'shift' ? [] : row.publications.flatMap((item) => {
    const choice = publicationResetChoiceV1(scope, item, row.publicationVersion);
    return choice ? [choice] : [];
  });
  for (const field of Object.keys(row.value ?? {}) as SettingsFieldV1[]) {
    const current = row.value![field] as EffectiveSettingsV1['value'][SettingsFieldV1];
    const inherited = row.inheritedValue![field] as EffectiveSettingsV1['value'][SettingsFieldV1];
    choices.push({
      id: `setting:${field}`, label: SETTINGS_LABELS_V1[field],
      current: <SettingsValueSummaryV1 field={field} value={current} />,
      inherited: <SettingsValueSummaryV1 field={field} value={inherited} />,
      command: (idempotencyKey) => ({ contractVersion: 1, operation: 'settings-inherit', scope: row.scope,
        keys: [field], expectedVersion: row.settingsVersion, idempotencyKey }),
    });
  }
  if (row.blocked && row.scope.kind === 'account' && row.accountVersion !== null) {
    const accountId = row.scope.accountId, expectedVersion = row.accountVersion;
    choices.push({ id: 'block', label: 'Bloqueio manual de acesso', current: 'Bloqueado manualmente',
      inherited: 'Sem bloqueio manual; as regras de acesso da escola e turma continuam valendo.',
      command: (idempotencyKey) => ({ contractVersion: 1, operation: 'block', blocked: false,
        accountId, expectedVersion, confirmed: true, idempotencyKey }),
    });
  }
  return choices;
}
