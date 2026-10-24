import { GranularStatusV1 } from '../../../shared/grades/granular-status-v1';
import { useState, type ReactNode } from 'react';
import { Button } from '@heroui/react';
import type {
  PerformanceAnalysisV3,
  AnalysisReadingV3,
} from '../../../../shared/gradebook-contracts/performance/performance-analysis-v3';
import type { PerformanceStatusV2 } from '../../../../shared/gradebook-contracts/performance/relational-performance-v2';
import type { PerformanceDashboardV5 } from '../../../../shared/gradebook-contracts/performance/performance-dashboard-v5';
import { gradeText, subjectText } from './performance-display-v2';
import {
  PerformanceDashboardWidgetsV5,
  type PerformanceDashboardSelectionV5,
} from './performance-dashboard-widgets-v5';
import { PerformanceGridV2 } from './performance-grid-v2';

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const percent = (value: number | null) => (value === null ? '—' : `${number.format(value)}%`);
const STATE: Record<AnalysisReadingV3['state'], string> = {
  complete: '',
  partial: 'Parcial',
  'not-recorded': 'Sem nota',
  unavailable: 'Indisponível',
  'not-applicable': 'Não se aplica',
  'recovery-pending': 'Pendente',
  'no-show': 'N/C',
  'repeat-failure': 'R/R',
};

const BUCKET_TONE: Partial<Record<string, string>> = { below: 'text-danger', above: 'text-accent' };

/** A cell: "não fez" or zero on an assessment, N/C for a no-show, otherwise the grade. */
function readingContent(
  reading: {
    notDone?: boolean;
    recordedMilli?: number | null;
    state: string;
    valueMilli: number | null;
  },
  assessments: boolean,
): ReactNode {
  if (assessments && (reading.notDone || reading.recordedMilli === 0))
    return <GranularStatusV1 notDone={reading.notDone} zero={reading.recordedMilli === 0} />;
  return reading.state === 'no-show' ? 'N/C' : gradeText(reading.valueMilli);
}

export function PerformanceAnalysisPanelV3({
  value,
  dashboard,
  previous,
  open,
  renderResult,
  focusOffer,
  statuses,
}: {
  readonly value: PerformanceAnalysisV3;
  readonly dashboard: PerformanceDashboardV5;
  /** The same reading of the trimester before, when there is one. */
  readonly previous?: PerformanceDashboardV5 | null;
  readonly open: (studentId: number, offerId?: number) => void;
  readonly renderResult: (ids: ReadonlySet<number> | null) => ReactNode;
  readonly focusOffer: (offerId: number) => void;
  /** Situations listed in the lens matrix. */
  readonly statuses: readonly PerformanceStatusV2[];
}) {
  const [selection, setSelection] = useState<PerformanceDashboardSelectionV5>(null);
  const column =
    selection?.kind === 'column' ? value.columns.find((item) => item.key === selection.key) : null;
  // prettier-ignore
  const ids = selection?.kind === 'group' ? new Set(dashboard.overview.groups[selection.group]) : null;
  const students = new Map(value.matrix.rows.map((row) => [row.student.id, row.student]));
  const rows = value.rows.filter(
    (row) =>
      (ids === null || ids.has(row.studentId)) &&
      statuses.includes(students.get(row.studentId)?.status ?? null),
  );
  const offers = new Map(value.matrix.offers.map((offer) => [offer.id, offer]));
  const selectionLabel =
    selection?.kind === 'group'
      ? {
          allAtOrAbove: 'todos os componentes no mínimo ou acima',
          withBelow: 'algum componente abaixo do mínimo',
          pending: 'ainda sem classificação integral',
        }[selection.group]
      : null;
  let selectionNote: ReactNode = null;
  if (selection?.kind === 'column') {
    selectionNote = (
      <>
        Detalhe de <strong>{column?.label ?? 'componente'}</strong> aberto no card; a matriz
        permanece completa.
      </>
    );
  } else if (selectionLabel) {
    selectionNote = (
      <>
        Investigando: <strong>{selectionLabel}</strong> · {rows.length} estudante(s)
        <Button size="sm" variant="ghost" onPress={() => setSelection(null)}>
          Limpar filtro
        </Button>
      </>
    );
  }
  return (
    <>
      <PerformanceDashboardWidgetsV5
        value={dashboard}
        previous={previous ?? null}
        selection={selection}
        onSelectionChange={setSelection}
        open={open}
      />
      {value.lens !== 'result' && value.matrix.mode === 'recovery' ? (
        <p role="status" className="text-xs text-muted">
          Composição regular dos alunos em recuperação. A nota de REC está em Resultado.
        </p>
      ) : null}
      {selection?.kind === 'column' || selectionLabel ? (
        <div
          className={
            selection?.kind === 'column'
              ? 'sr-only'
              : 'flex min-h-9 flex-wrap items-center gap-2 text-sm'
          }
          role="status"
        >
          {selectionNote}
        </div>
      ) : null}
      {value.lens === 'result' ? (
        renderResult(ids)
      ) : (
        <PerformanceGridV2
          label="Matriz da lente"
          open={open}
          focusOffer={focusOffer}
          columns={value.columns.map((item) => ({
            key: item.key,
            label:
              value.lens === 'assessments' ? item.label : subjectText(offers.get(item.offerId)!),
            title: item.label,
            offerId: item.offerId,
          }))}
          rows={rows.map((row) => ({
            student: students.get(row.studentId)!,
            below: row.values.map((reading) => reading.bucket === 'below'),
            values: row.values.map((reading) => (
              <span key={reading.key} className="inline-flex flex-col items-center gap-0.5">
                <span className={`font-semibold tabular-nums ${BUCKET_TONE[reading.bucket] ?? ''}`}>
                  {readingContent(reading, value.lens === 'assessments')}
                </span>
                {STATE[reading.state] &&
                !(
                  value.lens === 'assessments' &&
                  (reading.notDone || reading.recordedMilli === 0)
                ) ? (
                  <span className="text-[10px]">{STATE[reading.state]}</span>
                ) : null}
                {reading.percent !== null &&
                !(
                  value.lens === 'assessments' &&
                  (reading.notDone || reading.recordedMilli === 0)
                ) ? (
                  <span className="text-[10px] text-muted">{percent(reading.percent)}</span>
                ) : null}
              </span>
            )),
          }))}
        />
      )}
    </>
  );
}
