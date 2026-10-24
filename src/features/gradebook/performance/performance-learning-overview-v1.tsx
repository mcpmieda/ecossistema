import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Accordion, Alert, Button, Card, Chip, Meter, SearchField, Table } from '@heroui/react';
import { ArrowRight, BookOpen, MessageCircle, TrendingDown, TrendingUp, Users } from 'lucide-react';
import type { PerformanceAnalyticsV6 } from '../../../../shared/gradebook-contracts/performance/performance-analytics-v6';
import {
  AnalyticsBarsV6, AnalyticsCoverageV6, AnalyticsHintBodyV6 as Hint, AnalyticsHintV6, AnalyticsPanelV6,
  AnalyticsRecoveryV6, AnalyticsTimelineV6,
} from './performance-analytics-charts-v6';
import { analyticsPercentV6 as percent, analyticsDeltaV6 as delta, analyticsNumberV6 as number } from './analytics-format-v6';
import { LinkedStudentPhotoAvatarV1 } from '../../student-photos/linked-student-photo-avatar-v1';
import './performance-learning-v1.css';
import '../../student-portal-admin/shared/student-avatar-v1.css';

type Filter = 'all' | 'attention' | 'rising' | 'falling' | 'compared' | 'participation' |
  'above' | 'below' | 'pending' | 'below-up' | 'below-down' | 'above-down' | 'recovery';
const LABELS: Record<Filter, string> = {
  all: 'Todos os alunos', attention: 'Atenção recorrente', rising: 'Maiores evoluções',
  falling: 'Maiores quedas', compared: 'Alunos com comparação', participation: 'Participação por aluno',
  above: 'Na referência em todos os componentes', below: 'Abaixo em algum componente',
  pending: 'Ainda sem conclusão', 'below-up': 'Abaixo, mas melhorando',
  'below-down': 'Abaixo e com queda', 'above-down': 'Na referência, mas com queda', recovery: 'Melhoraram com a paralela',
};
function Panel({ title, hint, children, footer }: Readonly<{
  title: string; hint: ReactNode; children: ReactNode; footer?: ReactNode;
}>) {
  return <AnalyticsPanelV6 title={title} action={<AnalyticsHintV6 label={`Sobre ${title}`}>{hint}</AnalyticsHintV6>} footer={footer}>{children}</AnalyticsPanelV6>;
}
function MetricBar({ label, caption, value, tone }: Readonly<{ label: string; caption: string; value: number | null; tone: string }>) {
  return <div className={`learning-dimension learning-tone--${tone}`}>
    <div className="learning-inline"><div><strong>{label}</strong><span className="learning-muted">{caption}</span></div><b>{percent(value)}</b></div>
    {value !== null ? <Meter aria-label={label} value={value} maxValue={Math.max(100, value)}><Meter.Track><Meter.Fill /></Meter.Track></Meter> : <span className="learning-muted">Sem notas suficientes para comparar.</span>}
  </div>;
}

const FILTER_BUTTON = { attention: 'Acompanhar', rising: 'Evoluções', falling: 'Quedas', all: 'Todos' } as const;

/** Which group of grades is ahead, in a sentence. */
function gapText(gapPP: number) {
  if (gapPP === 0) return 'Mesmo desempenho nos dois grupos.';
  return `${gapPP > 0 ? 'Qualitativo' : 'Quantitativo'} acima nesta comparação.`;
}

