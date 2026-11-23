import './council-v3.css';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Chip, Spinner, Table } from '@heroui/react';
import {
  Archive,
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  Scale,
  Users,
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
  'invalid-request':
    'A operação não pôde ser interpretada. Atualize a tela antes de tentar novamente.',
  'not-authorized': 'Sua sessão não possui autorização para operar o Conselho.',
  'not-found': 'A turma ou o aluno não foi encontrado no contexto acadêmico atual.',
  unavailable:
    'O Conselho está temporariamente indisponível; nenhuma alteração parcial foi mantida.',
  'scope-too-large': 'A turma excede o limite seguro desta leitura e não foi truncada.',
  'version-conflict': 'Outra alteração foi salva antes desta. O estado atual foi recarregado.',
  'idempotency-conflict': 'A chave desta ação já foi usada com outro conteúdo.',
  'session-not-open': 'Abra a reunião antes de registrar deliberações.',
  'session-already-open': 'A sessão já está aberta. Para corrigir um fechamento, use Reabrir.',
  'session-closed': 'A sessão está fechada. Reabra-a para editar.',
  'closure-blocked': 'Ainda existem alunos elegíveis sem decisão explícita.',
  'review-conflict': 'A revisão mudou. Confira a fila atual antes de fechar.',
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
type SessionStateV3 = RelationalCouncilWorkspaceV3['session']['state'];
const SESSION_COLOR: Record<SessionStateV3, 'success' | 'warning' | 'default'> = {
  open: 'success',
  closed: 'warning',
  'not-opened': 'default',
};
const SESSION_LABEL: Record<SessionStateV3, string> = {
  open: 'Sessão aberta',
  closed: 'Sessão fechada',
  'not-opened': 'Ainda não iniciada',
};
type SessionActionV3 = 'open' | 'close' | 'reopen';
const SESSION_DONE: Record<SessionActionV3, string> = {
  open: 'Reunião aberta.',
  reopen: 'Reunião reaberta.',
  close: 'Reunião fechada.',
};
const TALLY_KINDS = [
  ['approved', 'aprovado(s)'],
  ['rejected', 'reprovado(s)'],
  ['pending', 'pendente(s)'],
] as const;

/** Where the class stands, inside its button: a coloured count for each outcome, no words. */
function ClassTallyV3({ tally }: Readonly<{ tally: RelationalCouncilTallyV3 | undefined }>) {
  const shown = TALLY_KINDS.filter(([kind]) => (tally?.[kind] ?? 0) > 0);
  if (!tally || !shown.length) return null;
  return (
    <span
      className="council-tally"
      role="img"
      aria-label={shown.map(([kind, word]) => `${tally[kind]} ${word}`).join(', ')}
    >
      {shown.map(([kind]) => (
        <span key={kind} data-kind={kind} aria-hidden="true">
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
        <strong className="block truncate text-sm">{student.name}</strong>
        <span className="block truncate text-xs text-muted">
          {student.decision?.label ??
            `${student.eligibility.failedComponentCount} componente(s) abaixo`}
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

/** The eligible student under discussion: who it is, why it is eligible and the year's results. */
function StudentPanel({ student }: { readonly student: RelationalCouncilStudentV3 }) {
  return (
    <div className="grid min-w-0 gap-4">
      <Card className="overflow-hidden">
        <Card.Header className="flex flex-col items-start gap-3 border-b border-separator sm:flex-row sm:items-center">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent-soft font-bold text-accent">
            {student.number}
          </span>
          <div className="min-w-0">
            <Card.Title className="break-words text-xl">{student.name}</Card.Title>
            <Card.Description>{student.statusLabel}</Card.Description>
          </div>
          <Chip
            className="sm:ml-auto"
            color={student.eligibility.eligible ? 'success' : 'default'}
            variant="soft"
          >
            <Chip.Label>{student.eligibility.eligible ? 'Elegível' : 'Não elegível'}</Chip.Label>
          </Chip>
        </Card.Header>
        <Card.Content className="grid gap-4 pt-4">
          <Alert status={student.eligibility.eligible ? 'success' : 'default'}>
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{student.eligibility.label}</Alert.Title>
              {student.calculatedResult ? (
                <Alert.Description>{student.calculatedResult}</Alert.Description>
              ) : null}
            </Alert.Content>
          </Alert>
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

/** The reads in progress, the last failure, a stale live read and the last confirmation. */
function CouncilStatusV3({
  busy,
  failure,
  stale,
  message,
}: Readonly<{
  busy: { classes: boolean; workspace: boolean };
  failure: RelationalCouncilFailureV3 | null;
  stale: boolean;
  message: string;
}>) {
  return (
    // Empty, it stays in the page for the announcements but out of the flow: no row and no gap.
    <div className="empty:absolute" aria-live="polite">
      {busy.classes || busy.workspace ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <output className="contents">
            <Spinner size="sm" />
            Carregando a leitura segura do Conselho…
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
      {message ? <p className="text-sm font-medium text-success">{message}</p> : null}
    </div>
  );
}

/** The class session: its state, the justification, and open, reopen or a confirmed close. */
function CouncilSessionCardV3({
  workspace,
  confirmClose,
  onConfirmClose,
  busy,
  onSessionCommand,
}: Readonly<{
  workspace: RelationalCouncilWorkspaceV3;
  confirmClose: boolean;
  onConfirmClose: (confirm: boolean) => void;
  busy: boolean;
  onSessionCommand: (operation: SessionActionV3) => void;
}>) {
  return (
    <Card>
      <Card.Header className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div>
          <Card.Title>Sessão da turma {workspace.classGroup.label}</Card.Title>
          <Card.Description>Versão institucional {workspace.session.version}</Card.Description>
        </div>
        <Chip className="sm:ml-auto" color={SESSION_COLOR[workspace.session.state]} variant="soft">
          <Chip.Label>{SESSION_LABEL[workspace.session.state]}</Chip.Label>
        </Chip>
      </Card.Header>
      <Card.Content className="grid gap-3 border-t border-separator pt-4">
        <div className="flex flex-wrap gap-2">
          {workspace.session.state === 'not-opened' ? (
            <Button variant="primary" isDisabled={busy} onPress={() => onSessionCommand('open')}>
              <CircleDot size={17} />
              Abrir reunião
            </Button>
          ) : null}
          {workspace.session.state === 'closed' ? (
            <Button variant="primary" isDisabled={busy} onPress={() => onSessionCommand('reopen')}>
              <RotateCcw size={17} />
              Reabrir reunião
            </Button>
          ) : null}
          {workspace.session.state === 'open' && !confirmClose ? (
            <Button
              variant="secondary"
              isDisabled={workspace.summary.pending > 0 || busy}
              onPress={() => onConfirmClose(true)}
            >
              <LockKeyhole size={17} />
              Revisar fechamento
            </Button>
          ) : null}
        </div>
        {workspace.session.state === 'open' && workspace.summary.pending > 0 ? (
          <p className="text-xs text-warning">
            Faltam {workspace.summary.pending} decisão(ões) explícita(s) antes do fechamento.
          </p>
        ) : null}
        {confirmClose ? (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Confirmar fechamento institucional?</Alert.Title>
              <Alert.Description>
                As edições serão bloqueadas. Para corrigir depois, reabra a reunião.
              </Alert.Description>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="primary"
                  isDisabled={busy}
                  onPress={() => onSessionCommand('close')}
                >
                  <Archive size={16} />
                  Fechar reunião
                </Button>
                <Button variant="ghost" onPress={() => onConfirmClose(false)}>
                  Cancelar
                </Button>
              </div>
            </Alert.Content>
          </Alert>
        ) : null}
      </Card.Content>
    </Card>
  );
}

export function RelationalCouncilPageV3() {
  const state = useRelationalCouncilV3();
  const [selectedStudentId, setSelectedStudentId] = useState<number | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [message, setMessage] = useState('');
  const workspace = state.workspace;
  const eligible = useMemo(
    () => workspace?.students.filter((student) => student.eligibility.eligible) ?? [],
    [workspace],
  );
  const pending = eligible.filter((student) => !student.decision);
  const decided = eligible.filter((student) => student.decision);
  const selected =
    eligible.find((student) => student.id === selectedStudentId) ?? eligible[0] ?? null;
  const protectDrafts = confirmClose;
  state.protectDrafts(protectDrafts);
  useEffect(() => {
    // What was confirmed in one class does not follow to the next.
    setMessage('');
    if (!workspace) {
      setSelectedStudentId(null);
      return;
    }
    setSelectedStudentId((current) =>
      eligible.some((student) => student.id === current)
        ? current
        : ((pending[0] ?? eligible[0])?.id ?? null),
    );
    setConfirmClose(false);
  }, [workspace?.classGroup.id]);

  async function sessionCommand(operation: SessionActionV3) {
    if (!workspace) return;
    const response = await state.command(
      operation === 'close'
        ? { operation, reviewReference: workspace.session.reviewReference }
        : { operation },
    );
    if (response?.state === 'ready') {
      setMessage(SESSION_DONE[operation]);
      setConfirmClose(false);
    }
  }

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
              isDisabled={state.busy.workspace || state.busy.command || protectDrafts}
              onPress={() => void state.loadWorkspace(state.classId!)}
            >
              <RefreshCw size={16} />
              Tentar novamente
            </Button>
          ) : null}
          <CouncilStatusV3
            busy={state.busy}
            failure={state.failure}
            stale={state.stale}
            message={message}
          />
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
                <Metric icon={<Users size={19} />} label="alunos" value={workspace.summary.total} />
                <Metric
                  icon={<Scale size={19} />}
                  label="elegíveis"
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
                  label="decididos"
                  value={workspace.summary.decided}
                  tone="success"
                />
              </div>
              <CouncilSessionCardV3
                workspace={workspace}
                confirmClose={confirmClose}
                onConfirmClose={setConfirmClose}
                busy={state.busy.command}
                onSessionCommand={(operation) => void sessionCommand(operation)}
              />
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
