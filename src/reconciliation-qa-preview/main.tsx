import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Card } from '@heroui/react';
import { StudentReportImportV1 } from '../features/gradebook/import/student-report-import-v1';
import { RelationMovementReviewV9 } from '../features/gradebook/import/relation-movement-review-v9';
import { STUDENT_REPORT_HEADERS_V1 } from '../features/gradebook/import/student-report-reader-v1';
import type {
  SheetJs,
  Workbook,
  Worksheet,
} from '../features/gradebook/import/spreadsheet-recognizer';
import { StudentReconciliationV1 } from '../features/student-portal-admin/accounts/student-reconciliation-v1';
import type { ReconciliationClientV1 } from '../features/student-portal-admin/shared/reconciliation-client-v1';
import type {
  GradebookRelationMovementReviewV9,
} from '../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type {
  ReconciliationRequestV1,
  ReconciliationResponseV1,
} from '../../shared/student-identity/reconciliation-v1';
import '../styles.css';

type ReconciliationListReadyV1 = Extract<
  ReconciliationResponseV1,
  { state: 'ready'; operation: 'list' }
>;
type ReconciliationDetailReadyV1 = Extract<
  ReconciliationResponseV1,
  { state: 'ready'; operation: 'detail' }
>;

const reportContext = {
  generation: '12690000-0000-4000-8000-000000000901',
  revision: 7,
  nameSource: 'report' as const,
  relationAvailable: true,
};
const reportBatchId = '12690000-0000-4000-8000-000000000902';
const studentUid = '12690000-0000-4000-8000-000000000903';
const candidateUid = '12690000-0000-4000-8000-000000000904';
const sourceId = '12690000-0000-4000-8000-000000000905';
const sourceId2 = '12690000-0000-4000-8000-000000000906';
const sourceId3 = '12690000-0000-4000-8000-000000000907';
const observationId = '12690000-0000-4000-8000-000000000908';
const observationId2 = '12690000-0000-4000-8000-000000000909';
const observationId3 = '12690000-0000-4000-8000-000000000910';
const longStudentName =
  'ALUNA SINTÉTICA COM NOME MUITO LONGO PARA QA VISUAL SEM QUALQUER DADO REAL ' + 'S'.repeat(120);
const longRelationName =
  'REGISTRO SINTÉTICO LONGO DO RELATÓRIO PARA CONFERIR OVERFLOW E FOCO ' + 'R'.repeat(120);

type ReportRowFixtureV1 = {
  readonly name: string;
  readonly classLabel: string;
  readonly shift: string;
  readonly stageLabel: string;
  readonly status: string;
  readonly enrolledAt: string | null;
  readonly transferredAt: string | null;
  readonly enrollmentHash: string;
  readonly inep: string | null;
  readonly birthDate: string | number | null;
  readonly filiation1: string | null;
};

const previewReview = {
  digest: 'd'.repeat(64),
  groups: [
    {
      origins: [
        {
          classCode: '7A',
          number: 1,
          name:
            'TRANSFERÊNCIA SINTÉTICA DE SAÍDA COM NOME MUITO LONGO PARA QA VISUAL ' + 'O'.repeat(120),
        },
        {
          classCode: '7A',
          number: 2,
          name: 'TRANSFERÊNCIA SINTÉTICA DO SEGUNDO PAR',
        },
      ],
      destinations: [
        {
          classCode: '7B',
          number: 11,
          name:
            'TRANSFERÊNCIA SINTÉTICA DE DESTINO COM NOME MUITO LONGO PARA QA VISUAL ' +
            'D'.repeat(120),
        },
        {
          classCode: '7B',
          number: 12,
          name: 'TRANSFERÊNCIA SINTÉTICA DO SEGUNDO DESTINO',
        },
      ],
    },
  ],
} satisfies GradebookRelationMovementReviewV9;
const autoplay = new URLSearchParams(window.location.search).has('autoplay');

