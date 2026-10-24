import type { AuditDetailV1 } from '../../../../shared/student-portal-contracts/admin-v1';

type ReasonV1 = NonNullable<AuditDetailV1['reason']>;

/**
 * Motivos de recusa e como orientar a família (owner request 29/09/2026). The guidance is shown
 * only in the event detail, where support needs it.
 */
export const AUDIT_REASON_LABELS_V1: Record<ReasonV1, { label: string; help: string }> = {
  'wrong-pin': { label: 'PIN incorreto', help: 'Conferir o PIN de 4 números do cartão de acesso.' },
  'wrong-password': {
    label: 'Senha incorreta',
    help: 'Conferir a senha de 6 números criada no primeiro acesso. Se o aluno não lembrar, redefinir a senha.',
  },
  'temporarily-blocked': {
    label: 'Bloqueio temporário por tentativas',
    help: 'Aguardar o fim do bloqueio e tentar de novo com calma.',
  },
  'verification-required': {
    label: 'Verificação de segurança pendente',
    help: 'Depois de erros seguidos, o Portal pede uma verificação rápida. Concluir a verificação e tentar de novo.',
  },
  'access-closed': { label: 'Portal fechado no horário', help: 'Tentar quando o acesso estiver aberto.' },
  'card-replaced': {
    label: 'Cartão antigo',
    help: 'O QR deste cartão foi substituído. Usar o cartão mais recente.',
  },
  'account-blocked': { label: 'Conta bloqueada pela escola', help: 'Desbloquear a conta, se for o caso.' },
  'not-enrolled': {
    label: 'Sem matrícula ativa',
    help: 'A conta não está liberada para este aluno. Conferir o vínculo na Relação.',
  },
  'first-access-pending': {
    label: 'Primeiro acesso não concluído',
    help: 'Ler o cartão e usar o PIN para criar a senha.',
  },
  'first-access-not-ready': {
    label: 'Primeiro acesso não preparado',
    help: 'Falta ano de nascimento confirmado ou PIN. Conferir a ficha do aluno.',
  },
  'password-window-expired': {
    label: 'Prazo para criar a senha esgotado',
    help: 'Ler o cartão novamente e criar a senha dentro do prazo.',
  },
  'already-active': { label: 'Conta já ativada', help: 'O aluno já criou a senha. Entrar com a senha.' },
  'retry-needed': { label: 'Nova tentativa necessária', help: 'Ler o cartão novamente.' },
};

const STEP_LABELS_V1: Record<NonNullable<AuditDetailV1['step']>, string> = {
  card: 'Leitura do cartão',
  pin: 'PIN',
  password: 'Senha',
  create: 'Criação da senha',
};
const PLATFORM_LABELS_V1: Record<NonNullable<AuditDetailV1['device']>['platform'], string> = {
  android: 'Android',
  ios: 'iPhone/iPad',
  windows: 'Windows',
  macos: 'Mac',
  linux: 'Linux',
  chromeos: 'Chromebook',
  other: 'Outro aparelho',
};
const BROWSER_LABELS_V1: Record<NonNullable<AuditDetailV1['device']>['browser'], string> = {
  chrome: 'Chrome',
  safari: 'Safari',
  firefox: 'Firefox',
  edge: 'Edge',
  samsung: 'Samsung Internet',
  other: 'outro navegador',
};

/** One short line for the events table: the reason and, when counted, the attempt. */
export function auditReasonLineV1(detail: AuditDetailV1 | undefined): string | null {
  if (!detail?.reason) return null;
  const { label } = AUDIT_REASON_LABELS_V1[detail.reason];
  const counted =
    (detail.reason === 'wrong-pin' || detail.reason === 'wrong-password') &&
    detail.failures !== undefined &&
    detail.blockAfter !== undefined
      ? ` (${Math.min(detail.failures, detail.blockAfter)} de ${detail.blockAfter})`
      : '';
  return label + counted;
}

/** Label/value pairs for the event detail, only for what the event recorded. */
export function auditDetailRowsV1(
  detail: AuditDetailV1 | undefined,
  formatDate: (value: string) => string,
): { label: string; value: string }[] {
  if (!detail) return [];
  const rows: { label: string; value: string }[] = [];
  if (detail.reason) {
    rows.push({ label: 'Motivo', value: AUDIT_REASON_LABELS_V1[detail.reason].label }, { label: 'Como orientar', value: AUDIT_REASON_LABELS_V1[detail.reason].help });
  }
  if (detail.step) rows.push({ label: 'Etapa', value: STEP_LABELS_V1[detail.step] });
  if (detail.failures !== undefined && detail.blockAfter !== undefined)
    rows.push({
      label: 'Tentativas erradas',
      value: `${detail.failures} de ${detail.blockAfter} antes do bloqueio`,
    });
  if (detail.blockedUntil) rows.push({ label: 'Bloqueado até', value: formatDate(detail.blockedUntil) });
  if (detail.keepConnected !== undefined)
    rows.push({ label: 'Manter conectado', value: detail.keepConnected ? 'Sim' : 'Não' });
  if (detail.device)
    rows.push({
      label: 'Aparelho',
      value: `${PLATFORM_LABELS_V1[detail.device.platform]} · ${BROWSER_LABELS_V1[detail.device.browser]}`,
    });
  return rows;
}
