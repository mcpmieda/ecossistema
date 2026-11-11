import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertDialog, Button } from '@heroui/react';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import type { PortalAdminReadClientV2 } from './accounts-client-v2';
import { useAccountsReadV1 } from './accounts-read-v1';
import { createAccountMutationV1, type AccountMutationStateV1 } from './account-mutation-v1';
import {
  ACCOUNT_ACTIONS_V1,
  accountCommandV1,
  accountPageMatchesV1,
  failureText,
  type AccountCommandV1,
} from './accounts-values-v1';
import { RecordOriginV1 } from './record-origin-v1';

/**
 * "Encerrar conta" outside the record (the Conciliação, owner request 11/11/2026): the same reason,
 * confirmation and command as the record, for an account without a class.
 */
export function AccountCloseV1({
  client,
  reader,
  accountId,
  canWrite,
  onClosed,
}: Readonly<{
  client: PortalAdminClientV1;
  reader: PortalAdminReadClientV2;
  accountId: string;
  canWrite: boolean;
  onClosed: () => void;
}>) {
  const load = useCallback(
    async (signal: AbortSignal) => {
      const scope = { kind: 'account' as const, academicYear: 2026 as const, accountId };
      const result = await reader.query(
        { contractVersion: 2, operation: 'accounts-read', scope, page: { limit: 100 } },
        signal,
      );
      if (result.state !== 'accounts-read') throw new PortalClientErrorV1('invalid-response');
      accountPageMatchesV1(result, scope);
      return result.items[0] ?? null;
    },
    [reader, accountId],
  );
  const read = useAccountsReadV1(load);
  const account = read.state.state === 'ready' ? read.state.data : null;
  const [mutation, setMutation] = useState<AccountMutationStateV1>({ state: 'idle' });
  const writer = useMemo(
    () => createAccountMutationV1(client, accountId, setMutation),
    [client, accountId],
  );
  useEffect(() => () => writer.clear(), [writer]);
  const [review, setReview] = useState<{ command: AccountCommandV1; name: string } | null>(null);
  const pending = mutation.state === 'pending';
  const failed = mutation.state === 'error';
  useEffect(() => {
    if (mutation.state === 'committed') onClosed();
  }, [mutation.state, onClosed]);
  if (mutation.state === 'committed') return null;
  return (
    <>
      <RecordOriginV1
        reader={reader}
        account={account}
        canWrite={canWrite && !pending && !failed}
        onClose={(target) =>
          setReview({
            command: accountCommandV1(target, 'account-close'),
            name: target.name || 'Nome indisponível',
          })
        }
      />
      {pending && (
        <p>
          <output className="contents">Salvando…</output>
        </p>
      )}
      {failed && (
        <div role="alert" className="pa-account-notice">
          <p>
            {failureText(
              mutation.error.state === 'conflict',
              ['unauthenticated', 'forbidden'].includes(mutation.error.state),
              mutation.retryable,
            )}
          </p>
          {mutation.retryable && (
            <Button variant="secondary" onPress={() => void writer.retry()}>
              Repetir mesma solicitação
            </Button>
          )}
        </div>
      )}
      <AlertDialog.Backdrop
        isOpen={review !== null}
        isDismissable={false}
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
      >
        <AlertDialog.Container size="md" placement="center">
          <AlertDialog.Dialog className="pa-account-dialog">
            <AlertDialog.Header>
              <AlertDialog.Heading>{ACCOUNT_ACTIONS_V1['account-close'].label}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>{review?.name}</p>
              <p>{ACCOUNT_ACTIONS_V1['account-close'].description}</p>
              <p>Mudanças em outra sessão exigem uma nova confirmação.</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button autoFocus variant="secondary" onPress={() => setReview(null)}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                isDisabled={!review || !canWrite}
                onPress={() => {
                  if (!review) return;
                  const { command } = review;
                  setReview(null);
                  void writer.submit(command);
                }}
              >
                Confirmar ação
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  );
}
