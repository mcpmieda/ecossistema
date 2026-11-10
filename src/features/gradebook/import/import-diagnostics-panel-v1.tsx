import { Alert, Surface } from '@heroui/react';
import type { GradebookImportDiagnosticV1 } from './import-diagnostics-v1';

function studentLabel(value: GradebookImportDiagnosticV1): string | null {
  if (value.studentNumber === undefined && !value.studentName) return null;
  const number = value.studentNumber === undefined ? '' : `nº ${value.studentNumber}`;
  if (!value.studentName) return number;
  return number ? `${number} — ${value.studentName}` : value.studentName;
}

function functionalLocation(value: GradebookImportDiagnosticV1): string {
  return [value.classCode && `Turma ${value.classCode}`, value.period, value.fieldLabel]
    .filter(Boolean)
    .join(' · ');
}

function DiagnosticOccurrence({ value }: { readonly value: GradebookImportDiagnosticV1 }) {
  const student = studentLabel(value);
  return (
    <Surface variant="secondary" className="rounded-xl border border-border/60 p-3">
      <p className="text-sm font-semibold">{value.message}</p>
      <dl className="mt-2 grid gap-1 text-sm">
        {student && (
          <div>
            <dt className="inline font-medium">Aluno: </dt>
            <dd className="inline">{student}</dd>
          </div>
        )}
        {functionalLocation(value) && (
          <div>
            <dt className="inline font-medium">Localização: </dt>
            <dd className="inline">{functionalLocation(value)}</dd>
          </div>
        )}
        {value.subject && (
          <div>
            <dt className="inline font-medium">Disciplina: </dt>
            <dd className="inline">{value.subject}</dd>
          </div>
        )}
        {value.foundValue && (
          <div>
            <dt className="inline font-medium">Encontrado: </dt>
            <dd className="inline">“{value.foundValue}”</dd>
          </div>
        )}
        {value.cause && (
          <div>
            <dt className="inline font-medium">O que aconteceu: </dt>
            <dd className="inline">{value.cause}</dd>
          </div>
        )}
        <div>
          <dt className="inline font-medium">Como corrigir: </dt>
          <dd className="inline">{value.recommendedAction}</dd>
        </div>
      </dl>
      {(value.sheetName || value.cellAddress) && (
        <details className="mt-2 text-xs text-muted">
          <summary className="cursor-pointer">Detalhes técnicos</summary>
          <p className="mt-1">
            {[value.sheetName, value.cellAddress].filter(Boolean).join(' · ')}
          </p>
        </details>
      )}
    </Surface>
  );
}

function groupedCauses(values: readonly GradebookImportDiagnosticV1[]): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value.cause ?? 'Origem sem valor utilizável salvo.';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([cause, count]) => `${count}× ${cause}`)
    .join(' · ');
}

/** Occurrences shown per diagnostic; the rest stay in the Auditoria. */
const OCCURRENCE_LIMIT_V1 = 30;

function OccurrenceList({ values }: { readonly values: readonly GradebookImportDiagnosticV1[] }) {
  const limit = OCCURRENCE_LIMIT_V1;
  if (values.length === 0) return null;
  return (
    <div className="mt-3 grid gap-2">
      {values.slice(0, limit).map((value) => (
        <DiagnosticOccurrence key={value.key} value={value} />
      ))}
      {values.length > limit && (
        <p className="text-xs text-muted">
          E mais {values.length - limit} ocorrência(s). Todas foram registradas na Auditoria.
        </p>
      )}
    </div>
  );
}

export function ImportDiagnosticsPanelV1({
  diagnostics,
  auditFailure,
}: {
  readonly diagnostics: readonly GradebookImportDiagnosticV1[];
  readonly auditFailure?: string;
}) {
  const blocking = diagnostics.filter((value) => value.severity === 'blocking-error');
  const unavailable = diagnostics.filter((value) => value.code === 'source-unavailable');
  const advisories = diagnostics.filter(
    (value) => value.severity === 'warning' && value.code !== 'source-unavailable',
  );

  return (
    <>
      {blocking.length > 0 && (
        <Alert status="danger" className="mt-5">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              {blocking.length} problema(s) precisam ser corrigidos antes da importação
            </Alert.Title>
            <Alert.Description>
              <p>
                Esta planilha não foi enviada ao Banco. Corrija os itens abaixo e importe somente
                este arquivo novamente. Todos os problemas encontrados nesta leitura são mostrados
                de uma vez.
              </p>
              <OccurrenceList values={blocking} />
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {unavailable.length > 0 && (
        <Alert status="warning" className="mt-5">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Valores de origem indisponíveis</Alert.Title>
            <Alert.Description>
              <p>
                {unavailable.length} valor(es) apresentam erro ou fórmula sem resultado salvo.
                Esses valores não foram inventados nem tratados como zero. Os demais dados válidos
                podem ser importados; em uma reimportação, um valor indisponível também não apaga o
                valor anterior do Banco.
              </p>
              <p className="mt-2 text-sm">
                <strong>Causas observadas:</strong> {groupedCauses(unavailable)}
              </p>
              <p className="mt-2">
                Recalcule e salve a planilha no Excel antes de reimportar. Abaixo estão as
                localizações funcionais para conferência.
              </p>
              <OccurrenceList values={unavailable} />
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {advisories.length > 0 && (
        <Alert status="warning" className="mt-5">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{advisories.length} aviso(s) para revisar</Alert.Title>
            <Alert.Description>
              <p>
                Estes avisos não bloqueiam os demais dados válidos. Revise os lançamentos indicados
                e reimporte o arquivo depois da correção quando necessário.
              </p>
              <OccurrenceList values={advisories} />
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {auditFailure && (
        <Alert status="warning" className="mt-5">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Auditoria sem confirmação</Alert.Title>
            <Alert.Description>
              {auditFailure} Isso não altera a validação da planilha nem cria dados acadêmicos.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
    </>
  );
}
