import './council-v3.css';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Chip, Spinner, Table } from '@heroui/react';
import {
  Check,
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleDot,
  Clock3,
  RefreshCw,
  Scale,
  Users,
  X,
} from 'lucide-react';
import type {
  RelationalCouncilFailureV3,
  RelationalCouncilStudentV3,
  RelationalCouncilTallyV3,
  RelationalCouncilWorkspaceV3,
} from '../../../../shared/gradebook-contracts/council/relational-council-v3';
import { gradeText } from '../performance/performance-display-v2';
import { LiveReadNoticeV1 } from '../../../shared/live-data/live-read-notice-v1';
import { ClassTabsV1 } from '../../../shared/ui/class-tabs-v1';
import { useRelationalCouncilV3 } from './use-relational-council-v3';

const FAILURE: Record<RelationalCouncilFailureV3, string> = {
  'invalid-request': 'A operação não pôde ser concluída. Atualize a tela e tente de novo.',
  'not-authorized': 'Sua sessão não possui autorização para operar o Conselho.',
  'not-found': 'A turma não foi encontrada neste ano letivo.',
  unavailable: 'O Conselho está temporariamente indisponível. Nada foi alterado.',
  'scope-too-large': 'A turma é grande demais para ser lida de uma vez.',
};
const RESULT_LABEL: Record<RelationalCouncilStudentV3['components'][number]['result'], string> = {
  'in-progress': 'Em curso',
  'approved-direct': 'Aprovado direto',
  'recovery-pending': 'Recuperação pendente',
  'approved-after-recovery': 'Aprovado pela recuperação',
  'not-approved': 'Não aprovado',
  'failed-no-show': 'N/C',
  'failed-repeat': 'Reprovado (R/R)',
  unavailable: 'Indisponível',
};
const RESULT_COLOR: Record<
  RelationalCouncilStudentV3['components'][number]['result'],
  'danger' | 'success' | 'default'
> = {
  'in-progress': 'default',
  'approved-direct': 'success',
  'recovery-pending': 'default',
  'approved-after-recovery': 'success',
  'not-approved': 'danger',
  'failed-no-show': 'danger',
  'failed-repeat': 'danger',
  unavailable: 'default',
};
/** One or many, in words: the counts are read aloud and label the summary. */
const countedV3 = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

const TALLY_KINDS = [
  ['approved', 'aprovado', 'aprovados', <Check key="approved" size={11} strokeWidth={3.5} />],
  ['rejected', 'reprovado', 'reprovados', <X key="rejected" size={11} strokeWidth={3.5} />],
  ['pending', 'pendente', 'pendentes', <Circle key="pending" size={7} fill="currentColor" />],
] as const;

/** Where the class stands, inside its button: a mark and a count for each outcome, no words.
 * Each outcome has its own shape, so the colour is never the only difference. Every button keeps
 * the place of one count (a dash when nobody is eligible), so they barely move as counts arrive. */
function ClassTallyV3({ tally }: Readonly<{ tally: RelationalCouncilTallyV3 | null | undefined }>) {
  if (tally === undefined)
    return <span className="council-tally" data-reading aria-hidden="true" />;
  if (tally === null)
    return (
      <span
        className="council-tally"
        data-unavailable
        role="img"
        aria-label="Contagem indisponível"
      >
        <CircleAlert size={12} />
      </span>
    );
  const shown = TALLY_KINDS.filter(([kind]) => tally[kind] > 0);
  if (!shown.length)
    return (
      <span className="council-tally" data-none role="img" aria-label="Nenhum elegível">
        –
      </span>
    );
  return (
    <span
      className="council-tally"
      role="img"
      aria-label={shown.map(([kind, one, many]) => countedV3(tally[kind], one, many)).join(', ')}
    >
      {shown.map(([kind, , , mark]) => (
        <span key={kind} data-kind={kind} aria-hidden="true">
          {mark}
          {tally[kind]}
        </span>
      ))}
    </span>
  );
}

