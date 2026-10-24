import { performanceResultCountsV2 } from '../../../../shared/gradebook-contracts/performance/relational-performance-v2';
import { Accordion, Button, Card, Chip, Meter } from '@heroui/react';
import { ArrowDown, ArrowRight, ArrowUp, BookOpen, MessageCircle, TrendingUp, TriangleAlert } from 'lucide-react';
import type { PerformanceAnalyticsV6 } from '../../../../shared/gradebook-contracts/performance/performance-analytics-v6';
import {
  AnalyticsCoverageV6,
  AnalyticsHintV6,
  AnalyticsPanelV6,
  AnalyticsRecoveryV6,
  AnalyticsTimelineV6,
} from './performance-analytics-charts-v6';
import { AnalyticsStudentComponentsV6 } from './performance-analytics-tables-v6';
import {
  analyticsDeltaV6 as delta,
  analyticsPercentV6 as percent,
} from './analytics-format-v6';

function Metric({
  label,
  value,
  caption,
  hint,
  icon: Icon,
}: Readonly<{
  label: string;
  value: string;
  caption: string;
  hint: string;
  icon: typeof BookOpen;
}>) {
  return (
    <Card className="min-w-0 border-t-2 border-t-accent/50">
      <Card.Header className="flex-row items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
          <Icon size={16} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 text-xs text-muted">{label}</span>
        <AnalyticsHintV6 label={`Sobre ${label}`}>{hint}</AnalyticsHintV6>
      </Card.Header>
      <Card.Content>
        <strong className="block text-3xl font-semibold tracking-[-0.04em] tabular-nums sm:text-4xl">
          {value}
        </strong>
      </Card.Content>
      <Card.Footer className="text-xs text-muted">{caption}</Card.Footer>
    </Card>
  );
}

function Dimension({
  label,
  caption,
  value,
}: Readonly<{
  label: string;
  caption: string;
  value: number | null;
}>) {
  return (
    <div className="grid gap-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <strong className="block text-sm">{label}</strong>
          <span className="text-xs text-muted">{caption}</span>
        </div>
        <strong className="text-xl tabular-nums">{percent(value)}</strong>
      </div>
      {value === null ? (
        <span className="text-xs text-muted">Sem notas suficientes neste recorte.</span>
      ) : (
        <Meter aria-label={label} value={value} maxValue={Math.max(100, value)}>
          <Meter.Track>
            <Meter.Fill />
          </Meter.Track>
        </Meter>
      )}
    </div>
  );
}

type Highlight = {
  key: string;
  label: string;
  value: string;
  offerId: number;
  icon: typeof ArrowUp;
};

