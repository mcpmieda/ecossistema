// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  FRONTEND_DIAGNOSTIC_ROUTE_V1,
  inspectFrontendDiagnosticSubmissionV1,
} from '../../shared/frontend-diagnostic-v1';

const valid = {
  version: 1,
  area: 'gradebook',
  category: 'read',
  release: '2026.09.20-136979be',
  correlationId: '11111111-1111-4111-8111-111111111111',
} as const;

describe('frontend diagnostic contract V1', () => {
  it('fixes one shared route', () => {
    expect(FRONTEND_DIAGNOSTIC_ROUTE_V1).toBe('/api/observability/frontend-diagnostic');
  });

  it('accepts only the bounded metadata contract', () => {
    expect(inspectFrontendDiagnosticSubmissionV1(valid)).toBe(true);
  });

  it.each([
    ['studentName', 'ALUNO SINTETICO'],
    ['studentId', '123'],
    ['className', 'TURMA SINTETICA'],
    ['grade', 10000],
    ['birthDate', '2000-01-01'],
    ['token', 'SYNTHETIC_SECRET_MARKER'],
    ['url', 'https://example.invalid/private?q=sensitive'],
    ['stack', 'Error: SYNTHETIC_STACK_MARKER'],
    ['message', 'SYNTHETIC_RAW_ERROR_MARKER'],
    ['requestBody', { private: 'SYNTHETIC_BODY_MARKER' }],
    ['formDraft', 'SYNTHETIC_DRAFT_MARKER'],
    ['recordedAt', '2026-09-20T00:00:00.000Z'],
  ])('rejects forbidden or server-owned field %s', (field, value) => {
    expect(inspectFrontendDiagnosticSubmissionV1({ ...valid, [field]: value })).toBe(false);
  });

  it('rejects arbitrary release text, non-opaque correlation and unknown enums', () => {
    expect(inspectFrontendDiagnosticSubmissionV1({
      ...valid,
      release: 'https://example.invalid/release',
    })).toBe(false);
    expect(inspectFrontendDiagnosticSubmissionV1({
      ...valid,
      correlationId: 'student-123',
    })).toBe(false);
    expect(inspectFrontendDiagnosticSubmissionV1({
      ...valid,
      category: 'raw-error',
    })).toBe(false);
    expect(inspectFrontendDiagnosticSubmissionV1({
      ...valid,
      area: 'student-123',
    })).toBe(false);
  });

});