function ensureSheetJsV1(rows: readonly ReportRowFixtureV1[]) {
  const sheet: Worksheet = { '!ref': `A1:K${rows.length + 1}` };
  rows.forEach((values, index) => {
    Object.entries(STUDENT_REPORT_HEADERS_V1).forEach(([field, header], columnIndex) => {
      const column = String.fromCharCode(65 + columnIndex);
      sheet[`${column}1`] = { v: header };
      sheet[`${column}${index + 2}`] = { v: values[field as keyof ReportRowFixtureV1] };
    });
  });
  const workbook: Workbook = { SheetNames: ['Relatório'], Sheets: { Relatório: sheet } };
  window.XLSX = {
    version: 'synthetic-browser-preview',
    read: () => workbook,
    utils: {
      decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: rows.length, c: 10 } }),
    },
  } satisfies SheetJs;
}

function syntheticFileV1(name: string) {
  const file = new File(['synthetic-browser-preview'], name);
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
  return file;
}

type BrowserQaCheckV1 = {
  readonly label: string;
  readonly status: 'approved' | 'failed';
  readonly detail: string;
};

function abortedErrorV1() {
  return new DOMException('Aborted', 'AbortError');
}

function throwIfAbortedV1(signal?: AbortSignal) {
  if (signal?.aborted) throw abortedErrorV1();
}

function delayV1<T>(value: T, ms: number, signal?: AbortSignal): Promise<T> {
  throwIfAbortedV1(signal);
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortedErrorV1());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createReportPreviewClientV1(
  record: (entry: string) => void,
): ReconciliationClientV1 {
  let stageCalls = 0;
  return {
    async request(
      input: ReconciliationRequestV1,
      signal?: AbortSignal,
    ): Promise<ReconciliationResponseV1> {
      record(`Relatório → ${input.operation}`);
      if (input.operation === 'catalog')
        return delayV1(
          {
            contractVersion: 1,
            state: 'ready',
            operation: 'catalog',
            context: reportContext,
            classes: [{ id: 701, label: '7A', stage: 7 }],
            reportClasses: [],
          },
          50,
          signal,
        );
      if (input.operation === 'prepare') {
        stageCalls = 0;
        return delayV1(
          {
            contractVersion: 1,
            state: 'ready',
            operation: 'prepare',
            context: reportContext,
            batchId: reportBatchId,
            batchState: 'preparing',
            expiresAt: '2099-01-01T00:00:00Z',
            differences: [],
            counts: { rows: 2, linked: 1, pending: 1 },
            credentialsReady: false,
          },
          120,
          signal,
        );
      }
      if (input.operation === 'stage') {
        stageCalls++;
        return delayV1(
          {
            contractVersion: 1,
            state: 'ready',
            operation: 'stage',
            ready: stageCalls >= 2,
            remaining: stageCalls >= 2 ? 0 : 1,
          },
          200,
          signal,
        );
      }
      if (input.operation === 'apply')
        return delayV1(
          {
            contractVersion: 1,
            state: 'committed',
            context: reportContext,
            operationId: reportBatchId,
          },
          120,
          signal,
        );
      return { contractVersion: 1, state: 'validation-failed', errors: [] };
    },
  };
}

