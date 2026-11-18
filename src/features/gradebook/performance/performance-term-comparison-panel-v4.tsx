import type {
  PerformanceTermComparisonV4,
  PerformanceTermComparisonValueV4,
} from '../../../../shared/gradebook-contracts/performance/performance-term-comparison-v4';
import { memo, useMemo } from 'react';
import { subjectText } from './performance-display-v2';
import { PerformanceGridV2 } from './performance-grid-v2';

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const percent = (value: number | null) => (value === null ? '—' : `${number.format(value)}%`);
const signed = (value: number) => `${value > 0 ? '+' : ''}${number.format(value)} p.p.`;
const RELATION = { higher: 'Maior', equal: 'Igual', lower: 'Menor' } as const;
const REASON: Record<Exclude<PerformanceTermComparisonValueV4['reason'], null>, string> = {
  'current-excluded': 'Atual fora do recorte',
  'reference-excluded': 'Referência fora do recorte',
  'current-incomplete': 'Atual incompleto',
  'reference-incomplete': 'Referência incompleta',
  'current-no-positive-maximum': 'Atual sem máximo',
  'reference-no-positive-maximum': 'Referência sem máximo',
};

export const PerformanceTermComparisonPanelV4 = memo(function PerformanceTermComparisonPanelV4({
  value,
  open,
}: {
  readonly value: PerformanceTermComparisonV4;
  readonly open: (studentId: number, offerId?: number) => void;
}) {
  const totals = value.rows
    .flatMap((row) => row.values)
    .reduce(
      (result, item) => {
        result[item.state === 'unavailable' ? 'unavailable' : item.relation]++;
        return result;
      },
      { higher: 0, equal: 0, lower: 0, unavailable: 0 },
    );
  // Built once per reading, so the grid keeps its rendered rows across other renders.
  const grid = useMemo(() => {
    const students = new Map(
      value.analysis.matrix.rows.map((row) => [row.student.id, row.student]),
    );
    const offers = new Map(value.analysis.matrix.offers.map((offer) => [offer.id, offer]));
    return {
      columns: value.columns.map((column) => ({
        key: column.key,
        label: subjectText(offers.get(column.offerId)!),
        title: column.label,
        offerId: column.offerId,
      })),
      rows: value.rows.map((row) => ({
        student: students.get(row.studentId)!,
        values: row.values.map((item) =>
          item.state === 'unavailable' ? (
            <span key={item.key} className="inline-flex flex-col items-center gap-0.5">
              <span className="font-semibold">—</span>
              <span className="text-[10px] text-muted">{REASON[item.reason]}</span>
            </span>
          ) : (
            <span key={item.key} className="inline-flex flex-col items-center gap-0.5">
              <span className="font-semibold">
                {RELATION[item.relation]} · {signed(item.deltaPercentagePoints)}
              </span>
              <span className="text-[10px] text-muted">
                {percent(item.currentPercent)} × {percent(item.referencePercent)}
              </span>
            </span>
          ),
        ),
      })),
    };
  }, [value]);
  const current = value.analysis.matrix.period;
  return (
    <section
      aria-label="Comparação entre trimestres"
      className="grid min-w-0 gap-3 rounded-xl border border-separator bg-surface p-4"
    >
      <div>
        <h3 className="font-semibold">
          T{current} comparado ao T{value.referencePeriod}
        </h3>
        <p className="text-xs text-muted">
          Leitura descritiva da mesma turma, aluno, componente e lente no ano selecionado. A
          diferença usa pontos percentuais do máximo oficial; não mede evolução pedagógica.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="Resumo comparativo">
        <div className="rounded-xl border border-separator p-3">
          <strong className="text-2xl tabular-nums">{totals.higher}</strong>
          <p className="text-xs text-muted">Maior no T{current}</p>
        </div>
        <div className="rounded-xl border border-separator p-3">
          <strong className="text-2xl tabular-nums">{totals.equal}</strong>
          <p className="text-xs text-muted">Igual</p>
        </div>
        <div className="rounded-xl border border-separator p-3">
          <strong className="text-2xl tabular-nums">{totals.lower}</strong>
          <p className="text-xs text-muted">Menor no T{current}</p>
        </div>
        <div className="rounded-xl border border-separator p-3">
          <strong className="text-2xl tabular-nums">{totals.unavailable}</strong>
          <p className="text-xs text-muted">Indisponível</p>
        </div>
      </div>
      <PerformanceGridV2
        label={`Comparação T${current} com T${value.referencePeriod}`}
        columns={grid.columns}
        rows={grid.rows}
        open={open}
      />
      <p className="text-xs text-muted">
        “Maior”, “igual” e “menor” descrevem somente o valor proporcional registrado. Dados
        parciais, N/C, recuperação pendente, não aplicável ou sem máximo positivo não são
        comparados.
      </p>
    </section>
  );
});
