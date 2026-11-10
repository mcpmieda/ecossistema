import { Chip, Table } from '@heroui/react';
import type { AdminReadResponseV2 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import { InfoV1 } from '../shared/info-v1';

type OverviewV2 = Extract<AdminReadResponseV2, { state: 'overview' }>;
type ClassRowV1 = NonNullable<OverviewV2['classes']>[number];
export type ClassLabelV1 = Readonly<{ id: number; label: string }>;

const ZERO_COUNTS_V1: ClassRowV1['counts'] = {
  accounts: 0,
  active: 0,
  pendingActivation: 0,
  resetRequired: 0,
  blocked: 0,
  unresolved: 0,
  unlinked: 0,
  accessEnabled: 0,
  accessPermitted: 0,
  validSessions: 0,
};
const collator =new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

/** Every class with its label, in school order; accounts without a class come last. */
export function overviewClassRowsV1(
  classes: readonly ClassRowV1[],
  labels: readonly ClassLabelV1[],
) {
  const names = new Map(labels.map((item) => [item.id, item.label]));
  const read = new Set(classes.map((row) => row.classId));
  // A class in the catalog with no account still shows, with zeros.
  const empty = labels
    .filter((item) => !read.has(item.id))
    .map((item) => ({ classId: item.id, counts: ZERO_COUNTS_V1 }));
  return [...classes, ...empty]
    .map((row) => ({
      ...row,
      key: row.classId === null ? 'sem-turma' : String(row.classId),
      label:
        row.classId === null ? 'Sem turma' : (names.get(row.classId) ?? `Turma ${row.classId}`),
    }))
    .sort((a, b) => {
      if (a.classId === null || b.classId === null) return a.classId === null ? 1 : -1;
      return collator.compare(a.label, b.label);
    });
}

const columns = [
  ['accounts', 'Alunos'],
  ['active', 'Contas ativas'],
  ['pendingActivation', '1º acesso pendente'],
  ['resetRequired', 'Senha a redefinir'],
  ['blocked', 'Bloqueadas'],
  ['validSessions', 'Sessões ativas'],
] as const;
/** Numbers that ask for the school's attention get a colour; the rest stay plain. */
const attention: Partial<Record<(typeof columns)[number][0], 'warning' | 'danger'>> = {
  pendingActivation: 'warning',
  resetRequired: 'warning',
  blocked: 'danger',
};

/** All classes read in the same school summary: no tabs, one request. */
export function OverviewClassesV1({
  classes,
  labels,
}: Readonly<{ classes: readonly ClassRowV1[]; labels: readonly ClassLabelV1[] }>) {
  const rows = overviewClassRowsV1(classes, labels);
  return (
    <section className="pa-overview-classes pa-rise" aria-labelledby="pa-overview-classes-title">
      <div className="pa-overview-population-head">
        <h3 id="pa-overview-classes-title">Por turma</h3>
        <InfoV1 label="Sobre os totais por turma">
          Os mesmos números do resumo da escola, separados por turma, lidos de uma só vez.
        </InfoV1>
      </div>
      <Table>
        <Table.ScrollContainer className="max-w-full overflow-x-auto">
          <Table.Content aria-label="Totais por turma" className="min-w-[640px]">
            <Table.Header>
              <Table.Column id="class" isRowHeader>
                Turma
              </Table.Column>
              {columns.map(([key, label]) => (
                <Table.Column key={key} id={key} className="text-end">
                  {label}
                </Table.Column>
              ))}
            </Table.Header>
            <Table.Body items={rows} renderEmptyState={() => 'Nenhuma turma com alunos.'}>
              {(row) => (
                <Table.Row id={row.key}>
                  <Table.Cell>
                    <span className="font-semibold">{row.label}</span>
                  </Table.Cell>
                  {columns.map(([key]) => {
                    const value = row.counts[key];
                    const color = value > 0 ? attention[key] : undefined;
                    return (
                      <Table.Cell key={key} className="text-end tabular-nums">
                        {color ? (
                          <Chip size="sm" variant="soft" color={color}>
                            {value.toLocaleString('pt-BR')}
                          </Chip>
                        ) : (
                          value.toLocaleString('pt-BR')
                        )}
                      </Table.Cell>
                    );
                  })}
                </Table.Row>
              )}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </section>
  );
}
