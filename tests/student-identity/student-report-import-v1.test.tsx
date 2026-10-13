import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentReportImportV1 } from '../../src/features/gradebook/import/student-report-import-v1';
import { loadSheetJs } from '../../src/features/gradebook/import/sheetjs-loader';
import { STUDENT_REPORT_HEADERS_V1 } from '../../src/features/gradebook/import/student-report-reader-v1';
import type {
  SheetJs,
  Workbook,
  Worksheet,
} from '../../src/features/gradebook/import/spreadsheet-recognizer';
import type {
  ReconciliationRequestV1,
  ReconciliationResponseV1,
} from '../../shared/student-identity/reconciliation-v1';

vi.mock('../../src/features/gradebook/import/sheetjs-loader', () => ({
  loadSheetJs: vi.fn(),
}));

type CatalogV1 = Extract<ReconciliationResponseV1, { operation: 'catalog' }>;
const preparedContext = {
  generation: '12690000-0000-4000-8000-000000000031',
  revision: 1,
  nameSource: 'report' as const,
  relationAvailable: true,
};
const preparedBatchId = '12690000-0000-4000-8000-000000000032';
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
const variants = [
  {
    classLabel: '7A  2026 - MATUTINO',
    shift: 'matutino',
    stageLabel: 'Ensino Fundamental de 9 anos - 7º Ano',
  },
  {
    classLabel: '7A 2026 - MATUTINO',
    shift: 'MATUTINO',
    stageLabel: 'ENSINO  FUNDAMENTAL DE 9 ANOS - 7º ANO',
  },
] as const;

function readerForRows(rows: readonly ReportRowFixtureV1[]): SheetJs {
  const sheet: Worksheet = { '!ref': `A1:K${rows.length + 1}` };
  rows.forEach((values, index) => {
    Object.entries(STUDENT_REPORT_HEADERS_V1).forEach(([field, header], columnIndex) => {
      const column = String.fromCharCode(65 + columnIndex);
      sheet[`${column}1`] = { v: header };
      sheet[`${column}${index + 2}`] = { v: values[field as keyof ReportRowFixtureV1] };
    });
  });
  const workbook: Workbook = { SheetNames: ['Relatório'], Sheets: { Relatório: sheet } };
  return {
    version: 'synthetic',
    read: () => workbook,
    utils: {
      decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: rows.length, c: 10 } }),
    },
  };
}

function syntheticFile(name = 'relatorio.xlsx') {
  const file = new File(['synthetic'], name);
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
  return file;
}

function deferredV1<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function loadReport(reverse: boolean) {
  const sheet: Worksheet = { '!ref': 'A1:K3' };
  const rows = reverse ? [...variants].reverse() : variants;
  rows.forEach((entry, index) => {
    const sourceIndex = variants.indexOf(entry) + 1;
    const values = {
      name: `Pessoa Sintética ${sourceIndex}`,
      ...entry,
      status: 'Ativo',
      enrolledAt: '2026-02-01',
      transferredAt: null,
      enrollmentHash: `synthetic-enrollment-${sourceIndex}`,
      inep: null,
      birthDate: '2013-03-22',
      filiation1: null,
    };
    Object.entries(STUDENT_REPORT_HEADERS_V1).forEach(([field, header], columnIndex) => {
      const column = String.fromCharCode(65 + columnIndex);
      sheet[`${column}1`] = { v: header };
      sheet[`${column}${index + 2}`] = { v: values[field as keyof typeof values] };
    });
  });
  const workbook: Workbook = { SheetNames: ['Relatório'], Sheets: { Relatório: sheet } };
  const reader: SheetJs = {
    version: 'synthetic',
    read: () => workbook,
    utils: { decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 2, c: 10 } }) },
  };
  vi.mocked(loadSheetJs).mockResolvedValue(reader);
  return syntheticFile();
}

function clientFor(
  reportClasses: CatalogV1['reportClasses'],
  classes: CatalogV1['classes'] = [{ id: 7, label: '7A', stage: 7 }],
) {
  const request = vi.fn(
    async (input: ReconciliationRequestV1): Promise<ReconciliationResponseV1> => {
      if (input.operation !== 'catalog')
        return { contractVersion: 1, state: 'validation-failed', errors: [] };
      return {
        contractVersion: 1,
        state: 'ready',
        operation: 'catalog',
        context: {
          generation: '12690000-0000-4000-8000-000000000001',
          revision: 1,
          nameSource: 'report',
          relationAvailable: true,
        },
        classes,
        reportClasses,
      };
    },
  );
  return { request };
}