export function PerformanceStudentLearningV1({
  value,
  studentId,
  onPeriod,
  onCell,
}: Readonly<{
  value: PerformanceAnalyticsV6;
  studentId: number;
  onPeriod: (period: 1 | 2 | 3) => void;
  onCell: (studentId: number, offerId?: number) => void;
}>) {
  const student = value.students.find((item) => item.student.id === studentId);
  if (!student) return null;
  const evidence = value.learning?.students.find((item) => item.studentId === studentId);
  const dimensions = evidence?.dimensions;
  const offers = new Map<number, string>(value.components.map((item) => [item.offer.id, item.offer.subject.label]));
  const complete = student.cells.filter(
    (cell) => performanceResultCountsV2(cell.result.state) && cell.percent !== null,
  );
  const compared = complete.filter((cell) => cell.deltaPP !== null);
  const best = [...complete].sort((a, b) => (b.percent ?? -Infinity) - (a.percent ?? -Infinity))[0];
  const lowest = [...complete].sort((a, b) => (a.percent ?? Infinity) - (b.percent ?? Infinity))[0];
  const rise = [...compared].sort((a, b) => (b.deltaPP ?? -Infinity) - (a.deltaPP ?? -Infinity))[0];
  const fall = [...compared].sort((a, b) => (a.deltaPP ?? Infinity) - (b.deltaPP ?? Infinity))[0];
  const highlights: Highlight[] = [
    best && { key: 'best', label: 'Melhor resultado atual', value: `${offers.get(best.offerId) ?? 'Componente'} · ${percent(best.percent)}`, offerId: best.offerId, icon: ArrowUp },
    lowest && { key: 'lowest', label: 'Menor resultado atual', value: `${offers.get(lowest.offerId) ?? 'Componente'} · ${percent(lowest.percent)}`, offerId: lowest.offerId, icon: ArrowDown },
    rise && rise.deltaPP !== null && rise.deltaPP > 0 && { key: 'rise', label: 'Maior avanço', value: `${offers.get(rise.offerId) ?? 'Componente'} · ${delta(rise.deltaPP)}`, offerId: rise.offerId, icon: TrendingUp },
    fall && fall.deltaPP !== null && fall.deltaPP < 0 && { key: 'fall', label: 'Maior queda', value: `${offers.get(fall.offerId) ?? 'Componente'} · ${delta(fall.deltaPP)}`, offerId: fall.offerId, icon: ArrowDown },
  ].filter((item): item is Highlight => Boolean(item));
  const reference = student.summary.movement.reference;
  const recurring = evidence?.recurring ?? [];
  const participation = evidence?.participation;
  const periodName = value.period === 'annual' ? 'Ano letivo' : `${value.period}º trimestre`;

  return (
    <div className="grid min-w-0 gap-4" data-testid="performance-student-learning-v1">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric
          label="Desempenho atual"
          value={percent(student.summary.result.mean)}
          caption={`${student.summary.complete} componentes com resultado · ${periodName}`}
          hint="Média das notas finais calculadas dos componentes neste período. Mantém os pesos da escola e não usa nota ausente como zero."
          icon={BookOpen}
        />
        <Metric
          label="Evolução trimestral"
          value={delta(student.summary.movement.meanDeltaPP)}
          caption={reference ? `Em relação ao ${reference}º trimestre` : 'Disponível a partir do 2º trimestre'}
          hint="Compara os mesmos componentes deste aluno nos dois trimestres. Instrumento em branco conta como não feito."
          icon={TrendingUp}
        />
        <Metric
          label="Atenção recorrente"
          value={evidence?.recurrenceAssessed ? String(recurring.length) : '—'}
          caption={`${student.summary.below} componentes abaixo da referência agora`}
          hint="Conta componentes com dificuldade repetida entre trimestres ou em mais de uma nota do período. Uma nota baixa isolada não basta."
          icon={TriangleAlert}
        />
        <Metric
          label="Participação avaliada"
          value={percent(participation?.percent ?? null)}
          caption={participation?.deltaPP != null ? `${delta(participation.deltaPP)} desde T${reference}` : `${participation?.components ?? 0} componentes com participação`}
          hint="Resume as notas de participação dadas pelos professores. Já faz parte do qualitativo e não é somada novamente à nota."
          icon={MessageCircle}
        />
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <AnalyticsTimelineV6 summary={student.summary} onPeriod={onPeriod} schoolLanguage />
        <AnalyticsPanelV6
          title="Quantitativo × qualitativo"
          action={<AnalyticsHintV6 label="Sobre Quantitativo e qualitativo do aluno">Compara os mesmos componentes deste aluno. Quantitativo: as duas avaliações, antes da recuperação paralela. Qualitativo: atividades e participação. A diferença não explica, sozinha, sua causa.</AnalyticsHintV6>}
          footer={<span>Componentes comparados: {dimensions?.components ?? 0}.</span>}
        >
          <div className="grid gap-5 py-1">
            <Dimension label="Quantitativo" caption="Duas avaliações · antes da paralela" value={dimensions?.quantitativePercent ?? null} />
            <Dimension label="Qualitativo" caption="Atividades + participação" value={dimensions?.qualitativePercent ?? null} />
            <div className="rounded-xl bg-default p-3 text-xs">
              {dimensions?.gapPP == null ? (
                <span className="text-muted">Ainda sem base comum suficiente para comparar.</span>
              ) : (
                <><strong className="mr-2 tabular-nums">{delta(dimensions.gapPP)}</strong><span className="text-muted">qualitativo menos quantitativo</span></>
              )}
            </div>
          </div>
        </AnalyticsPanelV6>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <AnalyticsPanelV6
          title="Onde olhar primeiro"
          action={<AnalyticsHintV6 label="Sobre Onde olhar primeiro">Destaques das notas atuais e das mudanças entre trimestres. Servem para abrir o detalhe, não para diagnosticar o aluno.</AnalyticsHintV6>}
          footer={evidence?.parallelImprovements ? <span>{evidence.parallelImprovements} resultado(s) melhoraram com recuperação paralela.</span> : undefined}
        >
          <div className="grid gap-1">
            {highlights.map((item) => (
              <Button
                key={item.key}
                variant="ghost"
                className="h-auto min-h-12 justify-start gap-3 whitespace-normal px-2 py-2 text-left"
                onPress={() => onCell(studentId, item.offerId)}
              >
                <item.icon size={16} className="shrink-0 text-accent" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-muted">{item.label}</span>
                  <strong className="block text-sm">{item.value}</strong>
                </span>
                <ArrowRight size={15} className="shrink-0 text-muted" aria-hidden="true" />
              </Button>
            ))}
            {!highlights.length ? <p className="py-4 text-sm text-muted">Ainda não há resultados suficientes para destacar.</p> : null}
          </div>
        </AnalyticsPanelV6>

        <AnalyticsPanelV6
          title="Dificuldades que se repetem"
          action={<AnalyticsHintV6 label="Sobre Dificuldades que se repetem">Mostra somente componentes em que a evidência se repetiu. Não transforma uma nota baixa isolada em dificuldade persistente.</AnalyticsHintV6>}
        >
          <div className="grid gap-2">
            {recurring.map((item) => (
              <Button
                key={item.offerId}
                variant="ghost"
                className="h-auto min-h-12 justify-between gap-3 whitespace-normal px-2 py-2 text-left"
                onPress={() => onCell(studentId, item.offerId)}
              >
                <span className="min-w-0">
                  <strong className="block text-sm">{offers.get(item.offerId) ?? 'Componente'}</strong>
                  <span className="block text-xs text-muted">
                    {item.consecutiveTerms.length ? 'Abaixo da referência em trimestres consecutivos' : 'Mais de uma nota abaixo da referência no período'}
                  </span>
                </span>
                <ArrowRight size={15} className="shrink-0 text-muted" aria-hidden="true" />
              </Button>
            ))}
            {!recurring.length ? (
              <p className="py-4 text-sm text-muted">
                {evidence?.recurrenceAssessed ? 'Nenhuma dificuldade recorrente identificada neste recorte.' : 'Ainda não há notas suficientes para avaliar recorrência.'}
              </p>
            ) : null}
          </div>
        </AnalyticsPanelV6>
      </div>

      <AnalyticsStudentComponentsV6 value={value} studentId={studentId} onCell={onCell} />

      {value.period === 'annual' ? (
        <div className="flex flex-wrap gap-2">
          <Chip variant="soft">Resultado calculado: {student.annualResult?.label ?? 'Indisponível'}</Chip>
          {student.councilDecision ? <Chip variant="soft">Conselho: {student.councilDecision.label}</Chip> : null}
        </div>
      ) : null}

      <Accordion className="rounded-2xl border border-separator bg-surface px-4" allowsMultipleExpanded>
        <Accordion.Item id="student-recovery">
          <Accordion.Heading>
            <Accordion.Trigger>
              <span>Recuperação · detalhes</span>
              <Accordion.Indicator />
            </Accordion.Trigger>
          </Accordion.Heading>
          <Accordion.Panel>
            <Accordion.Body>
              <AnalyticsRecoveryV6 summary={student.summary} />
            </Accordion.Body>
          </Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item id="student-quality">
          <Accordion.Heading>
            <Accordion.Trigger>
              <span>Base dos indicadores · qualidade dos dados</span>
              <Accordion.Indicator />
            </Accordion.Trigger>
          </Accordion.Heading>
          <Accordion.Panel>
            <Accordion.Body>
              <AnalyticsCoverageV6 summary={student.summary} partial={student.cells.filter((cell) => cell.result.state === 'partial').length} />
            </Accordion.Body>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      <footer className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        <span>Referência: {percent(value.minimumPercent)}</span>
        <span>{periodName}</span>
        <span>Notas calculadas para acompanhamento, não diagnóstico.</span>
      </footer>
    </div>
  );
}