export function PerformanceLearningOverviewV1({ value, onStudent, onComponent, onPeriod, onNotes }: Readonly<{
  value: PerformanceAnalyticsV6;
  onStudent: (id: number, offerId?: number) => void;
  onComponent: (offerId: number) => void;
  onPeriod: (term: 1 | 2 | 3) => void;
  onNotes: (offerId: number) => void;
}>) {
  const [filter, setFilter] = useState<Filter>('attention');
  const [search, setSearch] = useState('');
  const listHeading = useRef<HTMLHeadingElement>(null);
  const learning = value.learning;
  const rows = useMemo(() => {
    const evidence = new Map(value.learning?.students.map((item) => [item.studentId, item]) ?? []);
    return value.students.map((student) => ({ ...student, evidence: evidence.get(student.student.id) }));
  }, [value]);
  const reference = value.summary.movement.reference;
  const matches = (row: (typeof rows)[number], selected: Filter) => {
    const change = row.summary.movement.meanDeltaPP;
    const below = row.summary.below > 0;
    const above = row.summary.studentsAtOrAbove === 1;
    switch (selected) {
      case 'attention': return (row.evidence?.recurring.length ?? 0) > 0;
      case 'rising': return change !== null && change > 0;
      case 'falling': return change !== null && change < 0;
      case 'compared': return change !== null;
      case 'participation': return row.evidence?.participation.percent != null;
      case 'above': return above;
      case 'below': return below;
      case 'pending': return !below && !above;
      case 'below-up': return below && change !== null && change > 0;
      case 'below-down': return below && change !== null && change < 0;
      case 'above-down': return above && change !== null && change < 0;
      case 'recovery': return (row.evidence?.parallelImprovements ?? 0) > 0;
      default: return true;
    }
  };
  const count = (selected: Filter) => rows.filter((row) => matches(row, selected)).length;
  const select = (selected: Filter) => { setFilter(selected); setSearch(''); listHeading.current?.focus(); };
  const query = search.trim().toLocaleLowerCase('pt-BR');
  const selectedRows = rows.filter((row) => matches(row, filter));
  const visibleRows = selectedRows.filter((row) => !query || row.student.name.toLocaleLowerCase('pt-BR').includes(query) || String(row.student.number) === query)
    .sort((a, b) => {
      if (filter === 'rising') return (b.summary.movement.meanDeltaPP ?? 0) - (a.summary.movement.meanDeltaPP ?? 0) || a.student.number - b.student.number;
      if (filter === 'falling' || filter === 'below-down' || filter === 'above-down') return (a.summary.movement.meanDeltaPP ?? 0) - (b.summary.movement.meanDeltaPP ?? 0) || a.student.number - b.student.number;
      if (filter === 'attention') return (b.evidence?.recurring.length ?? 0) - (a.evidence?.recurring.length ?? 0) || (a.summary.movement.meanDeltaPP ?? 0) - (b.summary.movement.meanDeltaPP ?? 0) || a.student.number - b.student.number;
      return a.student.number - b.student.number;
    });
  const assessed = learning?.students.filter((item) => item.recurrenceAssessed).length ?? 0;
  const componentLabels = new Map<number, string>(value.components.map((item) => [item.offer.id, item.offer.subject.label]));
  const instruments = new Map(value.components.flatMap((component) => component.instruments.map((instrument) => [instrument.key, { ...instrument, offerId: component.offer.id, subject: component.offer.subject.label }] as const)));
  const reviewActivities = (learning?.activitiesToReview ?? []).map((key) => instruments.get(key)).filter((item): item is NonNullable<typeof item> => item !== undefined);
  const periodName = value.period === 'annual' ? 'Ano letivo' : `${value.period}º trimestre`;
  const kpis = [
    { title: 'Desempenho médio', value: percent(value.summary.result.mean), caption: `${value.students.filter((item) => item.summary.complete > 0).length} alunos com resultado · ${periodName}`, icon: BookOpen, tone: 'accent', filter: 'all' as Filter,
      hint: <Hint what="A nota média da turma, de 0 a 100." steps={['Cada nota final vira uma porcentagem. Exemplo: 7 em 10 vale 70%.', 'Somam-se as porcentagens de todas as notas finais da turma.', 'Divide-se a soma pelo número de notas.']} result={`Nesta turma: ${value.summary.result.n} notas somadas ÷ ${value.summary.result.n} = ${percent(value.summary.result.mean)}.`} note="Atividade ou prova em branco conta como não feita." /> },
    { title: 'Evolução trimestral', value: delta(value.summary.movement.meanDeltaPP), caption: reference ? `Em relação ao ${reference}º trimestre` : 'Disponível a partir do 2º trimestre', icon: TrendingUp, tone: 'accent', filter: 'compared' as Filter,
      hint: <Hint what="Mostra se as notas subiram ou caíram desde o trimestre anterior." steps={['Para cada aluno, em cada disciplina, compara-se a nota deste trimestre com a do anterior. Exemplo: 60% antes e 70% agora dá +10 pontos.', 'Tira-se a média de todas essas diferenças.']} result={reference ? `Nesta turma: ${value.summary.movement.n} comparações com o ${reference}º trimestre, média de ${delta(value.summary.movement.meanDeltaPP)}.` : undefined} note="Atividade em branco conta como não feita. Número positivo: a turma subiu. Negativo: caiu." /> },
    { title: 'Alunos em evolução', value: reference && count('compared') ? String(count('rising')) : '—', caption: reference ? `de ${count('compared')} alunos com comparação` : 'Ainda sem trimestre anterior', icon: Users, tone: 'success', filter: 'rising' as Filter,
      hint: <Hint what="Quantos alunos melhoraram desde o trimestre anterior." steps={['Para cada aluno, tira-se a média das diferenças entre as notas deste trimestre e as do anterior.', 'Se essa média for maior que zero, o aluno conta como em evolução.']} result={reference ? `Nesta turma: ${count('rising')} de ${count('compared')} alunos comparados.` : undefined} note="Trimestre em branco conta como zero na comparação." /> },
    { title: 'Atenção recorrente', value: learning && assessed ? String(count('attention')) : '—', caption: `${assessed} alunos com base para analisar`, icon: TrendingDown, tone: 'warning', filter: 'attention' as Filter,
      hint: <Hint what="Alunos que ficaram abaixo do mínimo mais de uma vez na mesma disciplina." steps={['Olha-se cada disciplina do aluno, uma por vez.', `O aluno entra na conta se ficou abaixo de ${percent(value.minimumPercent)} em dois trimestres seguidos nessa disciplina.`, 'Ou se, no mesmo trimestre, ficou abaixo em 2 ou mais atividades (quando há pelo menos 3 com nota).']} result={`Nesta turma: ${learning && assessed ? count('attention') : '—'} de ${assessed} alunos analisados.`} note="Nota de participação não entra nessa conta." /> },
  ];
  const distribution: { key: Filter; label: string; count: number; tone: string }[] = [
    { key: 'above', label: 'Na referência em todos', count: count('above'), tone: 'success' },
    { key: 'below', label: 'Abaixo em algum componente', count: count('below'), tone: 'warning' },
    { key: 'pending', label: 'Ainda sem conclusão', count: count('pending'), tone: 'muted' },
  ];
  let emptyText = 'Nenhum aluno neste grupo.';
  if (query) emptyText = 'Nenhum aluno encontrado nesta busca.';
  else if (filter === 'attention' && !assessed) emptyText = 'Ainda não há notas suficientes para avaliar a recorrência.';
  return <div className="learning-overview" data-testid="performance-learning-overview-v1">
    <div className="learning-kpis learning-enter">
      {kpis.map((item) => <Card key={item.title} className={`learning-kpi learning-tone--${item.tone}`}>
        <Card.Header><span className="learning-kpi-icon"><item.icon size={17} aria-hidden="true" /></span><span>{item.title}</span><AnalyticsHintV6 label={`Sobre ${item.title}`}>{item.hint}</AnalyticsHintV6></Card.Header>
        <Card.Content><Button variant="ghost" className="learning-kpi-button" onPress={() => select(item.filter)} aria-label={`Ver alunos: ${item.title}`}><strong>{item.value}</strong><ArrowRight size={16} aria-hidden="true" /></Button><span className="learning-muted">{item.caption}</span></Card.Content>
      </Card>)}
    </div>
    {!learning ? <Alert><Alert.Content><Alert.Title>Indicadores complementares ainda indisponíveis.</Alert.Title><Alert.Description>Não há dados suficientes nesta resposta para participação e atenção recorrente.</Alert.Description></Alert.Content></Alert> : null}
    <div className="learning-row learning-row--journey learning-enter">
      <AnalyticsTimelineV6 summary={value.summary} onPeriod={onPeriod} schoolLanguage />
      <Panel title="Quantitativo × qualitativo" hint={<Hint what="Compara como a turma foi nas provas e nas atividades." steps={['Quantitativo: quanto a turma fez nas duas avaliações do trimestre, antes da recuperação paralela.', 'Qualitativo: quanto fez nas atividades e na participação.', 'Subtrai-se um do outro para ver a diferença.']} result={learning?.dimensions.gapPP != null ? `Nesta turma: ${percent(learning.dimensions.qualitativePercent)} − ${percent(learning.dimensions.quantitativePercent)} = ${delta(learning.dimensions.gapPP)}, em ${learning.dimensions.students} alunos.` : undefined} note="A diferença mostra onde a turma vai melhor, não o motivo." />}>
        <div className="learning-composition">
          <MetricBar label="Quantitativo" caption="Duas avaliações por trimestre" value={learning?.dimensions.quantitativePercent ?? null} tone="accent" />
          <MetricBar label="Qualitativo" caption="Atividades + participação" value={learning?.dimensions.qualitativePercent ?? null} tone="violet" />
          <div className="learning-composition-note">{learning?.dimensions.gapPP != null ? <><strong>{number(Math.abs(learning.dimensions.gapPP))} p.p.</strong><span>{gapText(learning.dimensions.gapPP)}</span></> : <span>Comparação aguardando notas dos dois grupos.</span>}</div>
          <span className="learning-muted">Base comum: {learning?.dimensions.students ?? 0} alunos.</span>
        </div>
      </Panel>
    </div>
    <div className="learning-row learning-row--evidence learning-enter">
      <Panel title="Participação avaliada" hint={<Hint what="A nota média de participação dada pelos professores." steps={['Em cada disciplina: pontos de participação que o aluno ganhou ÷ pontos que podia ganhar. Exemplo: 4 de 5 vale 80%.', 'Tira-se a média das disciplinas do aluno.', 'Tira-se a média entre os alunos.']} result={`Nesta turma: ${learning?.participation.students ?? 0} alunos, ${learning?.participation.recorded ?? 0} notas = ${percent(learning?.participation.percent ?? null)}.`} note="Não mede presença nem comportamento." />}>
        <div className="learning-participation"><MessageCircle className="learning-participation-icon" size={24} aria-hidden="true" /><strong className="learning-score">{percent(learning?.participation.percent ?? null)}</strong><span className="learning-muted">Já incluída no qualitativo.</span>
          <span className="learning-participation-change">{learning?.participation.deltaPP != null ? `${delta(learning.participation.deltaPP)} desde T${reference}` : 'Sem comparação entre trimestres.'}</span>
          <span className="learning-muted">{learning?.participation.students ?? 0} alunos · {learning?.participation.recorded ?? 0} notas consideradas</span>
          {learning && learning.participation.recorded < learning.participation.expected ? <span className="learning-muted">Resultado parcial das notas disponíveis.</span> : null}
          <Button size="sm" variant="secondary" onPress={() => select('participation')}>Ver participação por aluno <ArrowRight size={14} /></Button>
        </div>
      </Panel>
      <Panel title="Situação nas notas" hint={<Hint what="Quantos alunos estão com todas as notas no mínimo da escola." steps={[`O mínimo da escola é ${percent(value.minimumPercent)}.`, 'Na referência: todas as disciplinas no mínimo ou acima.', 'Abaixo: pelo menos uma disciplina com nota abaixo do mínimo.', 'Atividade ou prova em branco conta como não feita.']} result={`Nesta turma: ${value.summary.students} alunos.`} note="Com tudo contando, quase nenhum aluno fica sem conclusão." />}>
        <div className="learning-distribution" aria-hidden="true">{distribution.filter((item) => item.count > 0).map((item) => <span key={item.key} className={`learning-tone--${item.tone}`} style={{ flexGrow: item.count }} />)}</div>
        <div className="learning-distribution-list">{distribution.map((item) => <Button key={item.key} variant="ghost" className={`learning-distribution-item learning-tone--${item.tone}`} onPress={() => select(item.key)}><span className="learning-dot" /><span>{item.label}</span><strong>{item.count}</strong></Button>)}</div>
        <span className="learning-muted">{value.summary.students} alunos · referência {percent(value.minimumPercent)}</span>
      </Panel>
      <Panel title="Componentes" hint={<Hint what="A nota média da turma em cada disciplina, de 0 a 100." steps={['Cada nota final da disciplina vira uma porcentagem. Exemplo: 7 em 10 vale 70%.', 'Somam-se as porcentagens e divide-se pelo número de notas da disciplina.']} note="Embaixo de cada barra: quantos alunos ficaram abaixo do mínimo e quanto a média mudou desde o trimestre anterior. Clique na disciplina para ver as notas." />}>
        <div className="learning-component-scroll"><AnalyticsBarsV6 items={value.components.map((item) => ({
          id: item.offer.id, label: item.offer.subject.label, value: item.summary.result.mean,
          below: item.summary.result.mean !== null && item.summary.result.mean < value.minimumPercent,
          secondary: `${item.summary.below} abaixo da referência · ${item.summary.complete} com resultado${item.summary.movement.meanDeltaPP !== null ? ` · ${delta(item.summary.movement.meanDeltaPP)}` : ''}`,
        }))} onSelect={onComponent} /></div>
      </Panel>
    </div>
    <div className="learning-row learning-row--action learning-enter">
      <Panel title="Acompanhamento dos alunos" hint={<Hint what="Os alunos de cada indicador desta tela." steps={['Notas: a média do aluno no período, de 0 a 100.', 'O número ao lado: quanto essa média mudou desde o trimestre anterior.']} note="Clique em um indicador para filtrar a lista. Ela mostra as notas que pedem acompanhamento; não é um diagnóstico do aluno." />}>
        <div className="learning-filters" aria-label="Filtros de acompanhamento">{(['attention', 'rising', 'falling', 'all'] as const).map((key) => <Button key={key} size="sm" variant={filter === key ? 'secondary' : 'ghost'} aria-pressed={filter === key} onPress={() => { setFilter(key); setSearch(''); }}>{FILTER_BUTTON[key]}</Button>)}</div>
        <div className="learning-list-heading"><h3 ref={listHeading} tabIndex={-1}>{LABELS[filter]}</h3><Chip size="sm">{selectedRows.length}</Chip></div>
        <SearchField aria-label="Buscar no acompanhamento" value={search} onChange={setSearch}><SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder="Buscar aluno" /><SearchField.ClearButton /></SearchField.Group></SearchField>
        <div className="learning-students">
          <Table><Table.ScrollContainer><Table.Content aria-label={LABELS[filter]}><Table.Header><Table.Column id="student" isRowHeader>Aluno</Table.Column><Table.Column id="result">{filter === 'participation' ? 'Participação' : 'Notas'}</Table.Column><Table.Column id="reason">O que observar</Table.Column></Table.Header><Table.Body>{visibleRows.map((row) => {
            const first = row.evidence?.recurring[0];
            let reasons;
            if (first) {
              reasons = `${componentLabels.get(first.offerId) ?? 'Componente'}: ${first.consecutiveTerms.length ? 'abaixo em trimestres seguidos' : 'notas baixas em mais de um instrumento'}`;
            } else if (row.summary.below) {
              reasons = `${row.summary.below} componentes abaixo da referência`;
            } else if (row.summary.complete) {
              reasons = 'Confira o desempenho por componente';
            } else {
              reasons = 'Ainda sem resultado suficiente';
            }
            let note = reasons;
            if (filter === 'participation') note = `${row.evidence?.participation.components ?? 0} componentes · ${row.evidence?.participation.recorded ?? 0} notas de participação`;
            else if (filter === 'recovery') note = `${row.evidence?.parallelImprovements ?? 0} resultados melhorados com a paralela`;
            return <Table.Row key={row.student.id} id={String(row.student.id)}><Table.Cell><div className="learning-student-name"><LinkedStudentPhotoAvatarV1 decorative size="sm" className="pa-student-avatar" fallbackTone={row.student.id % 6} subject={{ source: 'gradebook', academicYear: value.context.year, studentIds: [row.student.id] }} /><Button size="sm" variant="ghost" onPress={() => onStudent(row.student.id, filter === 'attention' ? first?.offerId : undefined)} aria-label={`Ver notas de ${row.student.name}`}>{row.student.name}</Button></div></Table.Cell><Table.Cell><strong>{percent(filter === 'participation' ? row.evidence?.participation.percent ?? null : row.summary.result.mean)}</strong><span className="learning-muted">{delta(filter === 'participation' ? row.evidence?.participation.deltaPP ?? null : row.summary.movement.meanDeltaPP)}</span></Table.Cell><Table.Cell><span>{note}</span></Table.Cell></Table.Row>;
          })}</Table.Body></Table.Content></Table.ScrollContainer></Table>
          {!visibleRows.length ? <p className="learning-empty">{emptyText}</p> : null}
        </div>
        {reference ? <div className="learning-priority" aria-label="Nível atual e evolução">{(['below-up', 'below-down', 'above-down'] as const).map((key) => <Button key={key} size="sm" variant="ghost" onPress={() => select(key)}><strong>{count(key)}</strong><span>{LABELS[key]}</span></Button>)}</div> : null}
      </Panel>
      <Panel title="Atividades para revisar" hint={<Hint what="As atividades em que mais alunos ficaram abaixo do mínimo." steps={['Em cada atividade, conta-se quantos alunos ficaram abaixo do mínimo.', 'A lista começa pelas atividades com mais alunos abaixo.', 'O número à direita é a nota média da turma na atividade.']} note="Só entram atividades com pelo menos 3 notas. Participação e paralela ficam de fora." />}>
        <div className="learning-activity-list">{reviewActivities.slice(0, 5).map((item) => <Button key={item.key} variant="ghost" className="learning-activity" onPress={() => onNotes(item.offerId)}><span><strong>{item.label}</strong><span className="learning-muted">{item.subject} · T{item.term}</span><span className="learning-muted">{item.below} de {item.stats.n} alunos abaixo</span></span><span className="learning-activity-score">{percent(item.stats.mean)}<ArrowRight size={14} /></span></Button>)}</div>
        {!reviewActivities.length ? <p className="learning-empty">{learning ? 'Nenhuma atividade com dificuldade identificada e base suficiente neste recorte.' : 'Aguardando os indicadores complementares.'}</p> : <span className="learning-muted">Até 5 destaques. Clique para ver todas as notas do componente.</span>}
        <div className="learning-recovery-summary"><strong>{learning?.parallel.students ?? '—'}</strong><span>alunos melhoraram com a recuperação paralela</span><Button size="sm" variant="ghost" onPress={() => select('recovery')}>Ver alunos <ArrowRight size={14} /></Button></div>
      </Panel>
    </div>
    <Accordion className="learning-secondary learning-enter" allowsMultipleExpanded>
      <Accordion.Item id="recovery"><Accordion.Heading><Accordion.Trigger><span>Recuperação · detalhes</span><Accordion.Indicator /></Accordion.Trigger></Accordion.Heading><Accordion.Panel><Accordion.Body><p className="learning-muted">A paralela elevou {learning?.parallel.improvements ?? 0} resultados. Ganho médio nesses casos: {delta(learning?.parallel.meanGainPP ?? null)} do máximo quantitativo. Isso descreve a nota, não prova a causa da melhora.</p><AnalyticsRecoveryV6 summary={value.summary} /></Accordion.Body></Accordion.Panel></Accordion.Item>
      <Accordion.Item id="quality"><Accordion.Heading><Accordion.Trigger><span>Base dos indicadores · qualidade dos dados</span><Accordion.Indicator /></Accordion.Trigger></Accordion.Heading><Accordion.Panel><Accordion.Body><p className="learning-muted">Nos resultados e na participação, instrumentos exigidos em branco contam como não feitos e somam zero, sem alterar os dados originais. A participação usa instrumentos com pontuação máxima válida e é comparada entre trimestres mesmo com campos em branco; instrumentos sem escala válida ficam fora do percentual. Avaliações e atividades para revisar consideram apenas notas lançadas.</p><AnalyticsCoverageV6 summary={value.summary} partial={value.students.reduce((sum, item) => sum + item.cells.filter((cell) => cell.result.state === 'partial').length, 0)} /></Accordion.Body></Accordion.Panel></Accordion.Item>
    </Accordion>
    <footer className="learning-footer"><span>{value.summary.students}/{value.classStudents} alunos · {periodName} · referência {percent(value.minimumPercent)}</span><span>Notas calculadas para acompanhamento, não diagnóstico.</span></footer>
  </div>;
}
