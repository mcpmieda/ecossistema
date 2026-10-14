import { MarqueeTextV1 } from '../../../shared/ui/marquee-text-v1';
import type { ReactNode } from 'react';
import { Button, Chip, Surface } from '@heroui/react';
import {
  ArrowLeft,
  ChartNoAxesColumnIncreasing,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  PieChart,
  UsersRound,
} from 'lucide-react';
import type { PerformanceDashboardV5 } from '../../../../shared/gradebook-contracts/performance/performance-dashboard-v5';
import { dashboardAnalysisV5 } from '../../../../shared/gradebook-contracts/performance/performance-dashboard-v5';
import { gradeText, subjectText } from './performance-display-v2';

export type PerformanceDashboardSelectionV5 =
  | { readonly kind: 'column'; readonly key: string; readonly bucket: 'above' | 'below' }
  | { readonly kind: 'group'; readonly group: 'allAtOrAbove' | 'withBelow' | 'pending' }
  | null;

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

function KpiCard({ icon, value, label, detail, tone, pressed, onPress }: {
  readonly icon: ReactNode;
  readonly value: string | number;
  readonly label: string;
  readonly detail: string;
  readonly tone: 'accent' | 'danger' | 'success' | 'warning';
  readonly pressed?: boolean;
  readonly onPress?: () => void;
}) {
  const content = <>
    <span className={`performance-kpi__icon performance-kpi__icon--${tone}`} aria-hidden="true">{icon}</span>
    <span className="min-w-0">
      <span className="flex items-baseline gap-2"><strong className="text-2xl font-semibold tabular-nums tracking-[-0.04em]">{value}</strong><span className="text-xs font-medium">{label}</span></span>
      <MarqueeTextV1 className="performance-kpi__detail">{detail}</MarqueeTextV1>
    </span>
  </>;
  return <Surface variant="default" className={`performance-kpi ${pressed ? 'performance-kpi--pressed' : ''}`}>
    {onPress ? <button type="button" className="performance-kpi__button" aria-pressed={pressed} onClick={onPress}>{content}</button> : <div className="performance-kpi__button">{content}</div>}
  </Surface>;
}

function PerformanceKpisV5({ value, selection, onSelectionChange }: {
  readonly value: PerformanceDashboardV5;
  readonly selection: PerformanceDashboardSelectionV5;
  readonly onSelectionChange: (selection: PerformanceDashboardSelectionV5) => void;
}) {
  const analysis = dashboardAnalysisV5(value);
  const completePercent = analysis.matrix.statistics.consideredCells === 0 ? 0 :
    analysis.matrix.statistics.completeCells / analysis.matrix.statistics.consideredCells * 100;
  const selected = (group: 'withBelow' | 'pending') =>
    selection?.kind === 'group' && selection.group === group;
  // Shown only when some student is still waiting for a classification (owner request of
  // 13/10/2026); since BN-DEC-042 a missing mark no longer leaves anyone there.
  const pending = value.overview.students.pending;
  return <div className="performance-kpi-group" data-cards={pending > 0 ? 4 : 3} aria-label="Resumo da turma">
    <KpiCard icon={<UsersRound size={20}/>} value={analysis.matrix.statistics.visibleRows} label="estudantes"
      detail={analysis.matrix.classGroup.name ?? analysis.matrix.classGroup.label} tone="accent"/>
    <KpiCard icon={<CircleAlert size={20}/>} value={value.overview.students.withBelow} label="abaixo do mínimo"
      detail="Com pelo menos um componente" tone="danger" pressed={selected('withBelow')}
      onPress={() => onSelectionChange(selected('withBelow') ? null : { kind: 'group', group: 'withBelow' })}/>
    <KpiCard icon={<CheckCircle2 size={20}/>} value={`${number.format(completePercent)}%`} label="completos"
      detail={`${analysis.matrix.statistics.completeCells} de ${analysis.matrix.statistics.consideredCells} leituras`} tone="success"/>
    {pending > 0 ? <KpiCard icon={<Clock3 size={20}/>} value={pending} label="com pendências"
      detail="Ainda sem classificação integral" tone="warning" pressed={selected('pending')}
      onPress={() => onSelectionChange(selected('pending') ? null : { kind: 'group', group: 'pending' })}/> : null}
  </div>;
}

