import { useCallback, useMemo, useState } from 'react';
import { Button, Card, Table } from '@heroui/react';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import type { PortalAdminReadClientV2, PortalClassCatalogV2 } from '../accounts/accounts-client-v2';
import { ClassFilterV1 } from '../accounts/class-filter-v1';
import { settingsScopeKeyV1 } from '../settings/settings-values-v1';
import type { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { ContinuousEndV1, useContinuousReadV1 } from '../shared/continuous-read-v1';
import {
  readBirthPageV1,
  type BirthCursorsV1,
  type BirthScopeV1,
  type BirthValueV1,
  type InitialBirthAccountV1,
} from './birth-read-v1';
import { StudentNameV1 } from '../shared/account-open-v1';

// Every prop reaches BirthReadScopeV1 through the spread.
export interface StudentBirthYearsPropsV1 {
  initialAccount?: InitialBirthAccountV1;
  client: PortalAdminClientV1;
  reader: PortalAdminReadClientV2;
  scope: ScopeV1;
  identityKey: string; // NOSONAR read through the spread
  canWrite: boolean; // NOSONAR read through the spread
  catalog?: PortalClassCatalogV2; // NOSONAR read through the spread
  scopeLabel?: string; // NOSONAR read through the spread
  onAuthorizationLost?: (error: PortalClientErrorV1) => void;
}

/** Read-only transitional projection: the server selects canonical report birth or permitted legacy. */
export function StudentBirthYearsV1(props: Readonly<StudentBirthYearsPropsV1>) {
  return (
    <BirthReadScopeV1
      key={`${props.identityKey}:${settingsScopeKeyV1(props.scope)}:${props.canWrite}`}
      {...props}
    />
  );
}
function birthStateLabelV1(birth: BirthValueV1): string {
  if (birth.confirmation === 'confirmed') return 'Confirmado';
  return birth.year ? 'Legado não confirmado' : 'Aguardando Relatório';
}

function BirthNoticeV1({ failed, loading }: Readonly<{ failed: boolean; loading: boolean }>) {
  if (failed) return <p role="alert">Consulta de nascimento indisponível.</p>;
  if (loading) return <output className="block">Carregando nascimento…</output>;
  return <p>Sem nascimento disponível.</p>;
}

function BirthReadScopeV1(props: Readonly<StudentBirthYearsPropsV1>) {
  const [selected, setSelected] = useState<{ id: number; label: string } | null>(null);
  const scope = useMemo<BirthScopeV1 | null>(() => {
    if (props.scope.kind !== 'school') return props.scope;
    return selected ? { kind: 'class', academicYear: 2026, classId: selected.id } : null;
  }, [props.scope, selected]);
  return (
    <section className="space-y-4" aria-label="Nascimento">
      {props.scope.kind === 'school' && props.catalog ? (
        <ClassFilterV1
          catalog={props.catalog}
          selected={selected}
          onChange={setSelected}
          allLabel="Escolha a turma"
        />
      ) : null}
      {scope ? (
        <BirthReadRowsV1 key={settingsScopeKeyV1(scope)} {...props} scope={scope} />
      ) : (
        <p>Escolha uma turma.</p>
      )}
    </section>
  );
}
function BirthReadRowsV1(props: StudentBirthYearsPropsV1 & { scope: BirthScopeV1 }) {
  const load = useCallback(
    async (cursor: string | undefined, signal: AbortSignal) => {
      const pair: BirthCursorsV1 | undefined = cursor
        ? (JSON.parse(cursor) as BirthCursorsV1)
        : undefined;
      const result = await readBirthPageV1(
        props.client,
        props.reader,
        props.scope,
        pair,
        signal,
        undefined,
        cursor ? undefined : props.initialAccount,
      );
      return {
        items: result.rows.map((row) => ({ ...row, accountId: row.account.accountId })),
        nextCursor: result.next ? JSON.stringify(result.next) : null,
      };
    },
    [props.client, props.reader, props.scope, props.initialAccount],
  );
  const read = useContinuousReadV1(load, 'accountId', props.onAuthorizationLost);
  const rows = read.state.state === 'ready' ? read.state.data.items : null;
  return (
    <Card>
      <Card.Header className="flex-row items-center justify-between">
        <Card.Title>Ano de nascimento</Card.Title>
        <Button
          size="sm"
          variant="secondary"
          isDisabled={!read.canReload || read.refreshing}
          onPress={read.reload}
        >
          Atualizar
        </Button>
      </Card.Header>
      <Card.Content>
        {read.state.state === 'error' || rows === null || rows.length === 0 ? (
          <BirthNoticeV1 failed={read.state.state === 'error'} loading={rows === null} />
        ) : (
          <Table variant="secondary">
            <Table.ScrollContainer>
              <Table.Content aria-label="Nascimento informado pelo cadastro">
                <Table.Header>
                  <Table.Column isRowHeader>Aluno</Table.Column>
                  <Table.Column>Ano de nascimento</Table.Column>
                  <Table.Column>Estado</Table.Column>
                </Table.Header>
                <Table.Body>
                  {rows.map(({ account, birth }) => (
                    <Table.Row key={account.accountId} id={account.accountId}>
                      <Table.Cell>
                        <StudentNameV1
                          accountId={account.accountId}
                          name={account.name}
                          parentScope={props.scope}
                        />
                      </Table.Cell>
                      <Table.Cell>{birth.year ?? '—'}</Table.Cell>
                      <Table.Cell>{birthStateLabelV1(birth)}</Table.Cell>
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
        )}
      </Card.Content>
    </Card>
  );
}