function createStudentPreviewClientV1(
  record: (entry: string) => void,
): ReconciliationClientV1 {
  let nameSource: 'report' | 'relation' = 'report';
  let confirmConflictDelivered = false;
  let stageCalls = 0;
  return {
    async request(
      input: ReconciliationRequestV1,
      signal?: AbortSignal,
    ): Promise<ReconciliationResponseV1> {
      record(`Alunos → ${input.operation}`);
      if (input.operation === 'catalog')
        return delayV1(
          {
            contractVersion: 1,
            state: 'ready',
            operation: 'catalog',
            context: { ...reportContext, nameSource },
            classes: [{ id: 701, label: '7A', stage: 7 }],
            reportClasses: [],
          },
          50,
          signal,
        );
      if (input.operation === 'list') {
        const items: ReconciliationListReadyV1['items'] = [
          {
            kind: 'person' as const,
            studentUid,
            academicStudentId: 701001,
            academicYear: 2026 as const,
            name: longStudentName,
            relationName: longStudentName + ' · RELAÇÃO',
            classId: 701,
            classLabel: '7A',
            version: 4,
            reconciliation: 'review-required' as const,
            portal: 'without-portal' as const,
            accountId: null,
            possibleSamePerson: true,
          },
          {
            kind: 'external' as const,
            id: 'synthetic-external-browser',
            sourceId: null,
            batchId: reportBatchId,
            name: 'PENDÊNCIA SINTÉTICA SEM UID',
            classLabel: '7A',
            reason: 'no_match' as const,
            expiresAt: null,
            warning: false,
            sourceRow: 11,
          },
        ].filter((item) =>
          !input.search ||
          item.name.toLocaleLowerCase('pt-BR').includes(input.search.toLocaleLowerCase('pt-BR')),
        );
        return delayV1(
          {
            contractVersion: 1,
            state: 'ready',
            operation: 'list',
            context: { ...reportContext, nameSource },
            nextCursor: null,
            items,
          },
          input.search ? 80 : 160,
          signal,
        );
      }
      if (input.operation === 'detail')
        return delayV1<ReconciliationDetailReadyV1>(
          {
            contractVersion: 1,
            state: 'ready',
            operation: 'detail',
            context: { ...reportContext, nameSource },
            selectedObservationId: observationId,
            sources: [
              {
                id: sourceId,
                observationId,
                name: longRelationName,
                classLabel: '7A',
                birthDate: '2013-03-22',
                filiation1: 'RESPONSÁVEL SINTÉTICO A',
                inep: '00007001',
                studentUid,
                version: 7,
                decisionId: sourceId,
                reviewRequired: true,
              },
              {
                id: sourceId2,
                observationId: observationId2,
                name: longRelationName + ' · OBSERVAÇÃO INTEIRA',
                classLabel: '7B',
                birthDate: '2013-03-22',
                filiation1: 'RESPONSÁVEL SINTÉTICO C',
                inep: '00007003',
                studentUid,
                version: 5,
                decisionId: sourceId2,
                reviewRequired: false,
              },
              {
                id: sourceId3,
                observationId: observationId3,
                name: longRelationName + ' · SEM VÍNCULO',
                classLabel: '7B',
                birthDate: '2013-03-22',
                filiation1: 'RESPONSÁVEL SINTÉTICO B',
                inep: '00007002',
                studentUid: null,
                version: 4,
                decisionId: null,
                reviewRequired: false,
              },
            ],
            candidates: [
              {
                studentUid: candidateUid,
                name: 'ALUNO SINTÉTICO DA RELAÇÃO COM NOME LONGO ' + 'C'.repeat(90),
                classLabel: '7B',
              },
            ],
            history: [
              {
                id: '12690000-0000-4000-8000-000000000909',
                at: '2026-10-12T02:00:00Z',
                action: 'reject',
                reason: 'Exemplo sintético para QA visual.',
                version: 3,
              },
            ],
          },
          100,
          signal,
        );
      if (input.operation === 'resolve' && input.action === 'confirm' && !confirmConflictDelivered) {
        confirmConflictDelivered = true;
        return delayV1({ contractVersion: 1, state: 'conflict' }, 100, signal);
      }
      if (input.operation === 'resolve')
        return delayV1(
          {
            contractVersion: 1,
            state: 'committed',
            context: { ...reportContext, nameSource },
            operationId: crypto.randomUUID(),
          },
          100,
          signal,
        );
      if (input.operation === 'select-observation') {
        stageCalls = 0;
        return delayV1(
          {
            contractVersion: 1,
            state: 'ready',
            operation: 'prepare',
            context: { ...reportContext, nameSource },
            batchId: '12690000-0000-4000-8000-000000000910',
            batchState: 'preparing',
            expiresAt: '2099-01-01T00:00:00Z',
            differences: [],
            counts: { rows: 1, linked: 1, pending: 0 },
            credentialsReady: false,
          },
          120,
          signal,
        );
      }
      if (input.operation === 'stage') {
        stageCalls++;
        return delayV1(
          {
            contractVersion: 1,
            state: 'ready',
            operation: 'stage',
            ready: stageCalls >= 2,
            remaining: stageCalls >= 2 ? 0 : 1,
          },
          180,
          signal,
        );
      }
      if (input.operation === 'apply')
        return delayV1(
          {
            contractVersion: 1,
            state: 'committed',
            context: { ...reportContext, nameSource },
            operationId: crypto.randomUUID(),
          },
          100,
          signal,
        );
      if (input.operation === 'name-source') {
        nameSource = input.nameSource;
        return delayV1(
          {
            contractVersion: 1,
            state: 'committed',
            context: { ...reportContext, nameSource },
            operationId: crypto.randomUUID(),
          },
          80,
          signal,
        );
      }
      return { contractVersion: 1, state: 'validation-failed', errors: [] };
    },
  };
}

