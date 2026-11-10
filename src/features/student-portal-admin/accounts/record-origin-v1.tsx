import { useCallback } from 'react';
import { Button, Card } from '@heroui/react';
import type {
  AdminAccountReadV2,
  AdminReadResponseV2,
} from '../../../../shared/student-portal-contracts/admin-read-v2';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import type { PortalAdminReadClientV2 } from './accounts-client-v2';
import { useAccountsReadV1 } from './accounts-read-v1';

type OriginV1 = Extract<AdminReadResponseV2, { state: 'account-origin' }>;
const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'America/Bahia',
});

/** Short, ordered reasons from the records only (owner request 10/11/2026). */
export function originLinesV1(origin: OriginV1) {
  const lines = [
    origin.classesThisYear === 0
      ? 'Sem turma em 2026: nenhuma matrícula registrada para este cadastro.'
      : `Tem ${origin.classesThisYear} matrículas em 2026 e nenhuma vale como turma atual. Confira na Conciliação.`,
    `Conta criada em ${dateFormatter.format(new Date(origin.createdAt))}.`,
    origin.everAccessed ? 'Já entrou no Portal.' : 'Nunca entrou no Portal.',
    ...origin.sameName.map(
      (item) =>
        `Outro cadastro com o mesmo nome está na ${item.classLabel}` +
        (item.accountActive ? ', com conta ativa.' : '.'),
    ),
  ];
  let conclusion = 'Só dá para encerrar uma conta sem turma que nunca entrou no Portal.';
  if (origin.closable)
    conclusion =
      origin.sameName.length > 0
        ? 'Pelos registros, é um cadastro repetido e pode ser encerrado.'
        : 'Sem turma e sem uso: pode ser encerrada.';
  return { lines, conclusion };
}

/** In a record without a class: why, and "Encerrar conta" when the records allow it. */
export function RecordOriginV1({
  reader,
  account,
  canWrite,
  onClose,
}: Readonly<{
  reader: PortalAdminReadClientV2;
  account: AdminAccountReadV2 | null;
  canWrite: boolean;
  onClose: (account: AdminAccountReadV2) => void;
}>) {
  const applies = account !== null && !account.linkClosed && !!account.link && account.classId === null;
  return applies ? (
    <OriginCardV1 reader={reader} account={account} canWrite={canWrite} onClose={onClose} />
  ) : null;
}

function OriginCardV1({
  reader,
  account,
  canWrite,
  onClose,
}: Readonly<{
  reader: PortalAdminReadClientV2;
  account: AdminAccountReadV2;
  canWrite: boolean;
  onClose: (account: AdminAccountReadV2) => void;
}>) {
  const { accountId, version } = account;
  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await reader.query(
        {
          contractVersion: 2,
          operation: 'account-origin',
          scope: { kind: 'account', academicYear: 2026, accountId },
          page: { limit: 1 },
        },
        signal,
      );
      if (result.state !== 'account-origin' || result.accountId !== accountId)
        throw new PortalClientErrorV1('invalid-response');
      return result;
    },
    // A new version (after any action) reads the facts again.
    [reader, accountId, version],
  );
  const read = useAccountsReadV1(load);
  const origin = read.state.state === 'ready' ? read.state.data : null;
  const text = origin ? originLinesV1(origin) : null;
  return (
    <Card className="pa-record-origin" aria-labelledby="pa-record-origin-title">
      <Card.Content>
        <h4 id="pa-record-origin-title">Por que está sem turma</h4>
        {read.state.state === 'error' ? <p>Não foi possível ler os registros desta conta.</p> : null}
        {text ? (
          <>
            <ul>
              {text.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="pa-record-origin-conclusion">{text.conclusion}</p>
            <Button
              variant="secondary"
              isDisabled={!canWrite || !origin?.closable}
              onPress={() => onClose(account)}
            >
              Encerrar conta
            </Button>
          </>
        ) : null}
        {read.state.state === 'loading' ? (
          <p>
            <output className="contents">Lendo os registros…</output>
          </p>
        ) : null}
      </Card.Content>
    </Card>
  );
}