const savedClass: CatalogV1['reportClasses'][number] = {
  id: 'synthetic-class',
  label: variants[0].classLabel,
  shift: variants[1].shift,
  stageLabel: variants[1].stageLabel,
  classId: 7,
  reviewRequired: false,
};

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ligações de turma ao importar Relatório', () => {
  it.each([false, true])(
    'recupera a ligação salva com espaços equivalentes e ordem invertida=%s',
    async (reverse) => {
      const client = clientFor([savedClass]);
      render(
        <StudentReportImportV1 file={loadReport(reverse)} client={client} onClose={vi.fn()} />,
      );
      const select = await screen.findByRole('combobox');
      expect(screen.getAllByRole('combobox')).toHaveLength(1);
      expect(select).toHaveProperty('value', '7');
      fireEvent.click(screen.getByRole('button', { name: 'Preparar relatório' }));
      await waitFor(() =>
        expect(client.request.mock.calls.some(([input]) => input.operation === 'prepare')).toBe(
          true,
        ),
      );
      const prepared = client.request.mock.calls.find(
        ([input]) => input.operation === 'prepare',
      )![0];
      expect(prepared).toMatchObject({
        classLinks: [{ ...variants[reverse ? 1 : 0], gradebookClassId: 7, confirmRegular: false }],
        rows: (reverse ? [...variants].reverse() : variants).map((entry) => ({ ...entry })),
      });
    },
  );

  it.each([
    { label: 'primeira importação', reportClasses: [] },
    {
      label: 'ligação pendente de revisão',
      reportClasses: [{ ...savedClass, reviewRequired: true }],
    },
    { label: 'outro turno', reportClasses: [{ ...savedClass, shift: 'VESPERTINO' }] },
    { label: 'outra etapa', reportClasses: [{ ...savedClass, stageLabel: 'Outra etapa' }] },
  ])('exige escolha explícita em $label', async ({ reportClasses }) => {
    const client = clientFor(reportClasses);
    render(<StudentReportImportV1 file={loadReport(false)} client={client} onClose={vi.fn()} />);
    const select = await screen.findByRole('combobox');
    expect(select).toHaveProperty('value', '');
    fireEvent.click(screen.getByRole('button', { name: 'Ligar a 7A' }));
    expect(select).toHaveProperty('value', '7');
  });

  it('ignora o retorno atrasado do arquivo anterior quando a Secretaria troca o relatório', async () => {
    const firstReader = deferredV1<SheetJs>();
    vi.mocked(loadSheetJs)
      .mockImplementationOnce(() => firstReader.promise)
      .mockResolvedValueOnce(
        readerForRows([
          {
            name: 'Pessoa Sintética 8B',
            classLabel: '8B 2026 - MATUTINO',
            shift: 'MATUTINO',
            stageLabel: 'Ensino Fundamental de 9 anos - 8º Ano',
            status: 'Ativo',
            enrolledAt: '2026-02-01',
            transferredAt: null,
            enrollmentHash: 'synthetic-enrollment-8b',
            inep: null,
            birthDate: '2013-03-22',
            filiation1: null,
          },
        ]),
      );
    const client = clientFor([], [
      { id: 7, label: '7A', stage: 7 },
      { id: 8, label: '8B', stage: 8 },
    ]);
    const { rerender } = render(
      <StudentReportImportV1 file={syntheticFile('primeiro.xlsx')} client={client} onClose={vi.fn()} />,
    );
    rerender(
      <StudentReportImportV1 file={syntheticFile('segundo.xlsx')} client={client} onClose={vi.fn()} />,
    );
    await screen.findByText('8B 2026 - MATUTINO');
    await act(async () => {
      firstReader.resolve(
        readerForRows([
          {
            name: 'Pessoa Sintética 7A',
            classLabel: '7A 2026 - MATUTINO',
            shift: 'MATUTINO',
            stageLabel: 'Ensino Fundamental de 9 anos - 7º Ano',
            status: 'Ativo',
            enrolledAt: '2026-02-01',
            transferredAt: null,
            enrollmentHash: 'synthetic-enrollment-7a',
            inep: null,
            birthDate: '2013-03-22',
            filiation1: null,
          },
        ]),
      );
      await firstReader.promise;
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByText('8B 2026 - MATUTINO')).toBeTruthy();
      expect(screen.queryByText('7A 2026 - MATUTINO')).toBeNull();
    });
  });

  it('recarrega o catálogo e o novo prepare usa o contexto atualizado quando a revisão muda antes da gravação', async () => {
    let catalogCalls = 0;
    let prepareCalls = 0;
    const client = {
      request: vi.fn(async (input: ReconciliationRequestV1): Promise<ReconciliationResponseV1> => {
        if (input.operation === 'catalog') {
          catalogCalls++;
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'catalog',
            context: {
              generation: `12690000-0000-4000-8000-00000000000${catalogCalls}`,
              revision: catalogCalls,
              nameSource: 'report',
              relationAvailable: true,
            },
            classes: [{ id: 7, label: '7A', stage: 7 }],
            reportClasses: [],
          };
        }
        if (input.operation === 'prepare' && ++prepareCalls === 1)
          return { contractVersion: 1, state: 'conflict' };
        if (input.operation === 'prepare')
          return {
            contractVersion: 1,
            state: 'ready',
            operation: 'prepare',
            context: {
              generation: '12690000-0000-4000-8000-000000000002',
              revision: 2,
              nameSource: 'report',
              relationAvailable: true,
            },
            batchId: preparedBatchId,
            batchState: 'preparing',
            expiresAt: '2099-01-01T00:00:00Z',
            differences: [],
            counts: { rows: 2, linked: 2, pending: 0 },
            credentialsReady: true,
          };
        return { contractVersion: 1, state: 'validation-failed', errors: [] };
      }),
    };
    render(<StudentReportImportV1 file={loadReport(false)} client={client} onClose={vi.fn()} />);
    await screen.findByRole('combobox');
    fireEvent.click(screen.getByRole('button', { name: 'Preparar relatório' }));
    await waitFor(() => expect(catalogCalls).toBe(2));
    expect(screen.getByRole('alert').textContent).toBe(
      'A lista mudou. Confira as turmas e prepare novamente.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preparar relatório' }));
    await screen.findByLabelText('Conferência do relatório');
    const prepareRequests = client.request.mock.calls
      .map(([input]) => structuredClone(input))
      .filter((input) => input.operation === 'prepare');
    expect(prepareRequests).toHaveLength(2);
    expect(prepareRequests[0]).toMatchObject({
      generation: '12690000-0000-4000-8000-000000000001',
      expectedRevision: 1,
    });
    expect(prepareRequests[1]).toMatchObject({
      generation: '12690000-0000-4000-8000-000000000002',
      expectedRevision: 2,
    });
  });

  it('aborta o stage sem aplicar quando a janela do relatório é fechada durante a preparação', async () => {
    let stageCalls = 0;
    let applyCalls = 0;
    const stageStarted = deferredV1<void>();
    const stageAborted = deferredV1<void>();
    const lateStageResponse = deferredV1<void>();
    let releaseStage: (value: ReconciliationResponseV1) => void = () => undefined;
    const abortStates: boolean[] = [];
    const client = {
      request: vi.fn(
        async (
          input: ReconciliationRequestV1,
          signal?: AbortSignal,
        ): Promise<ReconciliationResponseV1> => {
          signal?.throwIfAborted();
          if (input.operation === 'catalog')
            return {
              contractVersion: 1,
              state: 'ready',
              operation: 'catalog',
              context: {
                generation: '12690000-0000-4000-8000-000000000071',
                revision: 1,
                nameSource: 'report',
                relationAvailable: true,
              },
              classes: [{ id: 7, label: '7A', stage: 7 }],
              reportClasses: [],
            };
          if (input.operation === 'prepare')
            return {
              contractVersion: 1,
              state: 'ready',
              operation: 'prepare',
              context: preparedContext,
              batchId: preparedBatchId,
              batchState: 'preparing',
              expiresAt: '2099-01-01T00:00:00Z',
              differences: [],
              counts: { rows: 1, linked: 1, pending: 0 },
              credentialsReady: false,
            };
          if (input.operation === 'stage') {
            stageCalls++;
            stageStarted.resolve();
            return new Promise<ReconciliationResponseV1>((resolve, reject) => {
              releaseStage = (value) => {
                lateStageResponse.resolve();
                resolve(value);
              };
              signal?.addEventListener(
                'abort',
                () => {
                  abortStates.push(signal.aborted);
                  stageAborted.resolve();
                  reject(new DOMException('Aborted', 'AbortError'));
                },
                { once: true },
              );
            });
          }
          if (input.operation === 'apply') {
            applyCalls++;
            return {
              contractVersion: 1,
              state: 'committed',
              context: preparedContext,
              operationId: preparedBatchId,
            };
          }
          return { contractVersion: 1, state: 'validation-failed', errors: [] };
        },
      ),
    };
    function Host() {
      const [open, setOpen] = useState(true);
      return open ? (
        <>
          <button type="button" onClick={() => setOpen(false)}>
            Fechar host
          </button>
          <StudentReportImportV1
            file={loadReport(false)}
            client={client}
            onClose={() => setOpen(false)}
          />
        </>
      ) : (
        <p>Relatório fechado</p>
      );
    }
    render(<Host />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preparar relatório' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Aplicar relatório' }));
    await act(async () => {
      await stageStarted.promise;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fechar host' }));
    await screen.findByText('Relatório fechado');
    await act(async () => {
      await stageAborted.promise;
    });
    expect(abortStates).toEqual([true]);
    await act(async () => {
      releaseStage({
        contractVersion: 1,
        state: 'ready',
        operation: 'stage',
        ready: true,
        remaining: 0,
      });
      await lateStageResponse.promise;
      await Promise.resolve();
    });
    expect(stageCalls).toBe(1);
    expect(applyCalls).toBe(0);
  });
});