function ComponentBarsV5({ value, selection, onSelectionChange, open }: {
  readonly value: PerformanceDashboardV5;
  readonly selection: PerformanceDashboardSelectionV5;
  readonly onSelectionChange: (selection: PerformanceDashboardSelectionV5) => void;
  readonly open: (studentId: number, offerId?: number) => void;
}) {
  const analysis = dashboardAnalysisV5(value);
  const offers = new Map(analysis.matrix.offers.map((offer) => [offer.id, offer]));
  const students = new Map(analysis.matrix.rows.map((row) => [row.student.id, row.student]));
  const selectedColumn = selection?.kind === 'column' ? analysis.columns.find((column) => column.key === selection.key) : undefined;
  const selectedBelowStudents = selectedColumn?.summary.groups.below.map((id) => students.get(id)).filter((student) => student !== undefined) ?? [];
  const maximum = Math.max(1, ...value.overview.columns.flatMap((column) => [column.atOrAbove, column.below]));
  const choose = (key: string, bucket: 'above' | 'below') => {
    const active = selection?.kind === 'column' && selection.key === key && selection.bucket === bucket;
    onSelectionChange(active ? null : { kind: 'column', key, bucket });
  };
  return <Surface variant="default" className="performance-widget min-w-0">
    <header className="performance-widget__header">
      <span className="performance-widget__icon performance-widget__icon--accent"><ChartNoAxesColumnIncreasing size={18}/></span>
      <span className="min-w-0"><h3 className="text-sm font-semibold">Situação por componente</h3></span>
      {!selectedColumn ? <span className="ml-auto hidden flex-wrap gap-3 text-[11px] text-muted sm:flex" aria-label="Legenda">
        <span className="flex items-center gap-1.5"><i className="performance-legend performance-legend--above"/>No mínimo ou acima</span>
        <span className="flex items-center gap-1.5"><i className="performance-legend performance-legend--below"/>Abaixo do mínimo</span>
      </span> : null}
    </header>
    {selectedColumn ? <section className="performance-bars__detail" aria-label={`Estudantes por situação em ${selectedColumn.label}`} aria-live="polite">
      <header className="performance-bars__detail-header"><Button size="sm" variant="ghost" onPress={() => onSelectionChange(null)}><ArrowLeft size={15}/>Voltar ao gráfico</Button><span className="min-w-0 text-right"><span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Componente selecionado</span><h4 className="truncate text-sm font-semibold">{selectedColumn.label}</h4></span></header>
      <div className="performance-bars__student-groups"><section className="performance-bars__student-group performance-bars__student-group--below" aria-label={`Notas vermelhas: ${selectedBelowStudents.length} estudante(s)`}>
        <header><span><strong>Abaixo do mínimo</strong><small>Estudantes que requerem atenção neste componente</small></span><Chip size="sm" variant="soft" color="danger">{selectedBelowStudents.length}</Chip></header>
        {selectedBelowStudents.length > 0 ? <ul>{selectedBelowStudents.map((student) => <li key={student.id}><button type="button" onClick={() => open(student.id, selectedColumn.offerId)}><span className="truncate">{student.name}</span><small>Nº {student.number}</small></button></li>)}</ul> : <p>Nenhum estudante abaixo do mínimo neste componente.</p>}
      </section></div>
    </section> : <>
      <div className="performance-bars" role="group" aria-label="Barras por componente curricular">
        {value.overview.columns.map((column) => {
          const offer = offers.get(column.offerId);
          const label = offer ? subjectText(offer) : column.label;
          const title = offer?.subject.label ?? column.label;
          return <div className="performance-bars__column" key={column.key}>
            <div className="performance-bars__plot">
              {(['above', 'below'] as const).map((bucket) => {
                const count = bucket === 'above' ? column.atOrAbove : column.below;
                const active = selection?.kind === 'column' && selection.key === column.key && selection.bucket === bucket;
                return <button key={bucket} type="button" className={`performance-bar performance-bar--${bucket} ${active ? 'performance-bar--selected' : ''}`}
                  style={{ height: `${Math.max(count === 0 ? 1.5 : 8, count / maximum * 86)}%` }} aria-pressed={active}
                  aria-label={`${title}: ${count} estudante(s) ${bucket === 'above' ? 'no mínimo ou acima' : 'abaixo do mínimo'}`}
                  onClick={() => choose(column.key, bucket)}><span>{count}</span></button>;
              })}
            </div>
            <span className="performance-bars__label" title={title}>{label}</span>
            {column.incomplete + column.noShow + column.unscaled > 0 ? <span className="performance-bars__pending" title="Leituras ainda não classificadas">+{column.incomplete + column.noShow + column.unscaled}</span> : null}
          </div>;
        })}
      </div>
    </>}
  </Surface>;
}

