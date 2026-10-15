import { useCallback, useEffect, useId, useState } from 'react';
import { Alert } from '@heroui/react/alert';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Chip } from '@heroui/react/chip';
import {
  frequencyScheduleV2,
  type FrequencyScheduleV2,
  type FrequencyDeviceV2,
  type FrequencyConflictV2,
} from '../../../../shared/attendance-contracts/frequency-v2';
import {
  createFrequencyAdminClientV2,
  type FrequencyAdminClientV2,
  type FrequencyAdminCommandV2,
} from './frequency-client-v2';
import { useFrequencyReadV2 } from '../../student-portal/frequency/use-frequency-read-v2';
import './frequency-panel-v2.css';

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
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString('pt-BR') : 'Sem comunicação';
const markLabel = (mark: 'X' | 'J' | null) =>
  mark === null ? 'Remoção' : mark === 'X' ? 'Falta (X)' : 'Justificada (J)';
const shiftLabel = (value: string) =>
  value === 'matutino' ? 'Matutino' : value === 'vespertino' ? 'Vespertino' : value;
function emptySchedule(): FrequencyScheduleV2 {
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    rules: weekdays.flatMap((_, weekday) =>
      (['matutino', 'vespertino'] as const).map((shift) => ({
        weekday,
        shift,
        enabled: false,
        times: [],
        recheck: null,
      })),
    ),
  };
}

function FrequencyDeviceCardV2({
  device,
  leader,
  classLabel,
  busy,
  mutate,
}: {
  device: FrequencyDeviceV2;
  leader: boolean;
  classLabel: string;
  busy: boolean;
  mutate(
    input: Extract<FrequencyAdminCommandV2, { operation: 'rename-device' | 'revoke-device' }>,
  ): Promise<boolean>;
}) {
  const [rename, setRename] = useState(false);
  const [label, setLabel] = useState(device.label);
  const [confirm, setConfirm] = useState(false);
  const revoked = device.state === 'revoked';
  return (
    <Card>
      <Card.Header>
        <Card.Title>{device.label}</Card.Title>
        <Chip
          size="sm"
          variant="soft"
          color={revoked || device.state === 'error' ? 'danger' : leader ? 'accent' : 'default'}
        >
          {leader && device.state === 'ready' ? 'Líder' : labels[device.state]}
          {leader && device.state === 'collecting' ? ' · Líder' : ''}
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
              Nome do computador
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
          <div
            role="group"
            aria-label={'Confirmar revogação de ' + device.label}
            className="frequency-confirm"
          >
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
          </div>
        ) : null}
      </Card.Content>
    </Card>
  );
}

function FrequencyConflictCardV2({
  conflict,
  busy,
  resolve,
}: {
  conflict: FrequencyConflictV2;
  busy: boolean;
  resolve(mark: 'X' | 'J' | null, reason: string): Promise<boolean>;
}) {
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
          {conflict.classLabel} · {conflict.date.split('-').reverse().join('/')} · Posição{' '}
          {conflict.slot} · {shiftLabel(conflict.shift)}
        </p>
        <p>Valores encontrados: {conflict.marks.map(markLabel).join(' / ')}</p>
        {review ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!choice || !reason.trim()) return;
              void resolve(choice === 'remove' ? null : (choice as 'X' | 'J'), reason).then(
                (ok) => {
                  if (ok) {
                    setReview(false);
                    setReason('');
                    setChoice('');
                  }
                },
              );
            }}
          >
            <label>
              Decisão
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
              Motivo da decisão
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