function findButtonV1(fragment: string): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll('button')).find((element) =>
      element.textContent?.includes(fragment),
    ) ?? null
  );
}

function pageOverflowV1() {
  return document.documentElement.scrollWidth - document.documentElement.clientWidth;
}

function waitForValueV1<T>(read: () => T | null, timeoutMs = 10_000): Promise<T> {
  const startedAt = performance.now();
  return new Promise<T>((resolve, reject) => {
    const tick = () => {
      const value = read();
      if (value !== null) {
        resolve(value);
        return;
      }
      if (performance.now() - startedAt >= timeoutMs) {
        reject(new Error('browser-qa-timeout'));
        return;
      }
      window.setTimeout(tick, 50);
    };
    tick();
  });
}

function PreviewCardV1({
  title,
  description,
  children,
}: Readonly<{
  title: string;
  description: string;
  children: ReactNode;
}>) {
  return (
    <Card>
      <Card.Content className="space-y-4 p-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted">{description}</p>
        </div>
        {children}
      </Card.Content>
    </Card>
  );
}

function EventLogV1({ events }: Readonly<{ events: readonly string[] }>) {
  return (
    <Card>
      <Card.Content className="space-y-3 p-4">
        <h2 className="text-lg font-semibold">Eventos sintéticos</h2>
        <ol className="space-y-2 text-sm">
          {events.map((entry, index) => (
            <li key={`${entry}-${index}`} className="break-words rounded-lg border border-default p-2">
              {entry}
            </li>
          ))}
        </ol>
      </Card.Content>
    </Card>
  );
}

function BrowserQaResultsV1({
  checks,
}: Readonly<{
  checks: readonly BrowserQaCheckV1[];
}>) {
  return (
    <Card id="browser-qa-results">
      <Card.Content className="space-y-3 p-4">
        <h2 className="text-lg font-semibold">QA em navegador real</h2>
        {!autoplay ? (
          <p className="text-sm text-muted">
            Abra esta página com <code>?autoplay=1</code> para executar o roteiro sintético no
            navegador local.
          </p>
        ) : null}
        {checks.length === 0 ? (
          <p className="text-sm text-muted">Aguardando execução do roteiro sintético…</p>
        ) : (
          <ol className="space-y-2 text-sm">
            {checks.map((check, index) => (
              <li
                key={`${check.label}-${index}`}
                data-status={check.status}
                className="rounded-lg border border-default p-2"
              >
                <strong>{check.status === 'approved' ? 'Aprovado' : 'Falhou'}</strong> ·{' '}
                {check.label}
                <div className="mt-1 break-words text-muted">{check.detail}</div>
              </li>
            ))}
          </ol>
        )}
      </Card.Content>
    </Card>
  );
}

