import { useCallback, useId, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import {
  SHIFT_LABELS_V1,
  type ShiftV1,
} from '../../../../shared/student-portal-contracts/core-v1';
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
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString('pt-BR') : 'Indisponível';
const date = (value: string) => value.split('-').reverse().join('/');
const shiftLabel = (value: string) => SHIFT_LABELS_V1[value.toUpperCase() as ShiftV1] ?? value;

export function StudentFrequencyV2({
  client = defaultClient,
  active = true,
  onLogin,
}: {
  client?: StudentFrequencyClientV2;
  active?: boolean;
  onLogin?: () => void;
}) {
  const heading = useId();
  const [month, setMonth] = useState(
    () => '2026-' + String(new Date().getMonth() + 1).padStart(2, '0'),
  );
  const read = useCallback((signal: AbortSignal) => client.read(month, signal), [client, month]);
  const { data: received, pending, error, refresh } = useFrequencyReadV2(read, active);
  const data = received?.month === month ? received : null;
  const reliable = data?.coverage === 'reliable';
  const value = (number: number | null | undefined, percentage = false) =>
    reliable && number !== null && number !== undefined
      ? new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(number) +
        (percentage ? '%' : '')
      : 'Indisponível';
  return (
    <section aria-labelledby={heading} className="pa-frequency">
      <div className="pa-frequency-heading">
        <h2 id={heading} className="pa-section-title">
          Frequência
        </h2>
        <label>
          Mês
          <select aria-label="Mês" value={month} onChange={(event) => setMonth(event.target.value)}>
            {months.map((label, index) => (
              <option key={label} value={'2026-' + String(index + 1).padStart(2, '0')}>
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
      {!data ? (
        <Card>
          <Card.Content>
            <p role={error ? 'alert' : 'status'}>
              {error === 'unauthenticated'
                ? 'Sessão expirada. Entre novamente.'
                : error === 'forbidden'
                  ? 'Frequência indisponível para esta sessão.'
                  : pending
                    ? 'Carregando frequência…'
                    : 'Frequência indisponível.'}
            </p>
            {error === 'unauthenticated' && onLogin ? (
              <Button onPress={onLogin}>Entrar</Button>
            ) : null}
          </Card.Content>
        </Card>
      ) : (
        <>
          <Card>
            <Card.Content>
              <p role="status">
                {reliable
                  ? 'Cobertura conferida'
                  : data.coverage === 'incomplete'
                    ? 'Dados parciais'
                    : 'Cobertura indisponível'}
              </p>
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
                  <dd>{value(data.percentage, true)}</dd>
                </div>
              </dl>
              <p>Coletado em: {time(data.observedAt)}</p>
              <p>Sincronizado em: {time(data.receivedAt)}</p>
              {data.conflicts > 0 ? (
                <p role="status">{data.conflicts} registro(s) aguardando conferência.</p>
              ) : null}
            </Card.Content>
          </Card>
          <Card>
            <Card.Header>
              <Card.Title>Registros conhecidos</Card.Title>
            </Card.Header>
            <Card.Content>
              {data.marks.length === 0 ? (
                <p>Nenhum registro X ou J disponível neste mês.</p>
              ) : (
                <ul className="pa-frequency-marks">
                  {data.marks.map((mark, index) => (
                    <li key={`${mark.date}:${mark.slot}:${mark.shift}:${index}`}>
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
        </>
      )}
    </section>
  );
}
