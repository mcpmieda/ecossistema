import { useEffect, useState } from 'react';
import { Alert, Button, Card, Chip } from '@heroui/react';
import type { AutomaticReportV1 } from '../../../../shared/student-identity/reconciliation-v1';
import type { ReconciliationClientV1 } from '../shared/reconciliation-client-v1';

const OUTCOME_V1: Record<AutomaticReportV1['outcome'], { label: string; color: 'success' | 'warning' | 'default' }> = {
  applied: { label: 'Aplicado', color: 'success' },
  preparing: { label: 'Aplicando', color: 'default' },
  awaiting_relation: { label: 'Aguardando Relação', color: 'warning' },
  review: { label: 'Nada aplicado', color: 'warning' },
};
/** What the outcome means for the rows that were right: only `applied` has applied them. */
const SUMMARY_V1: Record<AutomaticReportV1['outcome'], string> = {
  applied: 'O que estava certo foi aplicado; confira abaixo o que ficou de fora.',
  preparing: 'A aplicação ainda está em andamento; confira abaixo o que ficou de fora.',
  awaiting_relation: 'Nada aplicado ainda: o relatório aguarda a Relação; confira abaixo.',
  review: 'Nada foi aplicado; confira abaixo o motivo.',
};
const when = (value: string) =>
  new Date(value).toLocaleString('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  });

/**
 * The Coletor's automatic "Relatório de alunos" (owner decision 29/10/2026): what it applied, and
 * every difference it did not hold back on (rows with an invalid cell, unlinked classes, origins
 * missing from the report). Shown only when there is something to confer.
 */
export function AutomaticReportPanelV1({
  client,
  refresh,
}: Readonly<{ client: ReconciliationClientV1; refresh: number }>) {
  const [report, setReport] = useState<AutomaticReportV1 | null>(null);
  // A failed read is said, never shown as "nothing to confer"; the last report stays below it.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void client
      .request({ contractVersion: 1, academicYear: 2026, operation: 'automatic-report' }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.state === 'ready' && result.operation === 'automatic-report') {
          setReport(result.report);
          setFailed(false);
        } else setFailed(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [client, refresh, attempt]);
  const failure = failed ? (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <p>
        <output className="contents">Não foi possível ler o relatório automático.</output>
      </p>
      <Button size="sm" variant="secondary" onPress={() => setAttempt((value) => value + 1)}>
        Tentar novamente
      </Button>
    </div>
  ) : null;
  if (!report || (!report.differences.length && !report.invalid.length && report.outcome === 'applied'))
    return failure ? (
      <Card aria-label="Relatório automático">
        <Card.Content>{failure}</Card.Content>
      </Card>
    ) : null;
  const outcome = OUTCOME_V1[report.outcome];
  return (
    <Card aria-label="Relatório automático">
      <Card.Content className="space-y-3">
        {failure}
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">Relatório automático do Coletor</h3>
          <Chip size="sm" variant="soft" color={outcome.color}>
            {outcome.label}
          </Chip>
        </div>
        <p className="text-sm text-muted">
          Lido no Smecel em {when(report.observedAt)} · {report.rows} linhas
          {report.counts ? ` · ${report.counts.linked} conciliadas · ${report.counts.pending} pendentes` : ''}.
          {' '}{SUMMARY_V1[report.outcome]}
        </p>
        {report.differences.length ? (
          <ul className="list-inside list-disc space-y-1 text-sm">
            {report.differences.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
        {report.invalid.length ? (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>
                {report.invalid.length === 1
                  ? '1 linha não aplicada'
                  : `${report.invalid.length} linhas não aplicadas`}
              </Alert.Title>
              <ul className="my-2 space-y-1">
                {report.invalid.map((item, index) => (
                  <li key={`${item.sourceRow}:${item.field}:${index}`} className="break-words">
                    <strong>
                      {item.name} — {item.classLabel}
                    </strong>
                    : {item.reason}
                    <span className="ml-2 text-xs text-muted">Linha {item.sourceRow}</span>
                  </li>
                ))}
              </ul>
              <Alert.Description>Corrija no Smecel: a próxima leitura aplica sozinha.</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
      </Card.Content>
    </Card>
  );
}
