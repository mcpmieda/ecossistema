import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  const file = new File(['synthetic'], 'relatorio.xlsx');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
  return file;
}

function clientFor(reportClasses: CatalogV1['reportClasses']) {
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
        classes: [{ id: 7, label: '7A', stage: 7 }],
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
});
