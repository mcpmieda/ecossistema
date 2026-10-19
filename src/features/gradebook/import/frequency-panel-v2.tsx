import { useCallback, useEffect, useId, useState } from 'react';
import { Alert } from '@heroui/react/alert';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Chip } from '@heroui/react/chip';
import {
  type FrequencyDeviceV2,
  type FrequencyConflictV2,
  type FrequencyFailureEntryV2,
  type FrequencyStatusV2,
  type FrequencyUnresolvedV2,
} from '../../../../shared/attendance-contracts/frequency-v2';
import { SHIFT_LABELS_V1, type ShiftV1 } from '../../../../shared/student-portal-contracts/core-v1';
import { studentPortalHref } from '../../../platform/student-portal-module';
import {
  createFrequencyAdminClientV2,
  type FrequencyAdminClientV2,
  type FrequencyAdminCommandV2,
} from './frequency-client-v2';
import { useFrequencyReadV2 } from '../../student-portal/frequency/use-frequency-read-v2';
import './frequency-panel-v2.css';

type Mutate = (input: FrequencyAdminCommandV2) => Promise<boolean>;

const defaultClient = createFrequencyAdminClientV2();
const weekdays = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
];
const labels: Record<FrequencyDeviceV2['state'], string> = {
  ready: 'Pronto',
  collecting: 'Coletando',
  reserve: 'Reserva',
  paused: 'Pausado',
  'login-required': 'Sessão da fonte expirada',
  error: 'Erro',
  offline: 'Offline',
  revoked: 'Revogado',
};
const errors: Record<string, string> = {
  unauthenticated: 'Sessão expirada. Entre novamente.',
  forbidden: 'Você não tem acesso à frequência.',
  'not-authorized': 'Sessão expirada ou sem autorização. Entre novamente para conferir o acesso.',
  'revision-conflict':
    'Outra pessoa alterou estes dados. Atualize e confira antes de salvar novamente.',
  unavailable: 'Frequência indisponível. Tente atualizar novamente.',
  'invalid-request': 'Confira os campos antes de continuar.',
  'lease-busy': 'Há uma coleta em andamento. Tente novamente depois.',
  'lease-fenced': 'A coleta foi substituída. Atualize os dados.',
  paused: 'A coleta escolar está pausada.',
  'source-invalid': 'A fonte precisa de conferência.',
  'identity-review': 'Há alunos aguardando conciliação.',
};
const failureCodes: Record<string, string> = {
  ...errors,
  unavailable: 'Serviço indisponível',
  'source-invalid': 'Dados recusados',
  'identity-review': 'Turma ou aluno sem conciliação',
  'revision-conflict': 'Dados alterados por outra operação',
  'lease-fenced': 'Coleta substituída',
  'not-authorized': 'Acesso negado',
  'invalid-request': 'Pedido inválido',
  SOURCE_LOGIN_REQUIRED: 'Smecel desconectado',
  SOURCE_CLASS_UNAVAILABLE: 'Turma ausente na lista do Smecel',
  SOURCE_CLASS_AMBIGUOUS: 'Turma sem ligação no Centro',
  CLASS_RECONCILIATION_REQUIRED: 'Turma sem ligação no Centro',
  CENTER_CLASSES_REQUIRED: 'Relação e Relatório não importados',
  NO_SELECTED_CLASSES: 'Nenhuma turma selecionada no computador',
  PROTECTED_STORAGE_UNAVAILABLE: 'Proteção de dados do Windows indisponível',
  PROTECTED_STORAGE_LIMIT: 'Fila de envio cheia',
  LEASE_FENCED: 'Coleta substituída',
  REVISION_CONFLICT: 'Lote pendente desatualizado',
  SOURCE_INVALID: 'Diário recusado',
  IDENTITY_REVIEW: 'Turma ou aluno sem conciliação',
  UNAVAILABLE: 'Sem conexão com o Centro',
};
const failureDetails: Record<string, string> = {
  'class-not-linked': 'A turma do Smecel não está ligada a uma turma da Relação.',
  'class-shift-ambiguous': 'A turma aparece em mais de um turno.',
  'record-class-mismatch': 'Há aluno de outra turma no diário.',
  'observed-in-future': 'O relógio do computador está adiantado.',
  'older-than-last-collection': 'O diário é mais antigo que a última coleta.',
  'mark-outside-enrollment': 'Há falta fora do período de matrícula do aluno.',
  'mark-after-capture': 'Há falta em data posterior à leitura.',
  'coverage-after-capture': 'Há registro em data posterior à leitura.',
  'source-version-reused': 'O mesmo diário chegou com conteúdo diferente.',
  'request-retired': 'Pedido de um ano já reiniciado.',
};
const origins: Record<FrequencyFailureEntryV2['origin'], string> = {
  collector: 'Coletor',
  admin: 'Centro',
  'device-report': 'Computador',
};
const operations: Record<string, string> = {
  collect: 'Envio da frequência',
  heartbeat: 'Estado do computador',
  lease: 'Início da coleta',
  release: 'Fim da coleta',
  receipt: 'Recibo',
  'save-settings': 'Agenda',
  'set-paused': 'Pausa',
  'rename-device': 'Nome do computador',
  'revoke-device': 'Revogação',
  'resolve-conflict': 'Conflito',
};
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString('pt-BR') : 'Sem comunicação';
const date = (value: string) => value.split('-').reverse().join('/');
const shiftLabel = (value: string) => SHIFT_LABELS_V1[value.toUpperCase() as ShiftV1] ?? value;
function markLabel(mark: 'X' | 'J' | null): string {
  if (mark === null) return 'Remoção';
  return mark === 'X' ? 'Falta (X)' : 'Justificada (J)';
}
function chipLabel(device: FrequencyDeviceV2, leader: boolean): string {
  if (leader && device.state === 'ready') return 'Líder';
  if (leader && device.state === 'collecting') return 'Coletando · Líder';
  return labels[device.state];
}
function chipColor(device: FrequencyDeviceV2, leader: boolean) {
  if (device.state === 'revoked' || device.state === 'error') return 'danger';
  return leader ? 'accent' : 'default';
}