export function FrequencyPanelV2({
  active = true,
  client = defaultClient,
}: {
  active?: boolean;
  client?: FrequencyAdminClientV2;
}) {
  const heading = useId();
  const read = useCallback((signal: AbortSignal) => client.status(signal), [client]);
  const { data, pending, error, refresh, perform } = useFrequencyReadV2(read, active);
  const [draft, setDraft] = useState<FrequencyScheduleV2>(emptySchedule);
  const [timesDraft, setTimesDraft] = useState<Record<number, string>>({});
  const [dirty, setDirty] = useState(false);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [localError, setLocalError] = useState('');
  useEffect(() => {
    if (data && !dirty) {
      const schedule = data.settings.schedule ?? emptySchedule();
      setDraft(schedule);
      setTimesDraft(
        Object.fromEntries(schedule.rules.map((rule, index) => [index, rule.times.join(', ')])),
      );
      setDraftRevision(data.settings.revision);
    }
  }, [data, dirty]);
  useEffect(() => {
    if (!active) {
      setMessage('');
      setLocalError('');
    }
  }, [active]);
  const mutate = async (input: FrequencyAdminCommandV2) => {
    setMessage('');
    setLocalError('');
    const result = await perform((signal) =>
      client.mutate({ ...input, academicYear: 2026, requestId: crypto.randomUUID() }, signal),
    );
    if (result) setMessage('Alteração confirmada.');
    return result;
  };
  const changeRule = (index: number, value: Partial<FrequencyScheduleV2['rules'][number]>) => {
    setDirty(true);
    setDraft((current) => ({
      ...current,
      rules: current.rules.map((rule, i) => (i === index ? { ...rule, ...value } : rule)),
    }));
  };
  const isStale = data && dirty && draftRevision !== data.settings.revision;
  return (
    <section className="frequency-admin" aria-labelledby={heading}>
      <div className="frequency-heading">
        <div>
          <h3 id={heading}>Frequência</h3>
          <p>
            {data
              ? data.settings.paused
                ? 'Coleta escolar pausada'
                : 'Coleta escolar liberada'
              : 'Sem status disponível'}
          </p>
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
      {error || localError ? (
        <Alert status="warning" role="alert">
          <Alert.Content>
            <Alert.Title>{localError || errors[error!] || errors.unavailable}</Alert.Title>
          </Alert.Content>
        </Alert>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {!data ? (
        <Card>
          <Card.Content>
            <p role="status">
              {pending
                ? 'Carregando frequência…'
                : 'Computadores, coletas e conflitos indisponíveis.'}
            </p>
          </Card.Content>
        </Card>
      ) : (
        <>
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
                    leader={
                      data.lease?.deviceId === device.deviceId &&
                      Date.parse(data.lease.expiresAt) > Date.parse(data.serverTime)
                    }
                    busy={pending}
                    classLabel={
                      data.classes.find((item) => item.classId === device.classId)
                        ?.sourceClassLabel ?? 'Sem turma em coleta'
                    }
                    mutate={mutate}
                  />
                ))}
              </div>
            )}
          </section>
          <Card>
            <Card.Header>
              <Card.Title>Agenda compartilhada</Card.Title>
            </Card.Header>
            <Card.Content>
              {isStale ? (
                <p role="alert">
                  A agenda mudou durante sua edição. Seu rascunho foi preservado. Confira a agenda
                  atual antes de continuar.
                </p>
              ) : null}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const parsed = frequencyScheduleV2.safeParse({
                    ...draft,
                    rules: draft.rules.map((rule, index) => ({
                      ...rule,
                      times: (timesDraft[index] ?? rule.times.join(', '))
                        .split(',')
                        .map((value) => value.trim())
                        .filter(Boolean),
                    })),
                  });
                  if (!parsed.success) {
                    setLocalError('Confira o fuso e os horários da agenda.');
                    return;
                  }
                  if (draftRevision === null) return;
                  void mutate({
                    operation: 'save-settings',
                    expectedRevision: draftRevision,
                    schedule: parsed.data,
                  }).then((ok) => {
                    if (ok) setDirty(false);
                  });
                }}
              >
                <fieldset
                  disabled={pending || (!dirty && draftRevision !== data.settings.revision)}
                >
                  <label>
                    Fuso horário
                    <input
                      value={draft.timezone}
                      maxLength={80}
                      placeholder="America/Sao_Paulo"
                      onChange={(event) => {
                        setDirty(true);
                        setDraft((current) => ({ ...current, timezone: event.target.value }));
                      }}
                    />
                  </label>
                  <div className="frequency-schedule">
                    {draft.rules.map((rule, index) => (
                      <fieldset key={`${rule.weekday}:${rule.shift}`}>
                        <legend>
                          {weekdays[rule.weekday]} · {shiftLabel(rule.shift)}
                        </legend>
                        <label className="frequency-checkbox">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={(event) =>
                              changeRule(index, { enabled: event.target.checked })
                            }
                          />
                          Coletar neste turno
                        </label>
                        <label>
                          Horários de coleta
                          <input
                            value={timesDraft[index] ?? rule.times.join(', ')}
                            placeholder="07:30, 11:30"
                            disabled={!rule.enabled}
                            onChange={(event) => {
                              setDirty(true);
                              setTimesDraft((current) => ({
                                ...current,
                                [index]: event.target.value,
                              }));
                            }}
                          />
                        </label>
                        <label>
                          Rechecagem
                          <input
                            type="time"
                            value={rule.recheck ?? ''}
                            disabled={!rule.enabled}
                            onChange={(event) =>
                              changeRule(index, { recheck: event.target.value || null })
                            }
                          />
                        </label>
                      </fieldset>
                    ))}
                  </div>
                  <div className="frequency-actions">
                    <Button type="submit" isDisabled={pending || !dirty || Boolean(isStale)}>
                      Salvar agenda
                    </Button>
                    <Button
                      variant="secondary"
                      isDisabled={pending || !dirty}
                      onPress={() => {
                        setDraft(data.settings.schedule ?? emptySchedule());
                        setDraftRevision(data.settings.revision);
                        setDirty(false);
                      }}
                    >
                      Usar agenda atual
                    </Button>
                  </div>
                </fieldset>
              </form>
            </Card.Content>
          </Card>
          <section aria-label="Últimas coletas por turma">
            <h4>Últimas coletas por turma</h4>
            {data.classes.length === 0 ? (
              <p>Nenhuma turma disponível.</p>
            ) : (
              <div className="frequency-cards">
                {data.classes.map((item) => {
                  const collection = data.collections
                    .filter((c) => c.classId === item.classId)
                    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
                  return (
                    <Card key={item.classId}>
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
                              {collection.unresolvedRecords} aluno(s) aguardando conciliação ·{' '}
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
        </>
      )}
    </section>
  );
}