function PreviewAppV1() {
  const [events, setEvents] = useState<string[]>([]);
  const [checks, setChecks] = useState<BrowserQaCheckV1[]>([]);
  const record = useCallback((entry: string) => {
    setEvents((current) => [entry, ...current].slice(0, 16));
  }, []);
  const recordCheck = useCallback((label: string, status: BrowserQaCheckV1['status'], detail: string) => {
    setChecks((current) => [...current, { label, status, detail }]);
  }, []);
  const reportClient = useMemo(() => createReportPreviewClientV1(record), [record]);
  const studentClient = useMemo(() => createStudentPreviewClientV1(record), [record]);
  const reportFile = useMemo(() => {
    ensureSheetJsV1([
      {
        name: longStudentName,
        classLabel: '7A 2026 - MATUTINO',
        shift: 'MATUTINO',
        stageLabel: 'Ensino Fundamental de 9 anos - 7º Ano',
        status: 'Ativo',
        enrolledAt: '2026-02-01',
        transferredAt: null,
        enrollmentHash: 'synthetic-browser-701',
        inep: null,
        birthDate: '2013-03-22',
        filiation1: 'RESPONSÁVEL SINTÉTICO A',
      },
      {
        name: longStudentName + ' B',
        classLabel: '7A 2026 - MATUTINO',
        shift: 'MATUTINO',
        stageLabel: 'Ensino Fundamental de 9 anos - 7º Ano',
        status: 'Ativo',
        enrolledAt: '2026-02-01',
        transferredAt: null,
        enrollmentHash: 'synthetic-browser-702',
        inep: null,
        birthDate: '2013-05-11',
        filiation1: 'RESPONSÁVEL SINTÉTICO B',
      },
    ]);
    return syntheticFileV1('relatorio-sintetico-qa.xlsx');
  }, []);
  useEffect(() => {
    if (!autoplay) return;
    let cancelled = false;
    const safeRecord = (label: string, status: BrowserQaCheckV1['status'], detail: string) => {
      if (!cancelled) recordCheck(label, status, detail);
    };
    const run = async () => {
      try {
        safeRecord(
          'Roteiro automático',
          'approved',
          `Autoplay iniciado em largura ${window.innerWidth}px.`,
        );
        const reportLink = await waitForValueV1(() => findButtonV1('Ligar a 7A'));
        const reportPrepare = await waitForValueV1(() => findButtonV1('Preparar relatório'));
        reportPrepare.focus();
        safeRecord(
          'Foco do relatório',
          document.activeElement === reportPrepare ? 'approved' : 'failed',
          `activeElement=${document.activeElement?.tagName ?? 'unknown'}`,
        );
        reportLink.click();
        reportPrepare.click();
        const reportApply = await waitForValueV1(() => findButtonV1('Aplicar relatório'));
        reportApply.click();
        await waitForValueV1(
          () =>
            Array.from(document.querySelectorAll('output')).find((element) =>
              element.textContent?.includes('Relatório aplicado.'),
            ) ?? null,
        );
        safeRecord(
          'Fluxo do relatório',
          'approved',
          'O relatório sintético carregou, preparou e aplicou sem expor PIN, verificador ou segredo.',
        );

        const studentSearch = await waitForValueV1(
          () => document.querySelector<HTMLInputElement>('input[aria-label="Buscar aluno ou pendência"]'),
        );
        studentSearch.focus();
        safeRecord(
          'Foco da busca de alunos',
          document.activeElement === studentSearch ? 'approved' : 'failed',
          `activeElement=${document.activeElement?.tagName ?? 'unknown'}`,
        );
        const studentOpen = await waitForValueV1(() => findButtonV1(longStudentName.slice(0, 32)));
        studentOpen.click();
        await waitForValueV1(() => findButtonV1('Confirmar vínculo'));
        safeRecord(
          'Nomes longos na aba Alunos',
          document.body.textContent?.includes(longStudentName.slice(0, 80)) &&
            document.body.textContent?.includes(longRelationName.slice(0, 80))
            ? 'approved'
            : 'failed',
          'Os nomes sintéticos longos permaneceram visíveis no navegador real.',
        );
        const confirmLink = await waitForValueV1(() => findButtonV1('Confirmar vínculo'));
        confirmLink.click();
        const confirmModal = await waitForValueV1(
          () =>
            Array.from(document.querySelectorAll('button')).find(
              (element) => element.textContent?.trim() === 'Confirmar',
            ) ?? null,
        );
        confirmModal.click();
        await waitForValueV1(
          () =>
            Array.from(document.querySelectorAll('[role="alert"]')).find((element) =>
              element.textContent?.includes('Dados alterados. Confira novamente.'),
            ) ?? null,
        );
        safeRecord(
          'Alerta de conflito',
          'approved',
          'O conflito sintético voltou para a lista com o alerta esperado.',
        );

        const firstMovement = await waitForValueV1(
          () =>
            document.querySelector<HTMLSelectElement>(
              'select[aria-label^="Destino para TRANSFERÊNCIA SINTÉTICA DE SAÍDA"]',
            ),
        );
        firstMovement.focus();
        safeRecord(
          'Foco da conferência de transferências',
          document.activeElement === firstMovement ? 'approved' : 'failed',
          `activeElement=${document.activeElement?.tagName ?? 'unknown'}`,
        );
        firstMovement.value = JSON.stringify(['7B', 11]);
        firstMovement.dispatchEvent(new Event('change', { bubbles: true }));
        const secondMovement = await waitForValueV1(
          () =>
            Array.from(document.querySelectorAll('select')).find((element) =>
              element.getAttribute('aria-label')?.includes('TRANSFERÊNCIA SINTÉTICA DO SEGUNDO PAR'),
            ) as HTMLSelectElement | null,
        );
        secondMovement.value = JSON.stringify(['7B', 12]);
        secondMovement.dispatchEvent(new Event('change', { bubbles: true }));
        const confirmPairs = await waitForValueV1(
          () => findButtonV1('Confirmar pares e aplicar Relação'),
        );
        safeRecord(
          'Seleção completa de transferências',
          !confirmPairs.disabled ? 'approved' : 'failed',
          `disabled=${String(confirmPairs.disabled)}`,
        );
        const overflow = pageOverflowV1();
        safeRecord(
          'Layout e overflow horizontal',
          overflow <= 0 ? 'approved' : 'failed',
          `innerWidth=${window.innerWidth}; clientWidth=${document.documentElement.clientWidth}; scrollWidth=${document.documentElement.scrollWidth}`,
        );
      } catch (error) {
        safeRecord(
          'Roteiro automático',
          'failed',
          error instanceof Error ? error.message : 'browser-qa-unknown-error',
        );
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [recordCheck]);
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Prévia sintética — conciliação de alunos</h1>
        <p className="max-w-4xl text-sm text-muted">
          Página local para QA visual e funcional com nomes, contas, chaves e vínculos 100%
          sintéticos. Nenhum dado acadêmico real, PIN, verificador ou segredo é renderizado.
        </p>
      </header>
      <PreviewCardV1
        title="Relatório"
        description="Fluxo sintético com nomes longos, conferência, dois estágios e aplicação final."
      >
        <StudentReportImportV1 file={reportFile} client={reportClient} onClose={() => record('Relatório → fechar')} />
      </PreviewCardV1>
      <PreviewCardV1
        title="Aba Alunos"
        description="Lista e detalhe sintéticos com foco em nomes longos, foco, alerta de conflito e escolha de observação inteira."
      >
        <StudentReconciliationV1
          client={studentClient}
          scope={{ kind: 'school', academicYear: 2026 }}
          canWrite
        />
      </PreviewCardV1>
      <PreviewCardV1
        title="Conferência de transferências"
        description="Pares sintéticos com nomes longos para verificar overflow, foco e seleção completa."
      >
        <RelationMovementReviewV9
          review={previewReview}
          busy={false}
          onConfirm={(value) => record(`Transferências → confirmar ${value.pairs.length} pares`)}
          onCancel={() => record('Transferências → cancelar')}
        />
      </PreviewCardV1>
      <BrowserQaResultsV1 checks={checks} />
      <EventLogV1 events={events} />
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Preview root missing');
createRoot(root).render(<PreviewAppV1 />);