function FrequencyDeviceCardV2({
  device,
  leader,
  classLabel,
  busy,
  mutate,
}: Readonly<{
  device: FrequencyDeviceV2;
  leader: boolean;
  classLabel: string;
  busy: boolean;
  mutate: Mutate;
}>) {
  const [rename, setRename] = useState(false);
  const [label, setLabel] = useState(device.label);
  const [confirm, setConfirm] = useState(false);
  const revoked = device.state === 'revoked';
  return (
    <Card>
      <Card.Header>
        <Card.Title>{device.label}</Card.Title>
        <Chip size="sm" variant="soft" color={chipColor(device, leader)}>
          {chipLabel(device, leader)}
        </Chip>
      </Card.Header>
      <Card.Content>
        <dl className="frequency-device-details">
          <div>
            <dt>Última comunicação</dt>
            <dd>{time(device.lastSeenAt)}</dd>
          </div>
          <div>
            <dt>Última coleta</dt>
            <dd>{device.lastCollectionAt ? time(device.lastCollectionAt) : 'Sem coleta'}</dd>
          </div>
          <div>
            <dt>Turma atual</dt>
            <dd>{classLabel}</dd>
          </div>
        </dl>
        {rename ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate({ operation: 'rename-device', deviceId: device.deviceId, label }).then(
                (ok) => {
                  if (ok) setRename(false);
                },
              );
            }}
          >
            <label>
              <span>Nome do computador</span>
              <input
                value={label}
                maxLength={80}
                onChange={(event) => setLabel(event.target.value)}
                required
              />
            </label>
            <div className="frequency-actions">
              <Button type="submit" isDisabled={busy || !label.trim()}>
                Salvar nome
              </Button>
              <Button variant="secondary" isDisabled={busy} onPress={() => setRename(false)}>
                Cancelar
              </Button>
            </div>
          </form>
        ) : (
          <div className="frequency-actions">
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy || revoked}
              onPress={() => {
                setLabel(device.label);
                setRename(true);
              }}
            >
              Renomear computador
            </Button>
            <Button
              size="sm"
              variant="danger-soft"
              isDisabled={busy || revoked}
              onPress={() => setConfirm(true)}
            >
              Revogar computador
            </Button>
          </div>
        )}
        {confirm ? (
          <fieldset className="frequency-confirm">
            <legend>Confirmar revogação de {device.label}</legend>
            <p>
              Revogar {device.label}? Este computador deixará de coletar. Para voltar, será
              necessário autorizá-lo novamente.
            </p>
            <div className="frequency-actions">
              <Button
                variant="danger"
                isDisabled={busy}
                onPress={() => {
                  void mutate({ operation: 'revoke-device', deviceId: device.deviceId }).then(
                    (ok) => {
                      if (ok) setConfirm(false);
                    },
                  );
                }}
              >
                Confirmar revogação
              </Button>
              <Button variant="secondary" isDisabled={busy} onPress={() => setConfirm(false)}>
                Cancelar revogação
              </Button>
            </div>
          </fieldset>
        ) : null}
      </Card.Content>
    </Card>
  );
}

