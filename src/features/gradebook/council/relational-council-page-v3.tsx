import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Chip, Label, ListBox, Select, Spinner, Surface, Table } from '@heroui/react';
import {
  Archive,
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  History,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  Scale,
  ShieldCheck,
  Users,
  Vote,
} from 'lucide-react';
import { RELATIONAL_COUNCIL_DECISIONS_V3, type RelationalCouncilFailureV3, type RelationalCouncilStudentV3 } from '../../../../shared/gradebook-contracts/council/relational-council-v3';
import { gradeText } from '../performance/performance-display-v2';
import { LiveReadNoticeV1 } from '../../../shared/live-data/live-read-notice-v1';
import { useRelationalCouncilV3 } from './use-relational-council-v3';

const FAILURE: Record<RelationalCouncilFailureV3, string> = {
  'invalid-request': 'A operação não pôde ser interpretada. Atualize a tela antes de tentar novamente.',
  'not-authorized': 'Sua sessão não possui autorização para operar o Conselho.',
  'not-found': 'A turma ou o aluno não foi encontrado no contexto acadêmico atual.',
  unavailable: 'O Conselho está temporariamente indisponível; nenhuma alteração parcial foi mantida.',
  'scope-too-large': 'A turma excede o limite seguro desta leitura e não foi truncada.',
  'version-conflict': 'Outra alteração foi salva antes desta. O estado atual foi recarregado.',
  'idempotency-conflict': 'A chave desta ação já foi usada com outro conteúdo.',
  'session-not-open': 'Abra a reunião antes de registrar deliberações.',
  'session-already-open': 'A sessão já está aberta. Para corrigir um fechamento, use Reabrir.',
  'session-closed': 'A sessão está fechada. Reabra-a com justificativa para editar.',
  'closure-blocked': 'Ainda existem alunos elegíveis sem decisão explícita.',
  'review-conflict': 'A revisão mudou. Confira a fila atual antes de fechar.',
  'student-not-eligible': 'Este aluno não é elegível ao Conselho Final segundo o cálculo vigente.',
};
const RESULT_LABEL: Record<RelationalCouncilStudentV3['components'][number]['result'], string> = {
  'in-progress': 'Em curso', 'approved-direct': 'Aprovado direto', 'recovery-pending': 'Recuperação pendente',
  'approved-after-recovery': 'Aprovado pela recuperação', 'not-approved': 'Não aprovado',
  'failed-no-show': 'N/C', 'failed-repeat': 'Reprovado (R/R)', unavailable: 'Indisponível',
};
const TIMELINE_LABEL = {
  opened: 'Reunião aberta', 'decision-recorded': 'Decisão registrada', 'vote-recorded': 'Contagem registrada',
  closed: 'Reunião fechada', reopened: 'Reunião reaberta',
} as const;

function CouncilClassSelect({ value, disabled, classes, onChange }: {
  readonly value: number | null;
  readonly disabled: boolean;
  readonly classes: readonly { readonly id: number; readonly label: string; readonly name: string }[];
  readonly onChange: (value: number | null) => void;
}) {
  return <Select selectedKey={value === null ? 'none' : String(value)} isDisabled={disabled}
    onSelectionChange={(key) => { if (key !== null) onChange(key === 'none' ? null : Number(key)); }}>
    <Label className="mb-1.5 block text-xs font-medium text-muted">Turma do Conselho</Label>
    <Select.Trigger className="min-h-11 w-full"><Select.Value/><Select.Indicator/></Select.Trigger>
    <Select.Popover><ListBox>
      <ListBox.Item id="none" textValue="Selecione a turma">Selecione a turma<ListBox.ItemIndicator/></ListBox.Item>
      {classes.map((item) => <ListBox.Item key={item.id} id={String(item.id)} textValue={`${item.label} — ${item.name}`}>
        <span className="font-medium">{item.label}</span><span className="ml-2 text-xs text-muted">{item.name}</span><ListBox.ItemIndicator/>
      </ListBox.Item>)}
    </ListBox></Select.Popover>
  </Select>;
}

function Metric({ icon, label, value, tone = 'accent' }: { readonly icon: React.ReactNode; readonly label: string; readonly value: number; readonly tone?: 'accent' | 'success' | 'warning' | 'danger' }) {
  return <div className={`council-kpi council-kpi--${tone}`}><span className="council-kpi__icon">{icon}</span><div><strong>{value}</strong><span>{label}</span></div></div>;
}

