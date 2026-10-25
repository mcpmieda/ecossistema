import { MarqueeTextV1 } from '../../../shared/ui/marquee-text-v1';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Chip, Surface } from '@heroui/react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChartNoAxesColumnIncreasing,
  CheckCircle2,
  ChevronRight,
  Medal,
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

/** Names without an abbreviation are shortened so they fit on one line: initials of a longer name
 * (PV), the start of a single word (ESP); when two would read the same, each keeps the start of
 * its last word (E.FÍS, E.FIN). */
function shortSubjectsV5(texts: readonly string[]): string[] {
  const words = (text: string) => text.split(/\s+/u).filter((word) => word.length > 2);
  const initials = (text: string) => {
    if (text.length <= 4) {
      return text;
    }
    if (words(text).length > 1) {
      return words(text).map((word) => word[0]).join('').toUpperCase();
    }
    return text.slice(0, 3).toUpperCase();
  };
  const first = texts.map(initials);
  return texts.map((text, index) => {
    if (first.indexOf(first[index]!) === first.lastIndexOf(first[index]!) || first[index] === text) return first[index]!;
    const parts = words(text);
    return `${parts[0]![0]}.${parts.at(-1)!.slice(0, 3)}`.toUpperCase();
  });
}

/** The change of one bar since the trimester before, over its number, in the colour of the bar. */
function DeltaV5({ now, before, bucket, period }: {
  readonly now: number;
  readonly before: number | undefined;
  readonly bucket: 'above' | 'below';
  readonly period: number;
}) {
  if (before === undefined) return null;
  const change = now - before;
  let direction: 'up' | 'down' | 'none' = 'none';
  if (change > 0) direction = 'up';
  else if (change < 0) direction = 'down';
  return <span className={`performance-delta performance-delta--${bucket}`}
    data-change={direction}
    title={`${change > 0 ? '+' : ''}${change} em relação ao ${period}º trimestre`}>
    {direction === 'up' ? <ArrowUp size={9} strokeWidth={3} aria-hidden/> : null}
    {direction === 'down' ? <ArrowDown size={9} strokeWidth={3} aria-hidden/> : null}
    {change === 0 ? '=' : Math.abs(change)}
  </span>;
}

