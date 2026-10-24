import { useId, type ReactNode } from 'react';
import { Button, Card, Chip, Label, Meter, Tooltip } from '@heroui/react';
import { Info } from 'lucide-react';
import type { PerformanceAnalyticsSummaryV6 } from '../../../../shared/gradebook-contracts/performance/performance-analytics-v6';
import {
  analyticsNumberV6 as number,
  analyticsPercentV6 as percent,
  analyticsDeltaV6 as delta,
  analyticsGradeV6 as grade,
} from './analytics-format-v6';

export function AnalyticsPanelV6({
  title,
  children,
  action,
  footer,
}: Readonly<{
  title: string;
  children: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
}>) {
  return (
    <Card className="min-w-0">
      <Card.Header className="flex-row items-center justify-between gap-3">
        <Card.Title>{title}</Card.Title>
        {action}
      </Card.Header>
      <Card.Content className="min-w-0">{children}</Card.Content>
      {footer ? <Card.Footer className="flex-wrap text-xs text-muted">{footer}</Card.Footer> : null}
    </Card>
  );
}
export function AnalyticsHintV6({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <Tooltip delay={150}>
      <Tooltip.Trigger
        aria-label={label}
        className="inline-flex cursor-help items-center text-muted"
        tabIndex={0}
      >
        <Info size={14} />
      </Tooltip.Trigger>
      <Tooltip.Content className="analytics-hint">{children}</Tooltip.Content>
    </Tooltip>
  );
}
/** What a card shows, the steps behind its number, the result here, and what it does not mean. */
export function AnalyticsHintBodyV6({
  what,
  steps,
  result,
  note,
}: Readonly<{
  what: ReactNode;
  steps?: readonly ReactNode[];
  result?: ReactNode;
  note?: ReactNode;
}>) {
  return (
    <div className="analytics-hint__body">
      <p>{what}</p>
      {steps?.length ? (
        <div className="analytics-hint__calc">
          <span>Como é calculado</span>
          <ol>
            {steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
          {result ? <p className="analytics-hint__result">{result}</p> : null}
        </div>
      ) : null}
      {note ? <p className="analytics-hint__note">{note}</p> : null}
    </div>
  );
}
export function AnalyticsKpisV6({
  summary,
  individual = false,
}: Readonly<{
  summary: PerformanceAnalyticsSummaryV6;
  individual?: boolean;
}>) {
  const values = [
    {
      label: 'Aproveitamento',
      value: percent(summary.result.mean),
      sub: `${summary.result.n}/${summary.readings} resultados considerados`,
      hint: 'Média dos percentuais dos resultados. Instrumento em branco conta como não feito.',
    },
    {
      label: 'Mediana',
      value: percent(summary.result.median),
      sub: `Dispersão ${summary.result.deviation === null ? '—' : number(summary.result.deviation) + ' p.p.'}`,
      hint: 'Valor central dos percentuais dos resultados. Dispersão: desvio-padrão populacional.',
    },
    {
      label: individual ? 'Componentes abaixo' : 'Alunos abaixo',
      value: String(individual ? summary.below : summary.studentsBelow),
      sub: individual
        ? `${summary.complete}/${summary.readings} resultados`
        : `${summary.students} alunos considerados`,
      hint: 'Ao menos um resultado abaixo do limite.',
    },
    {
      label: 'Notas lançadas',
      value: percent(summary.coverage.percent),
      sub: `${summary.coverage.recorded}/${summary.coverage.expected} instrumentos`,
      hint: 'Instrumentos ativos regulares. Zero registrado participa; branco não é zero. Prova paralela é separada.',
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {values.map((item) => (
        <Card key={item.label}>
          <Card.Header className="flex-row items-center justify-between gap-2">
            <span className="text-xs text-muted">{item.label}</span>
            <AnalyticsHintV6 label={`Sobre ${item.label}`}>{item.hint}</AnalyticsHintV6>
          </Card.Header>
          <Card.Content>
            <strong className="block text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">
              {item.value}
            </strong>
          </Card.Content>
          <Card.Footer className="text-xs text-muted tabular-nums">{item.sub}</Card.Footer>
        </Card>
      ))}
    </div>
  );
}
/** Native SVG visualizations inspired by shadcn's area/bar compositions. HeroUI owns every control.
 * Geometry only: values, populations and comparisons come from the server's V6 projection. */
export function AnalyticsTimelineV6({
  summary,
  onPeriod,
  schoolLanguage = false,
}: Readonly<{
  summary: PerformanceAnalyticsSummaryV6;
  onPeriod: (term: 1 | 2 | 3) => void;
  schoolLanguage?: boolean;
}>) {
  const gradient = useId().replaceAll(':', '');
  const values = summary.timeline;
  const ceiling = Math.max(100, ...values.map((item) => item.mean ?? 0));
  const y = (value: number) => 186 - (value / ceiling) * 148;
  const x = (index: number) => 60 + index * 225;
  const segments: { index: number; value: number }[][] = [];
  for (const [index, value] of values.entries()) {
    if (value.mean === null) {
      segments.push([]);
      continue;
    }
    if (!segments.length) segments.push([]);
    segments.at(-1)!.push({ index, value: value.mean });
  }
  return (
    <AnalyticsPanelV6
      title="Trajetória trimestral"
      action={
        <div className="flex items-center gap-2">
          {summary.movement.reference ? (
            <Chip size="sm" variant="soft">
              {delta(summary.movement.meanDeltaPP)} · T{summary.movement.reference}
            </Chip>
          ) : null}
          {schoolLanguage ? <AnalyticsHintV6 label="Sobre Trajetória trimestral"><AnalyticsHintBodyV6 what="A nota média da turma em cada trimestre, de 0 a 100." steps={['Em cada trimestre, cada nota final vira uma porcentagem. Exemplo: 7 em 10 vale 70%.', 'Somam-se as porcentagens e divide-se pelo número de notas daquele trimestre.']} note="O número no canto é a média das diferenças aluno por aluno; pode ser um pouco diferente de subtrair um ponto do outro." /></AnalyticsHintV6> : null}
        </div>
      }
      footer={
        schoolLanguage ? <span>Notas dos componentes em cada trimestre. Clique no período para consultar.</span> : <>
          <span>{summary.movement.n} pares comparáveis</span>
          <span className="ml-auto">Resultados considerados</span>
        </>
      }
    >
      <svg viewBox="0 0 570 224" className="analytics-timeline h-52 w-full" aria-hidden="true">
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.015" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line x1="45" x2="536" y1={y(ceiling * fraction)} y2={y(ceiling * fraction)} stroke="var(--separator)" strokeDasharray="3 5" />
            <text x="32" y={y(ceiling * fraction) + 4} textAnchor="end" fill="var(--muted)" fontSize="11">{number(ceiling * fraction)}</text>
          </g>
        ))}
        {segments.filter((segment) => segment.length > 1).map((segment) => {
          const path = segment.map((point, index) => `${index ? 'L' : 'M'} ${x(point.index)} ${y(point.value)}`).join(' ');
          return <g key={segment[0]!.index}>
            <path d={`${path} L ${x(segment.at(-1)!.index)} 186 L ${x(segment[0]!.index)} 186 Z`} fill={`url(#${gradient})`} />
            <path className="analytics-line" pathLength={1} d={path} stroke="var(--accent)" strokeWidth="3" fill="none" strokeLinejoin="round" />
          </g>;
        })}
        {values.map((item, index) => (
          <g key={item.term}>
            {item.mean !== null ? <>
              <circle cx={x(index)} cy={y(item.mean)} r="5" fill="var(--accent)" stroke="var(--surface)" strokeWidth="3" />
              <text x={x(index)} y={y(item.mean) - 15} textAnchor="middle" fill="var(--foreground)" fontSize="15" fontWeight="600">{percent(item.mean)}</text>
            </> : <text x={x(index)} y="168" textAnchor="middle" fill="var(--muted)">—</text>}
            <text x={x(index)} y="214" textAnchor="middle" fill="var(--muted)" fontSize="12">T{item.term}</text>
          </g>
        ))}
      </svg>
      <div className="grid grid-cols-3 gap-2">
        {values.map((item) => (
          <Button key={item.term} variant="ghost" size="sm" className="h-auto flex-col gap-1 py-2" onPress={() => onPeriod(item.term)} aria-label={`Consultar ${item.term}º trimestre: ${percent(item.mean)}, ${item.n} ${schoolLanguage ? 'resultados' : 'leituras'}`}>
            <span className="text-xs">T{item.term} · {percent(item.mean)}</span>
            <span className="text-[11px] text-muted">{schoolLanguage ? `${item.n} resultados` : `n = ${item.n}`}</span>
          </Button>
        ))}
      </div>
    </AnalyticsPanelV6>
  );
}
export function AnalyticsDistributionV6({ summary }: Readonly<{ summary: PerformanceAnalyticsSummaryV6 }>) {
  const maximum = Math.max(1, ...summary.distribution.map((bin) => bin.count));
  return (
    <AnalyticsPanelV6 title="Distribuição" footer={<><span>{summary.result.n} resultados considerados</span><span className="ml-auto">Mín. {percent(summary.result.min)} · Máx. {percent(summary.result.max)}</span></>}>
      <figure aria-label="Distribuição por faixa de aproveitamento">
        <svg viewBox="0 0 570 225" className="h-52 w-full" aria-hidden="true">
          {[0, 0.5, 1].map((fraction) => <line key={fraction} x1="10" x2="560" y1={184 - fraction * 140} y2={184 - fraction * 140} stroke="var(--separator)" strokeDasharray="3 5" />)}
          {summary.distribution.map((bin, index) => {
            const h = (bin.count / maximum) * 140, x = 16 + index * 92;
            return <g key={bin.label}>
              <rect x={x} y={184 - h} width="66" height={h} rx="6" fill="var(--accent)" opacity={index === 5 ? 0.45 : 0.85} />
              <text x={x + 33} y={174 - h} textAnchor="middle" fill="var(--foreground)" fontSize="15" fontWeight="600">{bin.count}</text>
              <text x={x + 33} y="209" textAnchor="middle" fill="var(--muted)" fontSize="11">{bin.label}</text>
            </g>;
          })}
        </svg>
        <figcaption className="sr-only">{summary.distribution.map((bin) => `${bin.label}: ${bin.count}`).join('; ')}</figcaption>
      </figure>
    </AnalyticsPanelV6>
  );
}
export function AnalyticsCompositionV6({ summary }: Readonly<{ summary: PerformanceAnalyticsSummaryV6 }>) {
  const share = summary.composition.quantitativeShare;
  const circumference = 2 * Math.PI * 60;
  return (
    <AnalyticsPanelV6 title="Quantitativo × qualitativo" footer={<><span>Diferença pareada</span><strong className="ml-auto text-foreground tabular-nums">{delta(summary.dimensionGap.meanPP)}</strong><AnalyticsHintV6 label="Sobre a diferença entre dimensões">Qualitativo menos quantitativo, nos mesmos {summary.dimensionGap.n} pares de resultados.</AnalyticsHintV6></>}>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3">
        <svg viewBox="0 0 160 180" className="mx-auto h-44 w-full max-w-48" role="img" aria-label={`Participação nos pontos: quantitativo ${percent(share)}, qualitativo ${percent(summary.composition.qualitativeShare)}`}>
          <circle cx="80" cy="80" r="60" fill="none" stroke="var(--separator)" strokeWidth="15" />
          {share !== null ? <>
            <circle cx="80" cy="80" r="60" fill="none" stroke="var(--danger)" strokeWidth="15" opacity="0.75" />
            <circle cx="80" cy="80" r="60" fill="none" stroke="var(--accent)" strokeWidth="15" strokeDasharray={`${(share / 100) * circumference} ${circumference}`} transform="rotate(-90 80 80)" />
          </> : null}
          <text x="80" y="79" textAnchor="middle" fill="var(--foreground)" fontSize="23" fontWeight="600">{percent(share)}</text>
          <text x="80" y="99" textAnchor="middle" fill="var(--muted)" fontSize="10">dos pontos · quant.</text>
          <text x="80" y="168" textAnchor="middle" fill="var(--muted)" fontSize="11">{summary.composition.n} pares de resultados</text>
        </svg>
        <div className="grid gap-6"><div><span className="text-xs text-muted">Quantitativo</span><strong className="block text-2xl font-semibold tabular-nums">{percent(summary.quantitative.mean)}</strong><span className="text-xs text-muted">n = {summary.quantitative.n}</span></div><div><span className="text-xs text-muted">Qualitativo</span><strong className="block text-2xl font-semibold tabular-nums">{percent(summary.qualitative.mean)}</strong><span className="text-xs text-muted">n = {summary.qualitative.n}</span></div></div>
      </div>
    </AnalyticsPanelV6>
  );
}
export function AnalyticsBarsV6({ items, onSelect }: Readonly<{
  items: readonly { id: number; label: string; value: number | null; below?: boolean; secondary?: string }[];
  onSelect: (id: number) => void;
}>) {
  const maximum = Math.max(100, ...items.map((item) => item.value ?? 0));
  return <div className="grid gap-4">{items.map((item) => <div key={item.id} className="grid gap-1"><div className="flex items-center justify-between gap-3"><Button size="sm" variant="ghost" className="h-auto min-w-0 justify-start px-0 py-1 text-left" onPress={() => onSelect(item.id)}><span className="truncate">{item.label}</span></Button><strong className="shrink-0 text-base tabular-nums">{percent(item.value)}</strong></div><Meter aria-label={`${item.label}: aproveitamento`} value={item.value ?? 0} maxValue={maximum} color={item.below ? 'danger' : 'accent'}><Meter.Track><Meter.Fill /></Meter.Track></Meter>{item.secondary ? <span className="text-[11px] text-muted">{item.secondary}</span> : null}</div>)}</div>;
}
export function AnalyticsRecoveryV6({ summary }: Readonly<{ summary: PerformanceAnalyticsSummaryV6 }>) {
  const recovery = summary.recovery;
  const items = [
    ['REC aplicável', String(recovery.applicable)], ['REC lançada', String(recovery.recorded)],
    ['REC pendente', String(recovery.pending)], ['N/C', String(recovery.noShow)],
    ['R/R', String(recovery.repeatFailure)], ['Variação média · pontos', grade(recovery.meanGainMilli)],
  ];
  return <AnalyticsPanelV6 title="Recuperação" action={<AnalyticsHintV6 label="Sobre recuperação">Contagem por aluno, componente e trimestre. Aplicabilidade e substituição vêm do motor existente.</AnalyticsHintV6>} footer={<><span>Paralela aplicada: {summary.parallel.applied}/{summary.parallel.applicable}</span><span className="ml-auto">Aplicabilidade indefinida: {recovery.unknown}</span></>}><dl className="grid grid-cols-3 gap-x-3 gap-y-5">{items.map(([label, value]) => <div key={label}><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd></div>)}</dl></AnalyticsPanelV6>;
}
export function AnalyticsCoverageV6({
  summary,
  partial,
}: Readonly<{
  summary: PerformanceAnalyticsSummaryV6;
  /** Results with a blank instrument, counted from the cells of this scope. */
  partial: number;
}>) {
  return <AnalyticsPanelV6 title="Qualidade da leitura" footer={<><span>Referências da fonte: {summary.source.recorded}</span><span className="ml-auto">Divergências: {summary.source.different}/{summary.source.comparable}</span></>}><Meter value={summary.coverage.percent ?? 0} aria-label="Cobertura dos instrumentos" color="accent"><Label>Notas lançadas</Label><Meter.Output>{percent(summary.coverage.percent)}</Meter.Output><Meter.Track><Meter.Fill /></Meter.Track></Meter><dl className="mt-5 grid grid-cols-3 gap-3">{[
    ['Resultados considerados', summary.complete], ['Desses, com instrumento em branco', partial], ['Sem nota', summary.missing],
    ['Indisponíveis', summary.unavailable], ['Zeros registrados', summary.coverage.zeros], ['Lançamentos ausentes', summary.coverage.missing],
  ].map(([label, value]) => <div key={label}><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd></div>)}</dl></AnalyticsPanelV6>;
}
