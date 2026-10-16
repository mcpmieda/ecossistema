import { useCallback, useId, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import type { FrequencySummaryV2 } from '../../../../shared/attendance-contracts/frequency-v2';
import { SHIFT_LABELS_V1, type ShiftV1 } from '../../../../shared/student-portal-contracts/core-v1';
import { createStudentFrequencyClientV2, type StudentFrequencyClientV2 } from './client-v2';
import { useFrequencyReadV2 } from './use-frequency-read-v2';
import './student-frequency-v2.css';

const defaultClient = createStudentFrequencyClientV2();
const months = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];
const coverageLabels: Record<FrequencySummaryV2['coverage'], string> = {
  reliable: 'Cobertura conferida',
  incomplete: 'Dados parciais',
  unavailable: 'Cobertura indisponível',
};
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString('pt-BR') : 'Indisponível';
const date = (value: string) => value.split('-').reverse().join('/');
const shiftLabel = (value: string) => SHIFT_LABELS_V1[value.toUpperCase() as ShiftV1] ?? value;
const monthValue = (index: number) => '2026-' + String(index + 1).padStart(2, '0');
function unavailableMessage(error: string | null, pending: boolean): string {
  if (error === 'unauthenticated') return 'Sessão expirada. Entre novamente.';
  if (error === 'forbidden') return 'Frequência indisponível para esta sessão.';
  return pending ? 'Carregando frequência…' : 'Frequência indisponível.';
}

function FrequencyUnavailableV2({
  error,
  pending,
  onLogin,
  onAuthenticationLost,
}: Readonly<{ error: string | null; pending: boolean; onLogin?: () => void }>) {
  const message = unavailableMessage(error, pending);
  return (
    <Card>
      <Card.Content>
        {error ? <p role="alert">{message}</p> : <output>{message}</output>}
        {error === 'unauthenticated' && onLogin ? <Button onPress={onLogin}>Entrar</Button> : null}
      </Card.Content>
    </Card>
  );
}

function FrequencyTotalsV2({ data }: Readonly<{ data: FrequencySummaryV2 }>) {
  const reliable = data.coverage === 'reliable';
  const value = (number: number | null, suffix = '') =>
    reliable && number !== null
      ? new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(number) + suffix
      : 'Indisponível';
  return (
    <Card>
      <Card.Content>
        <output>{coverageLabels[data.coverage]}</output>
        <dl className="pa-frequency-totals">
          <div>
            <dt>Faltas</dt>
            <dd>{value(data.absences)}</dd>
          </div>
          <div>
            <dt>Justificadas</dt>
            <dd>{value(data.justified)}</dd>
          </div>
          <div>
            <dt>Aulas consideradas</dt>
            <dd>{value(data.denominator)}</dd>
          </div>
          <div>
            <dt>Frequência</dt>
            <dd>{value(data.percentage, '%')}</dd>
          </div>
        </dl>
        <p>Coletado em: {time(data.observedAt)}</p>
        <p>Sincronizado em: {time(data.receivedAt)}</p>
        {data.conflicts > 0 ? (
          <output>{data.conflicts} registro(s) aguardando conferência.</output>
        ) : null}
      </Card.Content>
    </Card>
  );
}

function FrequencyMarksV2({ marks }: Readonly<{ marks: FrequencySummaryV2['marks'] }>) {
  return (
    <Card>
      <Card.Header>
        <Card.Title>Registros conhecidos</Card.Title>
      </Card.Header>
      <Card.Content>
        {marks.length === 0 ? (
          <p>Nenhum registro X ou J disponível neste mês.</p>
        ) : (
          <ul className="pa-frequency-marks">
            {marks.map((mark) => (
              <li key={`${mark.date}:${mark.slot}:${mark.shift}`}>
                <strong>
                  {date(mark.date)} · {mark.mark === 'X' ? 'Falta (X)' : 'Justificada (J)'}
                </strong>
                <span>
                  Posição {mark.slot} · {shiftLabel(mark.shift)}
                </span>
                <span>Turma de origem: {mark.classLabels.join(' / ') || 'Indisponível'}</span>
              </li>
            ))}
          </ul>
        )}
      </Card.Content>
    </Card>
  );
}

export function StudentFrequencyV2({
  client = defaultClient,
  active = true,
  onLogin,
}: Readonly<{
  client?: StudentFrequencyClientV2;
  active?: boolean;
  onLogin?: () => void;
  onAuthenticationLost?: () => void;
}>) {
  const heading = useId();
  const [month, setMonth] = useState(() => monthValue(new Date().getMonth()));
  const read = useCallback((signal: AbortSignal) => client.read(month, signal), [client, month]);
  const { data: received, pending, error, refresh } = useFrequencyReadV2(read, active, onAuthenticationLost);
  const data = received?.month === month ? received : null;
  return (
    <section aria-labelledby={heading} className="pa-frequency">
      <div className="pa-frequency-heading">
        <h2 id={heading} className="pa-section-title">
          Frequência
        </h2>
        <label>
          <span>Mês</span>
          <select aria-label="Mês" value={month} onChange={(event) => setMonth(event.target.value)}>
            {months.map((label, index) => (
              <option key={label} value={monthValue(index)}>
                {label} de 2026
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="secondary"
          isDisabled={pending}
          onPress={() => {
            void refresh();
          }}
        >
          Atualizar frequência
        </Button>
      </div>
      {data ? (
        <>
          <FrequencyTotalsV2 data={data} />
          <FrequencyMarksV2 marks={data.marks} />
        </>
      ) : (
        <FrequencyUnavailableV2 error={error} pending={pending} onLogin={onLogin} />
      )}
    </section>
  );
}