function ComponentBarsV5({ value, previous, selection, onSelectionChange, open }: {
  readonly value: PerformanceDashboardV5;
  readonly previous: PerformanceDashboardV5 | null;
  readonly selection: PerformanceDashboardSelectionV5;
  readonly onSelectionChange: (selection: PerformanceDashboardSelectionV5) => void;
  readonly open: (studentId: number, offerId?: number) => void;
}) {
  const analysis = dashboardAnalysisV5(value);
  const offers = new Map(analysis.matrix.offers.map((offer) => [offer.id, offer]));
  const students = new Map(analysis.matrix.rows.map((row) => [row.student.id, row.student]));
  const selectedColumn = selection?.kind === 'column' ? analysis.columns.find((column) => column.key === selection.key) : undefined;
  const selectedBucket = selection?.kind === 'column' ? selection.bucket : 'below';
  const selectedStudents = selectedColumn?.summary.groups[selectedBucket].map((id) => students.get(id)).filter((student) => student !== undefined) ?? [];
  const bucketText = selectedBucket === 'above' ? 'no mínimo ou acima' : 'abaixo do mínimo';
  const maximum = Math.max(1, ...value.overview.columns.flatMap((column) => [column.atOrAbove, column.below]));
  const before = new Map(previous?.overview.columns.map((column) => [column.offerId, column]) ?? []);
  const period = analysis.matrix.period;
  const previousPeriod = typeof period === 'number' && period > 1 && previous ? period - 1 : null;
  const labels = shortSubjectsV5(value.overview.columns.map((column) => {
    const offer = offers.get(column.offerId);
    return offer ? subjectText(offer) : column.label;
  }));
  // Slides: the list comes in from the right, the chart back from the left. Focus follows: to the
  // back button when a list opens, to the bar it came from when it closes.
  const [back, setBack] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const opened = useRef<string | null>(null);
  const openKey = selectedColumn ? `${selectedColumn.key}:${selectedBucket}` : null;
  useEffect(() => {
    if (openKey) {
      opened.current = openKey;
      card.current?.querySelector<HTMLElement>('.performance-bars__detail-header button')?.focus();
    } else if (opened.current) {
      card.current?.querySelector<HTMLElement>(`[data-bar="${CSS.escape(opened.current)}"]`)?.focus();
      opened.current = null;
    }
  }, [openKey]);
  const choose = (key: string, bucket: 'above' | 'below') => {
    const active = selection?.kind === 'column' && selection.key === key && selection.bucket === bucket;
    setBack(active);
    onSelectionChange(active ? null : { kind: 'column', key, bucket });
  };
  let slide = '';
  if (selectedColumn) slide = 'performance-widget--detail';
  else if (back) slide = 'performance-slide--back';
  return <Surface ref={card} variant="default" className={`performance-widget min-w-0 ${slide}`}>
    {!selectedColumn ? <header className="performance-widget__header">
      <span className="performance-widget__icon performance-widget__icon--accent"><ChartNoAxesColumnIncreasing size={18}/></span>
      <span className="min-w-0"><h3 className="text-sm font-semibold">Situação por componente</h3></span>
    </header> : null}
    {selectedColumn ? <section className="performance-bars__detail" aria-label={`Estudantes por situação em ${selectedColumn.label}`} aria-live="polite">
      <header className="performance-bars__detail-header"><Button size="sm" variant="ghost" onPress={() => { setBack(true); onSelectionChange(null); }}><ArrowLeft size={15}/>Voltar ao gráfico</Button><span className="performance-bars__detail-title" data-bucket={selectedBucket}><h4>{selectedColumn.label}</h4><Chip size="sm" variant="soft" color={selectedBucket === 'above' ? 'accent' : 'danger'}>{selectedStudents.length} {bucketText}</Chip></span></header>
      <div className="performance-bars__student-groups"><section className={`performance-bars__student-group performance-bars__student-group--${selectedBucket}`} aria-label={`${selectedStudents.length} estudante(s) ${bucketText}`}>
        {selectedStudents.length > 0 ? <ul>{selectedStudents.map((student) => <li key={student.id}><button type="button" onClick={() => open(student.id, selectedColumn.offerId)}><small>{student.number}</small><span className="truncate">{student.name}</span></button></li>)}</ul> : <p>Nenhum estudante {bucketText} neste componente.</p>}
      </section></div>
    </section> : (
      <fieldset className="min-w-auto performance-bars" aria-label="Barras por componente curricular">
        {value.overview.columns.map((column, index) => {
          const offer = offers.get(column.offerId);
          const label = labels[index];
          const prior = previousPeriod === null ? undefined : before.get(column.offerId);
          const title = offer?.subject.label ?? column.label;
          return <div className="performance-bars__column" key={column.key}>
            <div className="performance-bars__plot">
              {(['above', 'below'] as const).map((bucket) => {
                const count = bucket === 'above' ? column.atOrAbove : column.below;
                const active = selection?.kind === 'column' && selection.key === column.key && selection.bucket === bucket;
                let priorCount;
                if (prior === undefined) {
                  priorCount = undefined;
                } else if (bucket === 'above') {
                  priorCount = prior.atOrAbove;
                } else {
                  priorCount = prior.below;
                }
                let change = '';
                if (priorCount !== undefined && priorCount !== count)
                  change = `, ${count > priorCount ? 'mais' : 'menos'} que no ${previousPeriod}º trimestre (${priorCount})`;
                return <button key={bucket} type="button" data-bar={`${column.key}:${bucket}`} className={`performance-bar performance-bar--${bucket} ${active ? 'performance-bar--selected' : ''}`}
                  style={{ height: `${Math.max(count === 0 ? 1.5 : 8, count / maximum * 86)}%` }} aria-pressed={active}
                  aria-label={`${title}: ${count} estudante(s) ${bucket === 'above' ? 'no mínimo ou acima' : 'abaixo do mínimo'}${change}`}
                  onClick={() => choose(column.key, bucket)}><span>{previousPeriod !== null
                    ? <DeltaV5 now={count} before={priorCount} bucket={bucket} period={previousPeriod}/> : null}{count}</span></button>;
              })}
            </div>
            <span className="performance-bars__label" title={title}>{label}</span>
            {column.incomplete + column.noShow + column.unscaled > 0 ? <span className="performance-bars__pending" title="Leituras ainda não classificadas">+{column.incomplete + column.noShow + column.unscaled}</span> : null}
          </div>;
        })}
      </fieldset>
    )}
  </Surface>;
}