function FrequencyConflictCardV2({
  conflict,
  busy,
  resolve,
}: Readonly<{
  conflict: FrequencyConflictV2;
  busy: boolean;
  resolve: (mark: 'X' | 'J' | null, reason: string) => Promise<boolean>;
}>) {
  const [review, setReview] = useState(false);
  const [choice, setChoice] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Card>
      <Card.Header>
        <Card.Title>{conflict.studentName}</Card.Title>
      </Card.Header>
      <Card.Content>
        <p>
          {conflict.classLabel} · {date(conflict.date)} · Posição {conflict.slot} ·{' '}
          {shiftLabel(conflict.shift)}
        </p>
        <p>Valores encontrados: {conflict.marks.map(markLabel).join(' / ')}</p>
        {review ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!choice || !reason.trim()) return;
              const mark = choice === 'remove' ? null : (choice as 'X' | 'J');
              void resolve(mark, reason).then((ok) => {
                if (!ok) return;
                setReview(false);
                setReason('');
                setChoice('');
              });
            }}
          >
            <label>
              <span>Decisão</span>
              <select
                aria-label="Decisão"
                value={choice}
                onChange={(event) => setChoice(event.target.value)}
                required
              >
                <option value="">Selecione</option>
                {conflict.marks.includes('X') ? <option value="X">Falta (X)</option> : null}
                {conflict.marks.includes('J') ? <option value="J">Justificada (J)</option> : null}
                {conflict.marks.includes(null) ? (
                  <option value="remove">Remover marcação</option>
                ) : null}
              </select>
            </label>
            <label>
              <span>Motivo da decisão</span>
              <textarea
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
                required
                rows={3}
              />
            </label>
            <div className="frequency-actions">
              <Button type="submit" isDisabled={busy || !choice || !reason.trim()}>
                Confirmar decisão
              </Button>
              <Button variant="secondary" isDisabled={busy} onPress={() => setReview(false)}>
                Cancelar conferência
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="secondary" size="sm" isDisabled={busy} onPress={() => setReview(true)}>
            Conferir conflito
          </Button>
        )}
      </Card.Content>
    </Card>
  );
}