function QueueCard({ student, selected, onSelect }: { readonly student: RelationalCouncilStudentV3; readonly selected: boolean; readonly onSelect: () => void }) {
  return <button type="button" className="council-queue-card" data-selected={selected || undefined} onClick={onSelect} aria-pressed={selected}>
    <span className="council-queue-card__number">{student.number}</span>
    <span className="min-w-0"><strong className="block truncate text-sm">{student.name}</strong><span className="block truncate text-xs text-muted">{student.decision?.label ?? `${student.eligibility.failedComponentCount} componente(s) abaixo`}</span></span>
    {student.decision ? <CheckCircle2 size={17} className="text-success" aria-label="Decidido"/> : <Clock3 size={17} className="text-warning" aria-label="A deliberar"/>}
  </button>;
}

function Grade({ value, state }: { readonly value: number | null; readonly state: string }) {
  const label = state === 'no-show' ? 'N/C' : state === 'repeat-failure' ? 'R/R' : state === 'recovery-pending' ? 'REC' : gradeText(value);
  return <span className={`font-semibold tabular-nums ${state === 'no-show' || state === 'repeat-failure' ? 'text-danger' : value === null ? 'text-muted' : ''}`}>{label}</span>;
}

function StudentPanel({ student, sessionOpen, busy, onCommand, onMessage, onDirtyChange }: {
  readonly student: RelationalCouncilStudentV3;
  readonly sessionOpen: boolean;
  readonly busy: boolean;
  readonly onCommand: ReturnType<typeof useRelationalCouncilV3>['command'];
  readonly onMessage: (message: string) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const [decision, setDecision] = useState(String(student.decision?.code ?? 1));
  const [decisionReason, setDecisionReason] = useState(student.decision?.justification ?? '');
  const [favoraveis, setFavoraveis] = useState(student.vote ? String(student.vote.favoraveis) : '');
  const [contrarios, setContrarios] = useState(student.vote ? String(student.vote.contrarios) : '');
  const [voteReason, setVoteReason] = useState(student.vote?.justification ?? '');
  useEffect(() => {
    setDecision(String(student.decision?.code ?? 1)); setDecisionReason(student.decision?.justification ?? '');
    setFavoraveis(student.vote ? String(student.vote.favoraveis) : ''); setContrarios(student.vote ? String(student.vote.contrarios) : '');
    setVoteReason(student.vote?.justification ?? '');
    onDirtyChange(false);
  }, [student.id, student.decision, student.vote, onDirtyChange]);
  const favorableNumber = /^\d+$/u.test(favoraveis) ? Number(favoraveis) : null;
  const contraryNumber = /^\d+$/u.test(contrarios) ? Number(contrarios) : null;
  const present = favorableNumber !== null && contraryNumber !== null ? favorableNumber + contraryNumber : null;
  return <div className="grid min-w-0 gap-4">
    <Card className="overflow-hidden">
      <Card.Header className="flex flex-col items-start gap-3 border-b border-separator sm:flex-row sm:items-center">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent-soft font-bold text-accent">{student.number}</span>
        <div className="min-w-0"><Card.Title className="break-words text-xl">{student.name}</Card.Title><Card.Description>{student.statusLabel}</Card.Description></div>
        <Chip className="sm:ml-auto" color={student.eligibility.eligible ? 'success' : 'default'} variant="soft"><Chip.Label>{student.eligibility.eligible ? 'Elegível' : 'Não elegível'}</Chip.Label></Chip>
      </Card.Header>
      <Card.Content className="grid gap-4 pt-4">
        <Alert status={student.eligibility.eligible ? 'success' : 'default'}><Alert.Indicator/><Alert.Content><Alert.Title>{student.eligibility.label}</Alert.Title>
          <Alert.Description>{student.calculatedResult ?? 'O resultado calculado ainda não emite decisão humana.'}</Alert.Description></Alert.Content></Alert>
        <Table><Table.ScrollContainer className="max-w-full overflow-x-auto"><Table.Content aria-label={`Resultado anual de ${student.name}`} className="min-w-[760px]">
          <Table.Header><Table.Column id="subject" isRowHeader>Componente</Table.Column><Table.Column id="t1">1º tri.</Table.Column><Table.Column id="t2">2º tri.</Table.Column><Table.Column id="t3">3º tri.</Table.Column><Table.Column id="rec">REC</Table.Column><Table.Column id="result">Resultado</Table.Column></Table.Header>
          <Table.Body items={student.components} renderEmptyState={() => 'Nenhum componente disponível.'}>{(component) => <Table.Row id={component.offerId}>
            <Table.Cell><span className="font-medium">{component.subject.abbreviation ?? component.subject.label}</span><span className="ml-2 text-xs text-muted">{component.subject.label}</span></Table.Cell>
            {component.terms.map((term, index) => <Table.Cell key={index}><Grade value={term.valueMilli} state={term.state}/></Table.Cell>)}
            <Table.Cell><Grade value={component.recovery.valueMilli} state={component.recovery.state}/></Table.Cell>
            <Table.Cell><Chip size="sm" variant="soft" color={component.result === 'not-approved' || component.result === 'failed-no-show' || component.result === 'failed-repeat' ? 'danger' : component.result.startsWith('approved') ? 'success' : 'default'}><Chip.Label>{RESULT_LABEL[component.result]}</Chip.Label></Chip></Table.Cell>
          </Table.Row>}</Table.Body>
        </Table.Content></Table.ScrollContainer></Table>
      </Card.Content>
    </Card>

    {student.eligibility.eligible ? <div className="grid min-w-0 gap-4 xl:grid-cols-2">
      <Card><Card.Header><div><Card.Title>Decisão humana</Card.Title><Card.Description>O sistema registra a deliberação; não a infere pelas notas ou pelos votos.</Card.Description></div></Card.Header>
        <Card.Content className="grid gap-3">
          <Select selectedKey={decision} isDisabled={!sessionOpen || busy} onSelectionChange={(key) => { if (key !== null) { onDirtyChange(true); setDecision(String(key)); } }}>
            <Label className="text-xs font-medium text-muted">Situação após o Conselho</Label><Select.Trigger><Select.Value/><Select.Indicator/></Select.Trigger>
            <Select.Popover><ListBox>{Object.entries(RELATIONAL_COUNCIL_DECISIONS_V3).map(([code, label]) => <ListBox.Item key={code} id={code} textValue={label}>{label}<ListBox.ItemIndicator/></ListBox.Item>)}</ListBox></Select.Popover>
          </Select>
          <div><Label htmlFor={`decision-reason-${student.id}`} className="mb-1.5 block text-xs font-medium text-muted">Justificativa da decisão</Label>
            <textarea id={`decision-reason-${student.id}`} value={decisionReason} onChange={(event) => { onDirtyChange(true); setDecisionReason(event.currentTarget.value); }} disabled={!sessionOpen || busy} rows={3} className="council-textarea"/></div>
          <Button variant="primary" isDisabled={!sessionOpen || busy || decisionReason.trim().length < 3} onPress={async () => {
            const response = await onCommand({ operation: 'decision', studentId: student.id, decision: Number(decision) as 1 | 2 | 3, justification: decisionReason.trim() });
            if (response?.state === 'ready') { onDirtyChange(false); onMessage('Decisão humana registrada com histórico.'); }
          }}><ShieldCheck size={17}/>{student.decision ? 'Atualizar decisão' : 'Registrar decisão'}</Button>
        </Card.Content>
      </Card>
      <Card><Card.Header><div><Card.Title>Contagem opcional</Card.Title><Card.Description>Somente votos favoráveis e contrários. Presentes é calculado pela soma.</Card.Description></div></Card.Header>
        <Card.Content className="grid gap-3">
          <div className="grid grid-cols-2 gap-3"><div><Label htmlFor={`votes-for-${student.id}`} className="text-xs font-medium text-muted">Favoráveis</Label><input id={`votes-for-${student.id}`} inputMode="numeric" value={favoraveis} onChange={(event) => { onDirtyChange(true); setFavoraveis(event.currentTarget.value); }} disabled={!sessionOpen || busy} className="council-number-input"/></div>
            <div><Label htmlFor={`votes-against-${student.id}`} className="text-xs font-medium text-muted">Contrários</Label><input id={`votes-against-${student.id}`} inputMode="numeric" value={contrarios} onChange={(event) => { onDirtyChange(true); setContrarios(event.currentTarget.value); }} disabled={!sessionOpen || busy} className="council-number-input"/></div></div>
          <div className="flex min-h-8 items-center gap-2 text-sm"><Users size={16}/><span>{present === null ? 'Informe as duas contagens' : `${present} presente(s)`}</span>{present !== null && favorableNumber === contraryNumber ? <Chip size="sm" color="warning" variant="soft"><Chip.Label>Empate · decisão fora do sistema</Chip.Label></Chip> : null}</div>
          <div><Label htmlFor={`vote-reason-${student.id}`} className="mb-1.5 block text-xs font-medium text-muted">Justificativa do registro</Label><textarea id={`vote-reason-${student.id}`} value={voteReason} onChange={(event) => { onDirtyChange(true); setVoteReason(event.currentTarget.value); }} disabled={!sessionOpen || busy} rows={3} className="council-textarea"/></div>
          <Button variant="secondary" isDisabled={!sessionOpen || busy || present === null || voteReason.trim().length < 3} onPress={async () => {
            if (favorableNumber === null || contraryNumber === null) return;
            const response = await onCommand({ operation: 'vote', studentId: student.id, favoraveis: favorableNumber, contrarios: contraryNumber, justification: voteReason.trim() });
            if (response?.state === 'ready') { onDirtyChange(false); onMessage('Contagem registrada; nenhuma decisão foi criada automaticamente.'); }
          }}><Vote size={17}/>{student.vote ? 'Atualizar contagem' : 'Registrar contagem'}</Button>
        </Card.Content>
      </Card>
    </div> : null}
  </div>;
}

export function RelationalCouncilPageV3() {
  const state = useRelationalCouncilV3();
  const [selectedStudentId, setSelectedStudentId] = useState<number | null>(null);
  const [sessionReason, setSessionReason] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [message, setMessage] = useState('');
  const [studentDirty, setStudentDirty] = useState(false);
  const workspace = state.workspace;
  const eligible = useMemo(() => workspace?.students.filter((student) => student.eligibility.eligible) ?? [], [workspace]);
  const pending = eligible.filter((student) => !student.decision);
  const decided = eligible.filter((student) => student.decision);
  const notEligible = workspace?.students.filter((student) => !student.eligibility.eligible) ?? [];
  const selected = eligible.find((student) => student.id === selectedStudentId) ?? eligible[0] ?? null;
  const protectDrafts = studentDirty || sessionReason.length > 0 || confirmClose;
  state.protectDrafts(protectDrafts);
  useEffect(() => {
    if (!workspace) { setSelectedStudentId(null); return; }
    setSelectedStudentId((current) => eligible.some((student) => student.id === current) ? current : (pending[0] ?? eligible[0])?.id ?? null);
    setConfirmClose(false); setSessionReason(''); setStudentDirty(false);
  }, [workspace?.classGroup.id]);

  async function sessionCommand(operation: 'open' | 'close' | 'reopen') {
    if (!workspace || sessionReason.trim().length < 3) return;
    const response = operation === 'close'
      ? await state.command({ operation, reviewReference: workspace.session.reviewReference, justification: sessionReason.trim() })
      : await state.command({ operation, justification: sessionReason.trim() });
    if (response?.state === 'ready') {
      setMessage(operation === 'open' ? 'Reunião aberta.' : operation === 'reopen' ? 'Reunião reaberta; o snapshot anterior foi preservado.' : 'Reunião fechada com novo snapshot imutável.');
      setSessionReason(''); setConfirmClose(false);
    }
  }

  return <section aria-label="Conselho de Classe relacional" className="grid min-w-0 gap-4">
    <header className="flex min-h-12 flex-wrap items-center gap-3"><div><h2 className="sr-only">Conselho de Classe</h2><p className="text-xs text-muted">Deliberação humana auditável sobre a elegibilidade calculada do ano selecionado.</p></div>
      <Chip size="sm" variant="soft" color="accent" className="ml-auto"><Chip.Label>{state.year} · decisão explícita</Chip.Label></Chip></header>
    <Surface className="council-filterbar"><div className="min-w-0 flex-1"><CouncilClassSelect value={state.classId} disabled={state.busy.classes || state.busy.command} classes={state.classes} onChange={(value) => void state.selectClass(value)}/></div>
      {state.failure && state.classId !== null ? <Button variant="secondary" isDisabled={state.busy.workspace || state.busy.command || protectDrafts} onPress={() => void state.loadWorkspace(state.classId!)}><RefreshCw size={16}/>Tentar novamente</Button> : null}</Surface>
    <div className="min-h-10" aria-live="polite">{state.busy.classes || state.busy.workspace ? <p role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner size="sm"/>Carregando a leitura segura do Conselho…</p> : null}
      {state.failure ? <Alert status="warning"><Alert.Indicator/><Alert.Content><Alert.Title>Operação não concluída</Alert.Title><Alert.Description>{FAILURE[state.failure]}</Alert.Description></Alert.Content></Alert> : null}
      <LiveReadNoticeV1 failed={state.stale}/>
      {message ? <p className="text-sm font-medium text-success">{message}</p> : null}</div>
    {!workspace && !state.busy.workspace ? <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-separator bg-surface-secondary/40 p-8 text-center"><div><Scale className="mx-auto mb-3 text-muted"/><strong className="text-sm">Escolha uma turma para abrir a pauta</strong><p className="mt-1 text-xs text-muted">A fila, os resultados e o histórico serão carregados no mesmo snapshot.</p></div></div> : null}
    {workspace ? <>
      <div className="council-kpi-group" aria-label="Resumo do Conselho"><Metric icon={<Users size={19}/>} label="alunos" value={workspace.summary.total}/><Metric icon={<Scale size={19}/>} label="elegíveis" value={workspace.summary.eligible}/><Metric icon={<Clock3 size={19}/>} label="a deliberar" value={workspace.summary.pending} tone="warning"/><Metric icon={<CheckCircle2 size={19}/>} label="decididos" value={workspace.summary.decided} tone="success"/></div>
      <Card><Card.Header className="flex flex-col gap-3 sm:flex-row sm:items-center"><div><Card.Title>Sessão da turma {workspace.classGroup.label}</Card.Title><Card.Description>Versão institucional {workspace.session.version} · {workspace.session.snapshotCount} fechamento(s) preservado(s)</Card.Description></div>
        <Chip className="sm:ml-auto" color={workspace.session.state === 'open' ? 'success' : workspace.session.state === 'closed' ? 'warning' : 'default'} variant="soft"><Chip.Label>{workspace.session.state === 'open' ? 'Sessão aberta' : workspace.session.state === 'closed' ? 'Sessão fechada' : 'Ainda não iniciada'}</Chip.Label></Chip></Card.Header>
        <Card.Content className="grid gap-3 border-t border-separator pt-4"><div><Label htmlFor="council-session-reason" className="mb-1.5 block text-xs font-medium text-muted">Justificativa da ação na sessão</Label><textarea id="council-session-reason" className="council-textarea" rows={2} value={sessionReason} onChange={(event) => setSessionReason(event.currentTarget.value)} disabled={state.busy.command}/></div>
          <div className="flex flex-wrap gap-2">{workspace.session.state === 'not-opened' ? <Button variant="primary" isDisabled={sessionReason.trim().length < 3 || state.busy.command} onPress={() => void sessionCommand('open')}><CircleDot size={17}/>Abrir reunião</Button> : null}
            {workspace.session.state === 'closed' ? <Button variant="primary" isDisabled={sessionReason.trim().length < 3 || state.busy.command} onPress={() => void sessionCommand('reopen')}><RotateCcw size={17}/>Reabrir com justificativa</Button> : null}
            {workspace.session.state === 'open' && !confirmClose ? <Button variant="secondary" isDisabled={workspace.summary.pending > 0 || sessionReason.trim().length < 3 || state.busy.command} onPress={() => setConfirmClose(true)}><LockKeyhole size={17}/>Revisar fechamento</Button> : null}
          </div>
          {workspace.session.state === 'open' && workspace.summary.pending > 0 ? <p className="text-xs text-warning">Faltam {workspace.summary.pending} decisão(ões) explícita(s) antes do fechamento.</p> : null}
          {confirmClose ? <Alert status="warning"><Alert.Indicator/><Alert.Content><Alert.Title>Confirmar fechamento institucional?</Alert.Title><Alert.Description>As edições serão bloqueadas e um novo snapshot imutável será criado. A correção posterior exige reabertura justificada.</Alert.Description><div className="mt-3 flex gap-2"><Button variant="primary" isDisabled={state.busy.command} onPress={() => void sessionCommand('close')}><Archive size={16}/>Fechar e preservar snapshot</Button><Button variant="ghost" onPress={() => setConfirmClose(false)}>Cancelar</Button></div></Alert.Content></Alert> : null}
        </Card.Content></Card>
      {eligible.length ? <div className="council-layout"><aside className="min-w-0"><div className="council-board" aria-label="Fluxo dos alunos elegíveis"><section className="council-board__column"><header><span className="size-2 rounded-full bg-warning"/><strong>A deliberar</strong><span>{pending.length}</span></header><div className="council-board__cards">{pending.map((student) => <QueueCard key={student.id} student={student} selected={selected?.id === student.id} onSelect={() => setSelectedStudentId(student.id)}/>)}{!pending.length ? <p className="council-board__empty"><Check size={16}/>Fila concluída</p> : null}</div></section>
          <section className="council-board__column"><header><span className="size-2 rounded-full bg-success"/><strong>Decididos</strong><span>{decided.length}</span></header><div className="council-board__cards">{decided.map((student) => <QueueCard key={student.id} student={student} selected={selected?.id === student.id} onSelect={() => setSelectedStudentId(student.id)}/>)}</div></section></div></aside>
          <main className="min-w-0">{selected ? <StudentPanel key={selected.id} student={selected} sessionOpen={workspace.session.state === 'open'} busy={state.busy.command} onCommand={state.command} onMessage={setMessage} onDirtyChange={setStudentDirty}/> : null}</main></div> : <Alert status="default"><Alert.Content><Alert.Title>Nenhum aluno elegível nesta turma</Alert.Title><Alert.Description>Os motivos calculados permanecem disponíveis abaixo; nenhuma decisão foi inventada.</Alert.Description></Alert.Content></Alert>}
      {notEligible.length ? <details className="rounded-2xl border border-separator bg-surface p-4"><summary className="flex cursor-pointer list-none items-center gap-2 font-medium"><Users size={17}/>Não elegíveis <Chip size="sm" variant="soft"><Chip.Label>{notEligible.length}</Chip.Label></Chip><span className="ml-auto text-xs text-muted">Ver motivos</span></summary><ul className="mt-3 grid gap-2">{notEligible.map((student) => <li key={student.id} className="flex flex-col gap-1 rounded-xl bg-surface-secondary p-3 sm:flex-row sm:items-center"><span className="font-medium">Nº {student.number} · {student.name}</span><span className="text-xs text-muted sm:ml-auto">{student.eligibility.label}</span></li>)}</ul></details> : null}
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(18rem,.8fr)]"><Card><Card.Header><div className="flex items-center gap-2"><History size={18}/><Card.Title>Linha do tempo</Card.Title></div><Card.Description>Histórico de ações humanas, sem participantes nominais da votação.</Card.Description></Card.Header><Card.Content>{workspace.timeline.length ? <ol className="council-timeline">{workspace.timeline.map((event, index) => <li key={event.id}><span className="council-timeline__rail"><span className="council-timeline__marker"/>{index < workspace.timeline.length - 1 ? <span className="council-timeline__connector"/> : null}</span><article><div className="flex flex-wrap items-center gap-2"><strong>{TIMELINE_LABEL[event.action]}</strong><Chip size="sm" variant="soft"><Chip.Label>v{event.version}</Chip.Label></Chip></div>{event.studentLabel ? <p className="text-sm">{event.studentLabel}</p> : null}<p className="text-sm text-muted">{event.justification}</p><time className="text-xs text-muted" dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString('pt-BR')}</time></article></li>)}</ol> : <p className="text-sm text-muted">A linha do tempo começará quando a reunião for aberta.</p>}</Card.Content></Card>
        <Card><Card.Header><Card.Title>Fechamentos preservados</Card.Title><Card.Description>Cada reabertura mantém os snapshots anteriores.</Card.Description></Card.Header><Card.Content>{workspace.closures.length ? <ul className="grid gap-2">{workspace.closures.map((closure) => <li key={closure.id} className="rounded-xl border border-separator p-3"><div className="flex items-center gap-2"><Archive size={16}/><strong>Fechamento {closure.sequence}</strong><Chip size="sm" variant="soft" className="ml-auto"><Chip.Label>v{closure.version}</Chip.Label></Chip></div><p className="mt-2 text-xs text-muted">{closure.summary.approved} aprovado(s) · {closure.summary.rejected} reprovado(s) · {closure.summary.absence} por falta</p><time className="mt-1 block text-xs text-muted" dateTime={closure.closedAt}>{new Date(closure.closedAt).toLocaleString('pt-BR')}</time></li>)}</ul> : <p className="text-sm text-muted">Nenhum fechamento realizado.</p>}</Card.Content></Card></div>
    </> : null}
  </section>;
}