function ClassPanoramaV5({ value, previous, selection, onSelectionChange, open }: {
  readonly value: PerformanceDashboardV5;
  readonly previous: PerformanceDashboardV5 | null;
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
  const period = analysis.matrix.period;
  const previousPeriod = typeof period === 'number' && period > 1 && previous ? period - 1 : null;
  const before = previousPeriod === null ? null : previous!.overview.students;
  const [rankingOpen, setRankingOpen] = useState(false);
  const [back, setBack] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (rankingOpen) card.current?.querySelector<HTMLElement>('.performance-bars__detail-header button')?.focus();
    else if (back) card.current?.querySelector<HTMLElement>('.performance-ranking__open')?.focus();
  }, [rankingOpen, back]);
  const partial = value.overview.ranking.some((entry) => entry.partial);
  if (rankingOpen) return <Surface ref={card} variant="default" className="performance-widget performance-widget--detail min-w-0">
    <section className="performance-bars__detail" aria-label="Classificação da turma" aria-live="polite">
      <header className="performance-bars__detail-header"><Button size="sm" variant="ghost" onPress={() => { setBack(true); setRankingOpen(false); }}><ArrowLeft size={15}/>Voltar ao gráfico</Button><span className="performance-bars__detail-title" data-bucket="above"><Chip size="sm" variant="soft" color="accent">Top 10</Chip></span></header>
      <div className="performance-bars__student-groups"><section className="performance-bars__student-group performance-bars__student-group--ranking">
        {value.overview.ranking.length > 0 ? <ul>{value.overview.ranking.map((entry, index) => {
          const student = students.get(entry.studentId);
          if (student === undefined) return null;
          return <li key={entry.studentId}><button type="button" className={withRed.has(entry.studentId) ? 'text-danger' : undefined} onClick={() => open(entry.studentId)} aria-label={`${index + 1}º lugar, ${student.name}, ${totalLabel}: ${gradeText(entry.totalMilli)}${entry.partial ? ', somatório parcial' : ''}`}>
            {index < 3 ? <Medal className={`performance-medal performance-medal--${['gold', 'silver', 'bronze'][index]}`} size={15} strokeWidth={2.25} aria-hidden/> : <small>{index + 1}</small>}<span className="truncate">{student.name}</span><strong className="tabular-nums">{gradeText(entry.totalMilli)}{entry.partial ? '*' : ''}</strong>
          </button></li>;
        })}</ul> : <p>Nenhum estudante tem valor numérico em todos os componentes deste recorte.</p>}
      </section></div>
      <footer className="performance-ranking__note">{totalLabel}{partial ? ' · * soma com componente parcial' : ''}</footer>
    </section>
  </Surface>;
  const choose = (group: 'allAtOrAbove' | 'withBelow' | 'pending') => {
    const active = selection?.kind === 'group' && selection.group === group;
    onSelectionChange(active ? null : { kind: 'group', group });
  };
  return <Surface ref={card} variant="default" className={`performance-widget performance-widget--panorama min-w-0 ${back ? 'performance-slide--back' : ''}`}>
    <header className="performance-widget__header">
      <span className="performance-widget__icon performance-widget__icon--accent"><PieChart size={18}/></span>
      <span><h3 className="text-sm font-semibold">Panorama da turma</h3></span>
      <button type="button" className="performance-ranking__open" aria-label="Classificação da turma: 10 maiores somatórios" onClick={() => { setBack(false); setRankingOpen(true); }}>
        <span className="flex items-center gap-1.5"><Chip size="sm" variant="soft" color="accent">Top 10</Chip><ChevronRight className="text-muted" size={15}/></span>
      </button>
    </header>
    <div className="performance-panorama">
      <div className="performance-donut" role="img" aria-label={`${stats.allAtOrAbove} estudantes com todos os componentes no mínimo ou acima, ${stats.withBelow} com pelo menos um abaixo e ${stats.pending} sem leitura classificada`}
        style={{ background: `conic-gradient(var(--performance-above) 0 ${good}%, var(--performance-below) ${good}% ${good + below}%, var(--performance-pending) ${good + below}% ${good + below + pending}%, var(--performance-empty) 0)` }}>
        <div className="performance-donut__center"><strong>{number.format(good)}%</strong><span>{stats.allAtOrAbove} de {stats.eligible}</span></div>
      </div>
      <div className="performance-panorama__counts" aria-label="Quantidades do panorama">
        {([
          ['allAtOrAbove', 'above', 'No mínimo ou acima', 'Todos no mínimo ou acima', 'com todos os componentes no mínimo ou acima'],
          ['withBelow', 'below', 'Abaixo do mínimo', 'Algum componente abaixo do mínimo', 'com algum componente abaixo do mínimo'],
          ['pending', 'pending', 'Sem classificação', pendingLabel, `: ${pendingLabel}`],
        ] as const).filter(([group]) => group !== 'pending' || stats.pending > 0).map(([group, tone, , title, spoken]) => <button key={group} type="button" className="performance-panorama__item" title={title}
          aria-label={`${stats[group]} estudante(s) ${spoken}`} aria-pressed={selection?.kind === 'group' && selection.group === group} onClick={() => choose(group)}>
          <i className={`performance-legend performance-legend--${tone}`}/><strong>{String(stats[group]).padStart(2, '0')}</strong>
          {before && previousPeriod !== null ? <DeltaV5 now={stats[group]} before={before[group]} bucket={tone === 'below' ? 'below' : 'above'} period={previousPeriod}/> : null}
        </button>)}
      </div>
    </div>

  </Surface>;
}

export function PerformanceDashboardWidgetsV5({ value, previous = null, selection, onSelectionChange, open }: {
  readonly value: PerformanceDashboardV5;
  readonly previous?: PerformanceDashboardV5 | null;
  readonly selection: PerformanceDashboardSelectionV5;
  readonly onSelectionChange: (selection: PerformanceDashboardSelectionV5) => void;
  readonly open: (studentId: number, offerId?: number) => void;
}) {
  return <div className="grid min-w-0 gap-4">
    <PerformanceKpisV5 value={value} selection={selection} onSelectionChange={onSelectionChange}/>
    <div className="performance-dashboard-grid">
      <ComponentBarsV5 value={value} previous={previous} selection={selection} onSelectionChange={onSelectionChange} open={open}/>
      <ClassPanoramaV5 value={value} previous={previous} selection={selection} onSelectionChange={onSelectionChange} open={open}/>
    </div>
  </div>;
}