function Metric({
  icon,
  label,
  value,
  tone = 'accent',
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: number;
  readonly tone?: 'accent' | 'success' | 'warning' | 'danger';
}) {
  return (
    <div className={`council-kpi council-kpi--${tone}`}>
      <span className="council-kpi__icon">{icon}</span>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function QueueCard({
  student,
  selected,
  onSelect,
}: {
  readonly student: RelationalCouncilStudentV3;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="council-queue-card"
      data-selected={selected || undefined}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="council-queue-card__number">{student.number}</span>
      <span className="min-w-0">
        <strong className="line-clamp-2 break-words text-sm">{student.name}</strong>
        <span className="block truncate text-xs text-muted">
          {student.decision?.label ??
            `${countedV3(student.eligibility.failedComponentCount, 'componente', 'componentes')} abaixo`}
        </span>
      </span>
      {student.decision ? (
        <CheckCircle2 size={17} className="text-success" aria-label="Decidido" />
      ) : (
        <Clock3 size={17} className="text-warning" aria-label="A deliberar" />
      )}
    </button>
  );
}

function Grade({ value, state }: { readonly value: number | null; readonly state: string }) {
  let label;
  if (state === 'no-show') {
    label = 'N/C';
  } else if (state === 'repeat-failure') {
    label = 'R/R';
  } else if (state === 'recovery-pending') {
    label = 'REC';
  } else {
    label = gradeText(value);
  }
  let tone = '';
  if (state === 'no-show' || state === 'repeat-failure') tone = 'text-danger';
  else if (value === null) tone = 'text-muted';
  return <span className={`font-semibold tabular-nums ${tone}`}>{label}</span>;
}

/** The eligible student under discussion: who it is and the year's results. */
function StudentPanel({ student }: { readonly student: RelationalCouncilStudentV3 }) {
  return (
    <div className="grid min-w-0 gap-4">
      <Card className="overflow-hidden">
        <Card.Header className="flex flex-row flex-wrap items-center gap-3 border-b border-separator">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent-soft font-bold text-accent">
            {student.number}
          </span>
          <div className="min-w-0 flex-1">
            <Card.Title className="break-words text-lg sm:text-xl">{student.name}</Card.Title>
            <Card.Description>{student.statusLabel}</Card.Description>
          </div>
          <Chip color="success" variant="soft">
            <Chip.Label>Elegível</Chip.Label>
          </Chip>
        </Card.Header>
        <Card.Content className="pt-4">
          <Table>
            <Table.ScrollContainer className="max-w-full overflow-x-auto">
              <Table.Content
                aria-label={`Resultado anual de ${student.name}`}
                className="min-w-[760px]"
              >
                <Table.Header>
                  <Table.Column id="subject" isRowHeader>
                    Componente
                  </Table.Column>
                  <Table.Column id="t1">1º tri.</Table.Column>
                  <Table.Column id="t2">2º tri.</Table.Column>
                  <Table.Column id="t3">3º tri.</Table.Column>
                  <Table.Column id="rec">REC</Table.Column>
                  <Table.Column id="result">Resultado</Table.Column>
                </Table.Header>
                <Table.Body
                  items={student.components}
                  renderEmptyState={() => 'Nenhum componente disponível.'}
                >
                  {(component) => (
                    <Table.Row id={component.offerId}>
                      <Table.Cell>
                        <span className="font-medium">
                          {component.subject.abbreviation ?? component.subject.label}
                        </span>
                        <span className="ml-2 text-xs text-muted">{component.subject.label}</span>
                      </Table.Cell>
                      {component.terms.map((term, index) => (
                        <Table.Cell key={index /* NOSONAR fixed T1-T3 tuple */}>
                          <Grade value={term.valueMilli} state={term.state} />
                        </Table.Cell>
                      ))}
                      <Table.Cell>
                        <Grade
                          value={component.recovery.valueMilli}
                          state={component.recovery.state}
                        />
                      </Table.Cell>
                      <Table.Cell>
                        <Chip size="sm" variant="soft" color={RESULT_COLOR[component.result]}>
                          <Chip.Label>{RESULT_LABEL[component.result]}</Chip.Label>
                        </Chip>
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </Card.Content>
      </Card>
    </div>
  );
}

/** The reads in progress, the last failure and a stale live read. */
function CouncilStatusV3({
  busy,
  failure,
  stale,
}: Readonly<{
  busy: { classes: boolean; workspace: boolean };
  failure: RelationalCouncilFailureV3 | null;
  stale: boolean;
}>) {
  return (
    // Empty, it stays in the page for the announcements but out of the flow: no row and no gap.
    <div className="empty:absolute" aria-live="polite">
      {busy.classes || busy.workspace ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <output className="contents">
            <Spinner size="sm" />
            Carregando…
          </output>
        </p>
      ) : null}
      {failure ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Operação não concluída</Alert.Title>
            <Alert.Description>{FAILURE[failure]}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <LiveReadNoticeV1 failed={stale} />
    </div>
  );
}

/** The meeting of a class with eligible students: not started, open, or concluded once every
 * eligible student has a decision. It opens once and is never closed. */
function CouncilSessionV3({
  workspace,
  busy,
  onOpen,
}: Readonly<{
  workspace: RelationalCouncilWorkspaceV3;
  busy: boolean;
  onOpen: () => void;
}>) {
  const opened = workspace.session.state === 'open';
  const concluded = opened && workspace.summary.pending === 0;
  let state = 'Ainda não iniciada';
  if (concluded) state = 'Concluída';
  else if (opened) state = 'Aberta';
  return (
    <div className="council-session" role="group" aria-label="Reunião da turma">
      <Chip color={concluded ? 'success' : opened ? 'accent' : 'default'} variant="soft">
        <Chip.Label>{state}</Chip.Label>
      </Chip>
      {opened ? null : (
        <Button variant="primary" className="ml-auto" isDisabled={busy} onPress={onOpen}>
          <CircleDot size={17} />
          Abrir reunião
        </Button>
      )}
    </div>
  );
}

export function RelationalCouncilPageV3() {
  const state = useRelationalCouncilV3();
  const [selectedStudentId, setSelectedStudentId] = useState<number | null>(null);
  const workspace = state.workspace;
  const eligible = useMemo(
    () => workspace?.students.filter((student) => student.eligibility.eligible) ?? [],
    [workspace],
  );
  const pending = eligible.filter((student) => !student.decision);
  const decided = eligible.filter((student) => student.decision);
  const selected =
    eligible.find((student) => student.id === selectedStudentId) ?? eligible[0] ?? null;
  useEffect(() => {
    if (!workspace) {
      setSelectedStudentId(null);
      return;
    }
    setSelectedStudentId((current) =>
      eligible.some((student) => student.id === current)
        ? current
        : ((pending[0] ?? eligible[0])?.id ?? null),
    );
  }, [workspace?.classGroup.id]);

  return (
    <section aria-label="Conselho de Classe relacional" className="grid min-w-0 gap-2">
      <h2 className="sr-only">Conselho de Classe</h2>
      <ClassTabsV1
        label="Turmas do Conselho"
        items={state.classes.map((item) => ({
          id: item.id,
          label: item.label,
          extra: <ClassTallyV3 tally={item.tally} />,
        }))}
        selectedId={state.classId}
        disabled={state.busy.classes || state.busy.command}
        onChange={(id) => void state.selectClass(id)}
      >
        <div className="grid min-w-0 gap-4">
          {state.failure && state.classId !== null ? (
            <Button
              variant="secondary"
              className="justify-self-start"
              isDisabled={state.busy.workspace || state.busy.command}
              onPress={() => void state.loadWorkspace(state.classId!)}
            >
              <RefreshCw size={16} />
              Tentar novamente
            </Button>
          ) : null}
          <CouncilStatusV3 busy={state.busy} failure={state.failure} stale={state.stale} />
          {!workspace && !state.busy.workspace ? (
            <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-separator bg-surface-secondary/40 p-8 text-center">
              <div>
                <Scale className="mx-auto mb-3 text-muted" />
                <strong className="text-sm">Escolha uma turma para abrir a pauta</strong>
              </div>
            </div>
          ) : null}
          {workspace ? (
            <>
              <div className="council-kpi-group" aria-label="Resumo do Conselho">
                <Metric
                  icon={<Users size={19} />}
                  label={workspace.summary.total === 1 ? 'aluno' : 'alunos'}
                  value={workspace.summary.total}
                />
                <Metric
                  icon={<Scale size={19} />}
                  label={workspace.summary.eligible === 1 ? 'elegível' : 'elegíveis'}
                  value={workspace.summary.eligible}
                />
                <Metric
                  icon={<Clock3 size={19} />}
                  label="a deliberar"
                  value={workspace.summary.pending}
                  tone="warning"
                />
                <Metric
                  icon={<CheckCircle2 size={19} />}
                  label={workspace.summary.decided === 1 ? 'decidido' : 'decididos'}
                  value={workspace.summary.decided}
                  tone="success"
                />
              </div>
              {eligible.length ? (
                <CouncilSessionV3
                  workspace={workspace}
                  busy={state.busy.command}
                  onOpen={() => void state.openSession()}
                />
              ) : null}
              {eligible.length ? (
                <div className="council-layout">
                  <aside className="min-w-0">
                    <div className="council-board" aria-label="Fluxo dos alunos elegíveis">
                      <section className="council-board__column">
                        <header>
                          <span className="size-2 rounded-full bg-warning" />
                          <strong>A deliberar</strong>
                          <span>{pending.length}</span>
                        </header>
                        <div className="council-board__cards">
                          {pending.map((student) => (
                            <QueueCard
                              key={student.id}
                              student={student}
                              selected={selected?.id === student.id}
                              onSelect={() => setSelectedStudentId(student.id)}
                            />
                          ))}
                          {!pending.length ? (
                            <p className="council-board__empty">
                              <Check size={16} />
                              Fila concluída
                            </p>
                          ) : null}
                        </div>
                      </section>
                      {decided.length ? (
                        <section className="council-board__column">
                          <header>
                            <span className="size-2 rounded-full bg-success" />
                            <strong>Decididos</strong>
                            <span>{decided.length}</span>
                          </header>
                          <div className="council-board__cards">
                            {decided.map((student) => (
                              <QueueCard
                                key={student.id}
                                student={student}
                                selected={selected?.id === student.id}
                                onSelect={() => setSelectedStudentId(student.id)}
                              />
                            ))}
                          </div>
                        </section>
                      ) : null}
                    </div>
                  </aside>
                  <main className="min-w-0">
                    {selected ? <StudentPanel key={selected.id} student={selected} /> : null}
                  </main>
                </div>
              ) : (
                <Alert status="default">
                  <Alert.Content>
                    <Alert.Title>Nenhum aluno elegível nesta turma</Alert.Title>
                  </Alert.Content>
                </Alert>
              )}
            </>
          ) : null}
        </div>
      </ClassTabsV1>
    </section>
  );
}
