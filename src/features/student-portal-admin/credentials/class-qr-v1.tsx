import { useCallback, useMemo, useRef, useState } from 'react';
import { Button, Card, Checkbox, Table } from '@heroui/react';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { ClassFilterV1 } from '../accounts/class-filter-v1';
import {
  accountCredentialPreparableV1,
  accountPageMatchesV1,
  firstAccessLabelV1,
} from '../accounts/accounts-values-v1';
import { StudentNameV1 } from '../shared/account-open-v1';
import { ContinuousEndV1, useContinuousReadV1 } from '../shared/continuous-read-v1';
import { StudentAvatarV1 } from '../shared/student-avatar-v1';
import { QrBatchToolsV1 } from './qr-batch-tools-v1';
import type { StudentCredentialsPropsV1 } from './student-credentials-v1';

/** QR selection consumes account eligibility, independently of birth editing or birth queries. */
export function ClassQrV1(props: StudentCredentialsPropsV1) {
  const [selected, setSelected] = useState<{ id: number; label: string } | null>(null);
  const scope = useMemo(
    () =>
      props.scope.kind === 'class'
        ? props.scope
        : selected
          ? { kind: 'class' as const, academicYear: 2026 as const, classId: selected.id }
          : null,
    [props.scope, selected],
  );
  return (
    <section className="space-y-4" aria-label="QR por turma">
      <h2>QR code</h2>
      {props.scope.kind === 'school' && props.catalog ? (
        <ClassFilterV1
          catalog={props.catalog}
          selected={selected}
          onChange={setSelected}
          allLabel="Escolha a turma"
        />
      ) : null}
      {scope ? (
        <ClassQrRowsV1
          key={scope.classId}
          {...props}
          scope={scope}
          label={selected?.label ?? props.scopeLabel ?? 'Turma'}
        />
      ) : (
        <p className="text-sm text-muted">Escolha uma turma.</p>
      )}
    </section>
  );
}

function ClassQrRowsV1(
  props: StudentCredentialsPropsV1 & {
    scope: { kind: 'class'; academicYear: number; classId: number };
    label: string;
  },
) {
  const [selection, setSelection] = useState<{ revision: number; ids: Set<string> }>({
    revision: -1,
    ids: new Set(),
  });
  const pageVersion = useRef<number | null>(null);
  const load = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const result = await props.reader.query(
        {
          contractVersion: 2,
          operation: 'accounts-read',
          scope: props.scope,
          page: { limit: 100, ...(cursor ? { cursor } : {}) },
        },
        signal,
      );
      if (result.state !== 'accounts-read') throw new PortalClientErrorV1('invalid-response');
      if (cursor && pageVersion.current !== result.scopeVersion)
        throw new PortalClientErrorV1('conflict');
      pageVersion.current = result.scopeVersion;
      return accountPageMatchesV1(result, props.scope);
    },
    [props.reader, props.scope],
  );
  const read = useContinuousReadV1(load, 'accountId', props.onAuthorizationLost);
  const current = read.state.state === 'ready' ? read.state.data : null;
  const accounts = current?.items ?? [];
  const eligible = new Set(
    accounts.filter(accountCredentialPreparableV1).map((item) => item.accountId),
  );
  const selected =
    selection.revision === current?.scopeVersion
      ? new Set([...selection.ids].filter((id) => eligible.has(id)))
      : new Set<string>();
  return (
    <Card>
      <Card.Content className="space-y-4">
        {read.state.state === 'error' ? (
          <div className="space-y-2">
            <p role="alert">Consulta indisponível. Atualize a lista.</p>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={!read.canReload}
              onPress={read.reload}
            >
              Atualizar
            </Button>
          </div>
        ) : null}
        {!current ? (
          read.state.state === 'error' ? null : (
            <p role="status">Carregando alunos…</p>
          )
        ) : (
          <>
            <QrBatchToolsV1
              client={props.client}
              accounts={accounts}
              selected={selected}
              academicYear={props.scope.academicYear}
              classId={props.scope.classId}
              scopeVersion={current.scopeVersion}
              label={props.label}
              canWrite={props.canWrite}
              pendingBirth={read.refreshing || Boolean(read.refreshError)}
              hasMore={read.more}
              onCommitted={read.reload}
              onAuthorizationLost={props.onAuthorizationLost}
              renderArtifact={props.renderArtifact}
            />
            <Table variant="secondary">
              <Table.ScrollContainer role="region" tabIndex={0} aria-label="Alunos para QR">
                <Table.Content
                  aria-label="Alunos para QR"
                  selectionMode="multiple"
                  selectedKeys={selected}
                  disabledBehavior="selection"
                  disabledKeys={accounts
                    .filter((item) => !props.canWrite || !eligible.has(item.accountId))
                    .map((item) => item.accountId)}
                  onSelectionChange={(keys) =>
                    setSelection({
                      revision: current.scopeVersion,
                      ids: new Set(
                        keys === 'all'
                          ? eligible
                          : [...keys].map(String).filter((id) => eligible.has(id)),
                      ),
                    })
                  }
                >
                  <Table.Header>
                    <Table.Column id="selection" aria-label="Selecionar alunos">
                      <Checkbox slot="selection" aria-label="Selecionar alunos disponíveis">
                        <Checkbox.Content aria-label="Selecionar alunos disponíveis">
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                        </Checkbox.Content>
                      </Checkbox>
                    </Table.Column>
                    <Table.Column isRowHeader>Aluno</Table.Column>
                    <Table.Column>Turma</Table.Column>
                    <Table.Column>Acesso</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {accounts.map((account) => (
                      <Table.Row
                        key={account.accountId}
                        id={account.accountId}
                        textValue={account.name}
                      >
                        <Table.Cell>
                          <Checkbox slot="selection" aria-label="Selecionar">
                            <Checkbox.Content>
                              <Checkbox.Control>
                                <Checkbox.Indicator />
                              </Checkbox.Control>
                            </Checkbox.Content>
                          </Checkbox>
                        </Table.Cell>
                        <Table.Cell>
                          <StudentNameV1
                            accountId={account.accountId}
                            name={account.name}
                            parentScope={props.scope}
                          >
                            <div className="pa-account-identity">
                              <StudentAvatarV1 id={account.accountId} />
                              <strong>{account.name}</strong>
                            </div>
                          </StudentNameV1>
                        </Table.Cell>
                        <Table.Cell>{account.classLabel}</Table.Cell>
                        <Table.Cell>{firstAccessLabelV1(account)}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
                <ContinuousEndV1
                  more={read.more}
                  busy={read.refreshing}
                  failed={Boolean(read.refreshError)}
                  loadMore={read.loadMore}
                  retry={read.reload}
                />
              </Table.ScrollContainer>
            </Table>
          </>
        )}
      </Card.Content>
    </Card>
  );
}
