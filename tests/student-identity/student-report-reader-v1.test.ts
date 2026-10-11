// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  isStudentReportWorkbookV1,
  readStudentReportWorkbookV1,
  STUDENT_REPORT_HEADERS_V1,
} from '../../src/features/gradebook/import/student-report-reader-v1';
import type {
  SheetJs,
  Workbook,
  Worksheet,
} from '../../src/features/gradebook/import/spreadsheet-recognizer';

const reader: SheetJs = {
  version: 'synthetic',
  read: vi.fn(),
  utils: {
    decode_range: (range) => ({
      s: { r: 0, c: 0 },
      e: { r: Number(range.match(/\d+$/u)?.[0]) - 1, c: 11 },
    }),
  },
};
function workbook(overrides: Record<string, unknown> = {}, excluded = false): Workbook {
  const cells: Record<string, unknown> = {
    name: 'Pessoa Sintética',
    classLabel: excluded ? 'MULTIFUNCIONAL MATUTINO' : '7A 2026 - MATUTINO',
    shift: 'MATUTINO',
    stageLabel: 'Ensino Fundamental de 9 anos - 7º Ano',
    status: 'Ativo',
    enrolledAt: 46055,
    transferredAt: null,
    enrollmentHash: 'Synthetic-Hash-01',
    inep: '001.234',
    birthDate: 41337,
    filiation1: 'Filiação Sintética',
    ...overrides,
  };
  const sheet: Worksheet = {
    '!ref': 'A1:L2',
    L1: { v: 'Coluna não permitida' },
    L2: { v: 'não enviar nem persistir' },
  };
  Object.entries(STUDENT_REPORT_HEADERS_V1).forEach(([field, header], index) => {
    const column = String.fromCharCode(65 + index);
    sheet[`${column}1`] = { v: header };
    sheet[`${column}2`] = { v: cells[field] };
  });
  return { SheetNames: ['Relatório'], Sheets: { Relatório: sheet } };
}

describe('leitor do Relatório Smecel V1', () => {
  it('extrai somente a allowlist, mantém tipos brutos e não deduz data pelo arquivo', () => {
    const parsed = readStudentReportWorkbookV1(workbook(), reader);
    expect(parsed).toMatchObject({
      date1904: false,
      sourceYear: 2026,
      rows: [{ name: 'Pessoa Sintética', inep: '001.234', birthDate: 41337, sourceRow: 2 }],
    });
    expect(Object.keys(parsed.rows[0]!)).toHaveLength(12);
    expect(JSON.stringify(parsed)).not.toContain('não enviar nem persistir');
  });
  it('preserva a época 1904 do workbook', () => {
    const source = { ...workbook(), Workbook: { WBProps: { date1904: true } } };
    expect(readStudentReportWorkbookV1(source, reader).date1904).toBe(true);
  });
  it('coluna obrigatória ausente não é tratada como campo vazio', () => {
    const source = workbook();
    delete source.Sheets.Relatório!.J1;
    expect(() => readStudentReportWorkbookV1(source, reader)).toThrow(
      'Colunas ausentes: Nascimento',
    );
  });
  it('não lê dados pessoais de uma linha excluída antes de descartá-la', () => {
    const source = workbook({}, true);
    Object.defineProperty(source.Sheets.Relatório!, 'A2', {
      get: () => {
        throw new Error('Dado pessoal excluído foi lido');
      },
    });
    expect(() => readStudentReportWorkbookV1(source, reader)).toThrow('Nenhuma turma elegível');
  });
  it('mantém turma desconhecida em memória sem classificá-la como regular', () => {
    const parsed = readStudentReportWorkbookV1(
      workbook({ classLabel: 'Formato ainda desconhecido' }),
      reader,
    );
    expect(parsed.sourceYear).toBeNull();
    expect(parsed.classes[0]?.classification.kind).toBe('unknown');
  });
  it('rejeita outro ano e fórmulas nas colunas permitidas', () => {
    expect(() =>
      readStudentReportWorkbookV1(workbook({ classLabel: '7A 2025 - MATUTINO' }), reader),
    ).toThrow('ano de 2026');
    const source = workbook();
    source.Sheets.Relatório!.A2 = { v: 'Pessoa Sintética', f: 'SYNTHETIC()' };
    expect(() => readStudentReportWorkbookV1(source, reader)).toThrow(
      'Conteúdo inválido na linha 2',
    );
  });
  it('identifica o relatório para impedir despacho como notas', () => {
    expect(isStudentReportWorkbookV1(workbook(), reader)).toBe(true);
    expect(
      isStudentReportWorkbookV1(
        { SheetNames: ['Notas'], Sheets: { Notas: { '!ref': 'A1:L2' } } },
        reader,
      ),
    ).toBe(false);
  });
});
