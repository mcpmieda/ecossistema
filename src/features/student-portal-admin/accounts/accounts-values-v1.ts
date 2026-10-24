import type { AdminAccountReadV2 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import type { AdminCommandV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import { SHIFT_LABELS_V1, type PolicyScopeV1, type ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import type { AccountsReadPageV2 } from './accounts-client-v2';

export type AccountActionV1 =
  'block' | 'unblock' | 'password-reset' | 'account-reset' | 'qr-regenerate';
export type AccountCommandV1 = Extract<
  AdminCommandV1,
  { operation: 'block' | 'password-reset' | 'account-reset' | 'qr-regenerate' }
>;
export const ACCOUNT_ACTIONS_V1: Record<AccountActionV1, { label: string; description: string }> = {
  block: {
    label: 'Bloquear acesso',
    description:
      'Aplica o bloqueio administrativo e revoga as sessões. Preserva QR, senha, nascimento e vínculo acadêmico.',
  },
  unblock: {
    label: 'Desbloquear acesso',
    description:
      'Retira apenas o bloqueio administrativo. Não remove o bloqueio temporário por tentativas nem as restrições de calendário, vínculo ou acesso.',
  },
  'password-reset': {
    label: 'Redefinir senha',
    description:
      'Invalida a senha atual e revoga as sessões. O aluno precisará definir outra senha usando o mesmo QR e o ano de nascimento já cadastrado.',
  },
  'account-reset': {
    label: 'Redefinir conta',
    description:
      'Invalida o QR e a senha atuais, gera outro QR e revoga as sessões. Volta ao primeiro acesso. Preserva nascimento, vínculo e histórico acadêmico; não encerra o vínculo nem libera o reset anual do Banco.',
  },
  'qr-regenerate': {
    label: 'Mudar QR',
    description:
      'Invalida o QR atual, gera outro e revoga as sessões. Preserva a senha, o estado de autenticação, o nascimento e o vínculo acadêmico.',
  },
};
export function accountLinkLabelV1(account: AdminAccountReadV2) {
  if (account.linkClosed) return 'Vínculo Portal encerrado';
  if (account.link === null || account.eligibility === 'unlinked') return 'Sem vínculo acadêmico';
  if (account.eligibility === 'unresolved' || account.classId === null)
    return 'Vínculo não resolvido';
  if (account.eligibility === 'exit') return 'Saída da escola';
  return 'Vínculo vigente';
}
export function accountManageableV1(account: AdminAccountReadV2) {
  return (
    !account.linkClosed &&
    account.link !== null &&
    account.classId !== null &&
    account.eligibility !== 'unlinked' &&
    account.eligibility !== 'unresolved' &&
    account.eligibility !== 'exit'
  );
}
export function accountStateLabelV1(account: AdminAccountReadV2) {
  return {
    active: 'Ativa',
    'pending-activation': 'Primeiro acesso',
    'reset-required': 'Redefinição pendente',
  }[account.state];
}
export function firstAccessLabelV1(account: AdminAccountReadV2) {
  return {
    ready: 'Pronto para o primeiro acesso',
    'birth-missing': 'Aguardando Relatório',
    'birth-unconfirmed': 'Aguardando conciliação do Relatório',
    'qr-missing': 'Emita o QR de acesso',
    'pin-missing': 'PIN de primeiro acesso ausente',
    'pin-outdated': 'PIN de primeiro acesso desatualizado',
    'not-required': account.firstAccess.qrIssued
      ? 'Conta ativa com QR'
      : 'Conta ativa sem QR válido',
  }[account.firstAccess.state];
}
export function accountCredentialPreparableV1(account: AdminAccountReadV2) {
  return (
    accountManageableV1(account) &&
    (account.firstAccess.state === 'ready' ||
      account.firstAccess.state === 'qr-missing' ||
      account.firstAccess.state === 'not-required')
  );
}
export function accountCommandV1(
  account: AdminAccountReadV2,
  action: AccountActionV1,
): AccountCommandV1 {
  if (!accountManageableV1(account)) throw new PortalClientErrorV1('invalid-request');
  const base = {
    contractVersion: 1 as const,
    accountId: account.accountId,
    expectedVersion: account.version,
    idempotencyKey: crypto.randomUUID(),
    confirmed: true as const,
  };
  if (action === 'block' || action === 'unblock')
    return { ...base, operation: 'block', blocked: action === 'block' };
  return { ...base, operation: action };
}
export function accountPageMatchesV1(page: AccountsReadPageV2, scope: ScopeV1) {
  if (
    new Set(page.items.map((item) => item.accountId)).size !== page.items.length ||
    page.items.some((item) => {
      if (scope.kind === 'account') {
        return item.accountId !== scope.accountId;
      }
      if (scope.kind === 'class') {
        return item.classId !== scope.classId;
      }
      return false;
    },
    )
  )
    throw new PortalClientErrorV1('invalid-response');
  return page;
}
const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
});
export function lastAuthenticationLabelV1(at: string | null) {
  return at === null ? 'Desconhecido nos últimos 12 meses' : dateFormatter.format(new Date(at));
}
export function accountAccessOriginV1(
  source: PolicyScopeV1 | null,
  describeScope?: (scope: PolicyScopeV1) => string,
) {
  if (source === null) return 'Origem não resolvida';
  if (describeScope) return describeScope(source);
  if (source.kind === 'school') {
    return 'Escola · 2026';
  }
  if (source.kind === 'class') {
    return 'Turma';
  }
  if (source.kind === 'shift') {
    return `Turno ${SHIFT_LABELS_V1[source.shift]}`;
  }
  return 'Individual';
}
