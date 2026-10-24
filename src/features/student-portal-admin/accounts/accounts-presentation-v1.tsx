import { Button, Chip } from '@heroui/react';
import type { AdminAccountReadV2 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import type { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { StudentAvatarV1 } from '../shared/student-avatar-v1';
import { accountStateLabelV1 } from './accounts-values-v1';

export function AccountIdentityV1({ account, detail = false }: Readonly<{ account: AdminAccountReadV2; detail?: boolean }>) {
  const name = account.name || 'Nome indisponível';
  return (
    <div className={detail ? 'pa-account-identity pa-account-identity--detail' : 'pa-account-identity'}>
      <StudentAvatarV1 id={account.accountId} detail={detail} />
      <div>
        <strong>{name}</strong>
        <span>{account.classLabel || 'Turma não resolvida'}</span>
      </div>
    </div>
  );
}
export function AccountStatusV1({ account }: Readonly<{ account: AdminAccountReadV2 }>) {
  return (
    <div className="pa-account-tags">
      <Chip
        size="sm"
        color={account.linkClosed ? 'default' : account.state === 'active' ? 'success' : 'warning'}
        variant="soft"
      >
        {account.linkClosed ? 'Encerrada' : accountStateLabelV1(account)}
      </Chip>
      {account.blocked && (
        <Chip size="sm" color="danger" variant="soft">
          Bloqueado
        </Chip>
      )}
    </div>
  );
}
export function AccountsErrorV1({
  error,
  onReload,
  canReload = true,
}: Readonly<{
  error: PortalClientErrorV1;
  onReload: () => void;
  canReload?: boolean;
}>) {
  let message: 'Sessão administrativa expirada. Entre novamente.' | 'Sem permissão para esta consulta.' | 'Os dados mudaram. Recarregue antes de continuar.' | 'A consulta ou a página expirou. Volte à primeira página ou recarregue.' | 'Limite temporário. Aguarde para consultar novamente.' | 'Consulta indisponível. Tente novamente.';
  if (error.state === 'unauthenticated') {
    message = 'Sessão administrativa expirada. Entre novamente.';
  } else if (error.state === 'forbidden') {
    message = 'Sem permissão para esta consulta.';
  } else if (error.state === 'conflict') {
    message = 'Os dados mudaram. Recarregue antes de continuar.';
  } else if (error.state === 'invalid-request') {
    message = 'A consulta ou a página expirou. Volte à primeira página ou recarregue.';
  } else if (error.state === 'rate-limited') {
    message = 'Limite temporário. Aguarde para consultar novamente.';
  } else {
    message = 'Consulta indisponível. Tente novamente.';
  }
  return (
    <div role="alert" className="pa-account-notice">
      <p>{message}</p>
      <Button variant="secondary" isDisabled={!canReload} onPress={onReload}>
        Tentar novamente
      </Button>
    </div>
  );
}