/** The agenda is configured only in the Coletor de Frequência; here it is read-only. */
function ScheduleSummaryV2({ data }: Readonly<{ data: FrequencyStatusV2 }>) {
  const schedule = data.settings.schedule;
  const days = weekdays
    .map((name, weekday) => {
      const moments = [
        ...new Set(
          (schedule?.rules ?? [])
            .filter((rule) => rule.enabled && rule.weekday === weekday)
            .flatMap((rule) => [...rule.times, ...(rule.recheck ? [rule.recheck] : [])]),
        ),
      ].sort((a, b) => a.localeCompare(b));
      return { name, moments };
    })
    .filter((day) => day.moments.length > 0);
  return (
    <section aria-label="Agenda de coleta">
      <h4>Agenda de coleta</h4>
      <p className="frequency-muted">Configurada no Coletor de Frequência.</p>
      {days.length === 0 ? (
        <p>Nenhum horário definido.</p>
      ) : (
        <ul className="frequency-list">
          {days.map((day) => (
            <li key={day.name}>
              <strong>{day.name}</strong>
              <span>
                {day.moments.length} coleta(s) · {day.moments[0]} a {day.moments.at(-1)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ClassCollectionsV2({ data }: Readonly<{ data: FrequencyStatusV2 }>) {
  return (
    <section aria-label="Últimas coletas por turma">
      <h4>Últimas coletas por turma</h4>
      {data.classes.length === 0 ? (
        <p>Nenhuma turma disponível. Importe a Relação e o Relatório e confira as turmas.</p>
      ) : (
        <div className="frequency-cards">
          {data.classes.map((item) => {
            const collection = data.collections
              .filter((c) => c.classId === item.classId)
              .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
            return (
              <Card key={`${item.classId}:${item.sourceClassLabel}`}>
                <Card.Header>
                  <Card.Title>{item.sourceClassLabel}</Card.Title>
                </Card.Header>
                <Card.Content>
                  <p>{shiftLabel(item.shift)}</p>
                  {collection ? (
                    <>
                      <p>Coletado em: {time(collection.observedAt)}</p>
                      <p>Sincronizado em: {time(collection.receivedAt)}</p>
                      <p>{collection.resolvedRecords} aluno(s) conciliado(s)</p>
                      <p>
                        {collection.unresolvedRecords} aluno(s) não reconhecido(s) ·{' '}
                        {collection.conflicts} conflito(s)
                      </p>
                    </>
                  ) : (
                    <p>Sem coleta disponível.</p>
                  )}
                </Card.Content>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

function UnresolvedStudentsV2({
  unresolved,
  onOpenReport,
}: Readonly<{ unresolved: FrequencyUnresolvedV2[]; onOpenReport?: () => void }>) {
  if (unresolved.length === 0) return null;
  const notFound = unresolved.some((u) => u.reason === 'not_found');
  const ambiguous = unresolved.some((u) => u.reason === 'ambiguous');
  return (
    <section aria-label="Alunos não reconhecidos">
      <h4>Alunos não reconhecidos</h4>
      <p>As faltas destes alunos só chegam ao Portal depois da conciliação.</p>
      <div className="frequency-actions">
        {notFound && onOpenReport ? (
          <Button size="sm" variant="secondary" onPress={onOpenReport}>
            Atualizar Relatório
          </Button>
        ) : null}
        {ambiguous ? (
          <a className="frequency-link" href={studentPortalHref('reconciliation')}>
            Abrir Conciliação
          </a>
        ) : null}
      </div>
      <ul className="frequency-list">
        {unresolved.map((item) => (
          <li key={`${item.classId}:${item.name}:${item.reason}`}>
            <strong>{item.name}</strong>
            <span>
              {item.classLabel} ·{' '}
              {item.reason === 'not_found' ? 'Não está no Relatório' : 'Conferir na Conciliação'} ·{' '}
              {item.marks} registro(s) aguardando
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FailureTrailV2({ data }: Readonly<{ data: FrequencyStatusV2 }>) {
  const deviceName = (id: string | null) =>
    data.devices.find((d) => d.deviceId === id)?.label ?? null;
  const className = (id: number | null) =>
    data.classes.find((c) => c.classId === id)?.sourceClassLabel ?? null;
  return (
    <section aria-label="Falhas dos últimos 7 dias">
      <h4>Falhas dos últimos 7 dias</h4>
      {data.failures.length === 0 ? (
        <p>Nenhuma falha registrada.</p>
      ) : (
        <ul className="frequency-list">
          {data.failures.map((failure) => {
            const where = [
              origins[failure.origin],
              operations[failure.operation] ?? failure.operation,
              deviceName(failure.deviceId),
              className(failure.classId),
            ].filter(Boolean);
            const repeated =
              failure.occurrences > 1
                ? ` · ${failure.occurrences} vezes desde ${time(failure.firstAt)}`
                : '';
            return (
              <li
                key={`${failure.lastAt}:${failure.code}:${failure.detail}:${failure.deviceId ?? ''}`}
              >
                <strong>{failureCodes[failure.code] ?? failure.code}</strong>
                <span>{failureDetails[failure.detail] ?? failure.detail}</span>
                <span>
                  {time(failure.lastAt)} · {where.join(' · ')}
                  {repeated}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

type SectionProps = Readonly<{ data: FrequencyStatusV2; pending: boolean; mutate: Mutate }>;
function isLeader(data: FrequencyStatusV2, device: FrequencyDeviceV2): boolean {
  return (
    data.lease?.deviceId === device.deviceId &&
    Date.parse(data.lease.expiresAt) > Date.parse(data.serverTime)
  );
}
function DevicesSectionV2({ data, pending, mutate }: SectionProps) {
  const classLabel = (classId: number | null) =>
    data.classes.find((item) => item.classId === classId)?.sourceClassLabel ??
    'Sem turma em coleta';
  return (
    <section aria-label="Computadores autorizados">
      <h4>Computadores autorizados</h4>
      {data.devices.length === 0 ? (
        <p>Nenhum computador registrado.</p>
      ) : (
        <div className="frequency-cards">
          {data.devices.map((device) => (
            <FrequencyDeviceCardV2
              key={device.deviceId}
              device={device}
              leader={isLeader(data, device)}
              busy={pending}
              classLabel={classLabel(device.classId)}
              mutate={mutate}
            />
          ))}
        </div>
      )}
    </section>
  );
}
function ConflictsSectionV2({ data, pending, mutate }: SectionProps) {
  return (
    <section aria-label="Conflitos de frequência">
      <h4>Conflitos de frequência</h4>
      {data.conflicts.length === 0 ? (
        <p>Nenhum conflito pendente.</p>
      ) : (
        <div className="frequency-cards">
          {data.conflicts.map((conflict) => (
            <FrequencyConflictCardV2
              key={`${conflict.id}:${conflict.revision}`}
              conflict={conflict}
              busy={pending}
              resolve={(mark, reason) =>
                mutate({
                  operation: 'resolve-conflict',
                  conflictId: conflict.id,
                  expectedRevision: conflict.revision,
                  mark,
                  reason,
                })
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function FrequencyPanelV2({
  active = true,
  client = defaultClient,
  onOpenReport,
}: Readonly<{
  active?: boolean;
  client?: FrequencyAdminClientV2;
  onOpenReport?: () => void;
}>) {
  const heading = useId();
  const read = useCallback((signal: AbortSignal) => client.status(signal), [client]);
  const { data, pending, error, refresh, perform } = useFrequencyReadV2(read, active);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!active) setMessage('');
  }, [active]);
  const mutate: Mutate = async (input) => {
    setMessage('');
    const result = await perform((signal) =>
      client.mutate({ ...input, academicYear: 2026, requestId: crypto.randomUUID() }, signal),
    );
    if (result) setMessage('Alteração confirmada.');
    return result;
  };
  const alert = error ? (errors[error] ?? errors.unavailable) : '';
  return (
    <section className="frequency-admin" aria-labelledby={heading}>
      <div className="frequency-heading">
        <div>
          <h3 id={heading}>Frequência</h3>
          <p>{schoolState(data)}</p>
        </div>
        <div className="frequency-actions">
          <Button
            variant="secondary"
            isDisabled={pending}
            onPress={() => {
              void refresh();
            }}
          >
            Atualizar frequência
          </Button>
          {data ? (
            <Button
              isDisabled={pending}
              variant={data.settings.paused ? 'primary' : 'secondary'}
              onPress={() => {
                void mutate({
                  operation: 'set-paused',
                  paused: !data.settings.paused,
                  expectedRevision: data.settings.revision,
                });
              }}
            >
              {data.settings.paused ? 'Retomar coleta escolar' : 'Pausar coleta escolar'}
            </Button>
          ) : null}
        </div>
      </div>
      {alert ? (
        <Alert status="warning" role="alert">
          <Alert.Content>
            <Alert.Title>{alert}</Alert.Title>
          </Alert.Content>
        </Alert>
      ) : null}
      {message ? <output>{message}</output> : null}
      {data ? (
        <>
          <DevicesSectionV2 data={data} pending={pending} mutate={mutate} />
          <ScheduleSummaryV2 data={data} />
          <UnresolvedStudentsV2 unresolved={data.unresolved} onOpenReport={onOpenReport} />
          <ClassCollectionsV2 data={data} />
          <ConflictsSectionV2 data={data} pending={pending} mutate={mutate} />
          <FailureTrailV2 data={data} />
        </>
      ) : (
        <Card>
          <Card.Content>
            <output>
              {pending
                ? 'Carregando frequência…'
                : 'Computadores, coletas e conflitos indisponíveis.'}
            </output>
          </Card.Content>
        </Card>
      )}
    </section>
  );
}
function schoolState(data: FrequencyStatusV2 | null): string {
  if (!data) return 'Sem status disponível';
  return data.settings.paused ? 'Coleta escolar pausada' : 'Coleta escolar liberada';
}
