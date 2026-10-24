import { useState } from 'react';
import { Button, Chip, SearchField, Table } from '@heroui/react';
import type { PerformanceAnalyticsV6 } from '../../../../shared/gradebook-contracts/performance/performance-analytics-v6';
import {
  analyticsPercentV6 as percent,
  analyticsDeltaV6 as delta,
  analyticsGradeV6 as grade,
} from './analytics-format-v6';
import { AnalyticsPanelV6 } from './performance-analytics-charts-v6';

type StudentItem = {
  id: number;
  number: number;
  name: string;
  meanPercent: number | null;
  below: number;
  complete: number;
  partial: number;
  deltaPP: number | null;
};
export function analyticsStudentItemsV6(
  value: PerformanceAnalyticsV6,
  teacherId?: number,
): StudentItem[] {
  const teacher = value.teachers.find((item) => item.id === teacherId);
  return value.students.map((item) => {
    const stats = teacher?.students.find((row) => row.studentId === item.student.id);
    return {
      id: item.student.id,
      name: item.student.name,
      number: item.student.number,
      meanPercent: stats ? stats.meanPercent : item.summary.result.mean,
      below: stats ? stats.below : item.summary.below,
      complete: stats ? stats.complete : item.summary.complete,
      partial: stats
        ? stats.partial
        : item.cells.filter((cell) => cell.result.state === 'partial').length,
      deltaPP: stats ? stats.deltaPP : item.summary.movement.meanDeltaPP,
    };
  });
}
export function AnalyticsStudentsTableV6({
  title = 'Alunos',
  items,
  onSelect,
}: Readonly<{
  title?: string;
  items: readonly StudentItem[];
  onSelect: (id: number) => void;
}>) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{
    column: string | number;
    direction: 'ascending' | 'descending';
  }>({ column: 'number', direction: 'ascending' });
  const query = search.trim().toLocaleLowerCase('pt-BR');
  const rows = items
    .filter(
      (item) =>
        !query ||
        item.name.toLocaleLowerCase('pt-BR').includes(query) ||
        String(item.number) === query,
    )
    .sort((a, b) => {
      const key =
        sort.column === 'mean'
          ? 'meanPercent'
          : sort.column === 'delta'
            ? 'deltaPP'
            : sort.column === 'below'
              ? 'below'
              : 'number';
      const left = a[key],
        right = b[key];
      if (left === null) return right === null ? a.number - b.number : 1;
      if (right === null) return -1;
      return (left - right) * (sort.direction === 'ascending' ? 1 : -1) || a.number - b.number;
    });
  return (
    <AnalyticsPanelV6
      title={title}
      action={
        <Chip size="sm" variant="soft">
          {items.length}
        </Chip>
      }
    >
      <SearchField
        aria-label={`Buscar em ${title}`}
        value={search}
        onChange={setSearch}
        className="mb-3 max-w-sm"
      >
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input placeholder="Buscar aluno" />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>
      <Table>
        <Table.ScrollContainer className="max-h-[34rem] overflow-auto">
          <Table.Content
            aria-label={title}
            sortDescriptor={sort}
            onSortChange={setSort}
            className="min-w-[590px]"
          >
            <Table.Header>
              <Table.Column id="number" allowsSorting>
                Nº
              </Table.Column>
              <Table.Column id="name" isRowHeader>
                Aluno
              </Table.Column>
              <Table.Column id="mean" allowsSorting>
                Aproveitamento
              </Table.Column>
              <Table.Column id="below" allowsSorting>
                Abaixo
              </Table.Column>
              <Table.Column id="complete">Resultados</Table.Column>
              <Table.Column id="delta" allowsSorting>
                Variação
              </Table.Column>
            </Table.Header>
            <Table.Body items={rows} renderEmptyState={() => 'Nenhum aluno neste recorte.'}>
              {(item) => (
                <Table.Row id={item.id} textValue={item.name}>
                  <Table.Cell>{item.number}</Table.Cell>
                  <Table.Cell>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto max-w-72 justify-start whitespace-normal px-0 text-left"
                      onPress={() => onSelect(item.id)}
                    >
                      {item.name}
                    </Button>
                  </Table.Cell>
                  <Table.Cell>
                    <strong className="tabular-nums">{percent(item.meanPercent)}</strong>
                  </Table.Cell>
                  <Table.Cell>
                    <Chip size="sm" variant="soft" color={item.below ? 'danger' : 'default'}>
                      {item.below}
                    </Chip>
                  </Table.Cell>
                  <Table.Cell>
                    <span className="tabular-nums">{item.complete}</span>
                    {item.partial ? (
                      <span className="ml-2 text-xs text-muted">{item.partial} parciais</span>
                    ) : null}
                  </Table.Cell>
                  <Table.Cell>
                    <span className="tabular-nums">{delta(item.deltaPP)}</span>
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </AnalyticsPanelV6>
  );
}
export function AnalyticsHeatmapV6({
  value,
  onStudent,
  onComponent,
  onCell,
}: Readonly<{
  value: PerformanceAnalyticsV6;
  onStudent: (id: number) => void;
  onComponent: (id: number) => void;
  onCell: (studentId: number, offerId: number) => void;
}>) {
  return (
    <AnalyticsPanelV6
      title="Mapa da turma"
      action={
        <Chip size="sm" variant="soft">
          {value.students.length} × {value.components.length}
        </Chip>
      }
      footer={
        <>
          <span>No limite ou acima</span>
          <span>· Abaixo</span>
          <span>· * Parcial</span>
          <span>· — Sem leitura</span>
        </>
      }
    >
      <Table>
        <Table.ScrollContainer className="max-h-[38rem] overflow-auto">
          <Table.Content aria-label="Mapa da turma por componente" className="min-w-max">
            <Table.Header>
              <Table.Column id="student" isRowHeader>
                Aluno
              </Table.Column>
              {value.components.map(({ offer }) => (
                <Table.Column key={offer.id} id={String(offer.id)}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={() => onComponent(offer.id)}
                    aria-label={`Analisar ${offer.subject.label}`}
                  >
                    {offer.subject.abbreviation ?? offer.subject.label}
                  </Button>
                </Table.Column>
              ))}
            </Table.Header>
            <Table.Body
              items={value.students}
              renderEmptyState={() => 'Nenhum aluno elegível neste recorte.'}
            >
              {(item) => (
                <Table.Row id={item.student.id} textValue={item.student.name}>
                  <Table.Cell>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto max-w-64 justify-start whitespace-normal px-0 text-left"
                      onPress={() => onStudent(item.student.id)}
                    >
                      {item.student.number}. {item.student.name}
                    </Button>
                  </Table.Cell>
                  {item.cells.map((cell) => (
                    <Table.Cell key={cell.offerId}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onPress={() => onCell(item.student.id, cell.offerId)}
                        aria-label={`${item.student.name}, ${value.components.find((component) => component.offer.id === cell.offerId)?.offer.subject.label}: ${percent(cell.percent)}${cell.result.state === 'partial' ? ', parcial' : ''}`}
                      >
                        <Chip
                          size="sm"
                          variant="soft"
                          color={
                            cell.result.state === 'partial'
                              ? 'warning'
                              : cell.result.level === 'below'
                                ? 'danger'
                                : cell.result.level === 'at-or-above'
                                  ? 'accent'
                                  : 'default'
                          }
                        >
                          {percent(cell.percent)}
                          {cell.result.state === 'partial' ? '*' : ''}
                        </Chip>
                      </Button>
                    </Table.Cell>
                  ))}
                </Table.Row>
              )}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </AnalyticsPanelV6>
  );
}
export function AnalyticsStudentComponentsV6({
  value,
  studentId,
  onCell,
}: Readonly<{
  value: PerformanceAnalyticsV6;
  studentId: number;
  onCell: (studentId: number, offerId: number) => void;
}>) {
  const student = value.students.find((item) => item.student.id === studentId);
  const offers = new Map(value.components.map((item) => [item.offer.id, item.offer]));
  return (
    <AnalyticsPanelV6 title="Componentes do aluno">
      <Table>
        <Table.ScrollContainer>
          <Table.Content aria-label="Componentes do aluno" className="min-w-[670px]">
            <Table.Header>
              <Table.Column id="component" isRowHeader>
                Componente
              </Table.Column>
              <Table.Column id="result">Nota / máximo</Table.Column>
              <Table.Column id="percent">Aproveitamento</Table.Column>
              <Table.Column id="quant">Quantitativo</Table.Column>
              <Table.Column id="qual">Qualitativo</Table.Column>
              <Table.Column id="gap">Até o limite</Table.Column>
              <Table.Column id="delta">Variação</Table.Column>
            </Table.Header>
            <Table.Body items={student?.cells ?? []}>
              {(cell) => (
                <Table.Row id={cell.offerId}>
                  <Table.Cell>
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => onCell(studentId, cell.offerId)}
                    >
                      {offers.get(cell.offerId)?.subject.label}
                    </Button>
                  </Table.Cell>
                  <Table.Cell>
                    {grade(cell.result.valueMilli)} / {grade(cell.result.maximumMilli)}
                    {cell.result.state === 'partial' ? '*' : ''}
                  </Table.Cell>
                  <Table.Cell>
                    <Chip
                      size="sm"
                      variant="soft"
                      color={
                        cell.result.state === 'partial'
                          ? 'warning'
                          : cell.result.level === 'below'
                            ? 'danger'
                            : 'default'
                      }
                    >
                      {percent(cell.percent)}
                    </Chip>
                  </Table.Cell>
                  <Table.Cell>{percent(cell.quantitative.percent)}</Table.Cell>
                  <Table.Cell>{percent(cell.qualitative.percent)}</Table.Cell>
                  <Table.Cell>{grade(cell.gapMilli)}</Table.Cell>
                  <Table.Cell>{delta(cell.deltaPP)}</Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </AnalyticsPanelV6>
  );
}
export function AnalyticsInstrumentsV6({
  component,
  onNotes,
}: Readonly<{
  component: PerformanceAnalyticsV6['components'][number];
  onNotes: (offerId: number) => void;
}>) {
  const maximum = Math.max(100, ...component.instruments.map((item) => item.stats.mean ?? 0));
  return (
    <AnalyticsPanelV6
      title="Instrumentos"
      action={
        <Button variant="secondary" size="sm" onPress={() => onNotes(component.offer.id)}>
          Notas por instrumento
        </Button>
      }
    >
      <Table>
        <Table.ScrollContainer>
          <Table.Content aria-label="Aproveitamento por instrumento" className="min-w-[650px]">
            <Table.Header>
              <Table.Column id="label" isRowHeader>
                Instrumento
              </Table.Column>
              <Table.Column id="mean">Aproveitamento</Table.Column>
              <Table.Column id="median">Mediana</Table.Column>
              <Table.Column id="deviation">Dispersão</Table.Column>
              <Table.Column id="recorded">Lançados</Table.Column>
              <Table.Column id="zero">Zeros</Table.Column>
              <Table.Column id="below">Abaixo</Table.Column>
            </Table.Header>
            <Table.Body
              items={component.instruments}
              renderEmptyState={() => 'Nenhum instrumento ativo neste recorte.'}
            >
              {(item) => (
                <Table.Row id={item.key}>
                  <Table.Cell>
                    <span className="text-xs text-muted">T{item.term} · </span>
                    {item.label}
                    <span className="ml-2 text-xs text-muted">/{grade(item.maximumMilli)}</span>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex min-w-32 items-center gap-3">
                      <span
                        className="relative h-2 flex-1 overflow-hidden rounded-full bg-separator"
                        aria-hidden="true"
                      >
                        <span
                          className="absolute inset-y-0 left-0 rounded-full bg-accent"
                          style={{ width: `${((item.stats.mean ?? 0) / maximum) * 100}%` }}
                        />
                      </span>
                      <strong className="w-14 text-right tabular-nums">
                        {percent(item.stats.mean)}
                      </strong>
                    </div>
                  </Table.Cell>
                  <Table.Cell>{percent(item.stats.median)}</Table.Cell>
                  <Table.Cell>
                    {item.stats.deviation === null
                      ? '—'
                      : `${Number(item.stats.deviation.toFixed(1)).toLocaleString('pt-BR')} p.p.`}
                  </Table.Cell>
                  <Table.Cell>
                    {item.coverage.recorded}/{item.coverage.expected}
                  </Table.Cell>
                  <Table.Cell>{item.coverage.zeros}</Table.Cell>
                  <Table.Cell>
                    {item.below}/{item.stats.n}
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </AnalyticsPanelV6>
  );
}