function ClassPanoramaV5({ value, selection, onSelectionChange, open }: {
  readonly value: PerformanceDashboardV5;
  readonly selection: PerformanceDashboardSelectionV5;
  readonly onSelectionChange: (selection: PerformanceDashboardSelectionV5) => void;
  readonly open: (studentId: number, offerId?: number) => void;
}) {
  const analysis = dashboardAnalysisV5(value);
  const stats = value.overview.students;
  const denominator = Math.max(1, stats.eligible);
  const good = stats.allAtOrAbove / denominator * 100;
  const below = stats.withBelow / denominator * 100;
  const pending = stats.pending / denominator * 100;
  const pendingLabel = analysis.lens === 'result' ? 'Sem nota numérica para classificar' : 'Ainda sem classificação';
  const students = new Map(analysis.matrix.rows.map((row) => [row.student.id, row.student]));
  const withRed = new Set(analysis.matrix.rows.filter((row) => row.cells.some((cell) => cell.level === 'below')).map((row) => row.student.id));
  const totalLabel = analysis.matrix.period === 'annual' ? 'Total anual' : `Total do T${analysis.matrix.period}`;
  const choose = (group: 'allAtOrAbove' | 'withBelow' | 'pending') => {
    const active = selection?.kind === 'group' && selection.group === group;
    onSelectionChange(active ? null : { kind: 'group', group });
  };
  return <Surface variant="default" className="performance-widget min-w-0">
    <header className="performance-widget__header">
      <span className="performance-widget__icon performance-widget__icon--accent"><PieChart size={18}/></span>
      <span><h3 className="text-sm font-semibold">Panorama da turma</h3></span>
    </header>
    <div className="performance-panorama">
      <div className="performance-donut" role="img" aria-label={`${stats.allAtOrAbove} estudantes com todos os componentes no mínimo ou acima, ${stats.withBelow} com pelo menos um abaixo e ${stats.pending} sem leitura classificada`}
        style={{ background: `conic-gradient(var(--performance-above) 0 ${good}%, var(--performance-below) ${good}% ${good + below}%, var(--performance-pending) ${good + below}% ${good + below + pending}%)` }}>
        <div className="performance-donut__center"><strong>{number.format(good)}%</strong><span>{stats.allAtOrAbove} de {stats.eligible}</span></div>
      </div>
      <div className="performance-panorama__counts" aria-label="Quantidades do panorama">
        <button type="button" className="performance-panorama__item" title="Todos no mínimo ou acima" aria-label={`${stats.allAtOrAbove} estudante(s) com todos os componentes no mínimo ou acima`} aria-pressed={selection?.kind === 'group' && selection.group === 'allAtOrAbove'} onClick={() => choose('allAtOrAbove')}>
          <i className="performance-legend performance-legend--above"/><MarqueeTextV1>No mínimo ou acima</MarqueeTextV1><strong>{stats.allAtOrAbove}</strong>
        </button>
        <button type="button" className="performance-panorama__item" title="Algum componente abaixo do mínimo" aria-label={`${stats.withBelow} estudante(s) com algum componente abaixo do mínimo`} aria-pressed={selection?.kind === 'group' && selection.group === 'withBelow'} onClick={() => choose('withBelow')}>
          <i className="performance-legend performance-legend--below"/><MarqueeTextV1>Abaixo do mínimo</MarqueeTextV1><strong>{stats.withBelow}</strong>
        </button>
        <button type="button" className="performance-panorama__item" title={pendingLabel} aria-label={`${stats.pending} estudante(s): ${pendingLabel}`} aria-pressed={selection?.kind === 'group' && selection.group === 'pending'} onClick={() => choose('pending')}>
          <i className="performance-legend performance-legend--pending"/><MarqueeTextV1>Sem classificação</MarqueeTextV1><strong>{stats.pending}</strong>
        </button>
      </div>
    </div>
    <details className="performance-ranking" aria-label="Classificação da turma">
      <summary><span><strong>Classificação da turma</strong><small>10 maiores somatórios do recorte</small></span><span className="flex items-center gap-1.5"><Chip size="sm" variant="soft" color="accent">Top 10</Chip><ChevronDown className="performance-ranking__chevron" size={15}/></span></summary>
      {value.overview.ranking.length > 0 ? <ol>{value.overview.ranking.map((entry, index) => {
        const student = students.get(entry.studentId);
        if (student === undefined) return null;
        return <li key={entry.studentId}><button type="button" onClick={() => open(entry.studentId)} aria-label={`${index + 1}º lugar, ${student.name}, ${totalLabel}: ${gradeText(entry.totalMilli)}${entry.partial ? ', somatório parcial' : ''}`}>
          <span className="performance-ranking__position">{index + 1}</span><span className={withRed.has(entry.studentId) ? 'truncate text-danger' : 'truncate'}>{student.name}</span><strong className="tabular-nums">{gradeText(entry.totalMilli)}{entry.partial ? '*' : ''}</strong>
        </button></li>;
      })}</ol> : <p>Nenhum estudante tem valor numérico em todos os componentes deste recorte.</p>}
      <footer>{totalLabel} · soma dos componentes com valor numérico{value.overview.ranking.some((entry) => entry.partial) ? ' · * soma com componente parcial' : ''}</footer>
    </details>
  </Surface>;
}

export function PerformanceDashboardWidgetsV5({ value, selection, onSelectionChange, open }: {
  readonly value: PerformanceDashboardV5;
  readonly selection: PerformanceDashboardSelectionV5;
  readonly onSelectionChange: (selection: PerformanceDashboardSelectionV5) => void;
  readonly open: (studentId: number, offerId?: number) => void;
}) {
  return <div className="grid min-w-0 gap-4">
    <PerformanceKpisV5 value={value} selection={selection} onSelectionChange={onSelectionChange}/>
    <div className="performance-dashboard-grid">
      <ComponentBarsV5 value={value} selection={selection} onSelectionChange={onSelectionChange} open={open}/>
      <ClassPanoramaV5 value={value} selection={selection} onSelectionChange={onSelectionChange} open={open}/>
    </div>
  </div>;
}
