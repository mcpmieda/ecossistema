// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { GRADEBOOK_IMPORT_DIAGNOSTIC_CODES_V1 } from '../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import {
  GRADEBOOK_IMPORT_DIAGNOSTIC_TEXTS_V1,
  gradebookImportDiagnosticTextV1,
} from '../../../shared/gradebook-contracts/imports/import-diagnostic-texts-v1';

describe('Auditoria texts for stored codes (issue #1426, finding 24)', () => {
  it('every code of the contract has its own text', () => {
    for (const code of GRADEBOOK_IMPORT_DIAGNOSTIC_CODES_V1) {
      const text = GRADEBOOK_IMPORT_DIAGNOSTIC_TEXTS_V1[code];
      expect(text?.message, code).toBeTruthy();
      expect(text?.action, code).toBeTruthy();
    }
  });

  it('only "source-unavailable" says a value is unavailable', () => {
    for (const code of GRADEBOOK_IMPORT_DIAGNOSTIC_CODES_V1) {
      if (code === 'source-unavailable') continue;
      expect(gradebookImportDiagnosticTextV1(code).message, code).not.toContain('indisponível');
    }
    expect(gradebookImportDiagnosticTextV1('wrong-year').message).toBe('Ano da planilha diferente do ano da pasta.');
  });

  it('an unknown code gets a plain text, not a false one', () => {
    expect(gradebookImportDiagnosticTextV1('future-code').message).toBe('Problema na planilha.');
  });
});

describe('student left out by the database, in the browser import (issue #1426, finding 31)', () => {
  it('becomes the same Auditoria finding the OneDrive reading writes', async () => {
    const { studentNotInRelationDiagnosticV1 } = await import('../../../src/features/gradebook/import/import-diagnostics-v1');
    const { isGradebookImportDiagnosticsAuditRequestV1 } = await import('../../../shared/gradebook-contracts/imports/import-diagnostics-v1');
    const item = studentNotInRelationDiagnosticV1('7C', 41);
    expect(item).toMatchObject({ code: 'student-not-in-relation', severity: 'blocking-error', classCode: '7C', studentNumber: 41, fieldKind: 'student' });
    const { key: _key, ...stored } = item;
    expect(isGradebookImportDiagnosticsAuditRequestV1({
      version: 1, academicYear: 2026, fileName: 'SINTETICO.xlsb', sha256: 'a'.repeat(64), diagnostics: [{ ...stored, key: item.key }],
    })).toBe(true);
  });

  it('the import records it in the Auditoria after the write answers', async () => {
    const { readFileSync } = await import('node:fs');
    const hook = readFileSync('src/features/gradebook/import/use-import-batch.ts', 'utf8');
    expect(hook).toContain("warning.code === 'student-not-in-relation'");
    expect(hook).toContain('studentNotInRelationDiagnosticV1(warning.classCode, warning.number)');
  });
});
