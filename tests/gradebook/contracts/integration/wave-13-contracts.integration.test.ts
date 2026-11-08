// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AcademicYearId, ClassGroupId } from '../../../../shared/gradebook-contracts/entities';
import {
  BULLETIN_AUTHORITY_MODE_V1,
  BULLETIN_CONTRACT_V1,
  BULLETIN_CONTRACT_VERSION_V1,
  inspectBulletinEmissionRequestV1,
  type BulletinComparedGradeValueV1,
  type BulletinEmissionRequestV1,
} from '../../../../shared/gradebook-contracts/bulletins/bulletin-contract-v1';
import {
  OPERATIONAL_WORKSPACE_CONTRACT_V1,
  OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,
  containsOperationalWorkspaceForbiddenClientFieldV1,
  isOperationalWorkspaceAcademicYearContextValidV1,
  isOperationalWorkspaceAvailabilityValidV1,
  type OperationalWorkspaceAcademicYearContextV1,
} from '../../../../shared/gradebook-contracts/operational-workspace/operational-workspace-contract-v1';
import {
  CLASS_PERFORMANCE_CONTRACT_V1,
  CLASS_PERFORMANCE_CONTRACT_VERSION_V1,
  PERFORMANCE_AUTHORITY_MODE_V1,
  PERFORMANCE_COLUMN_ORDER_V1,
  PERFORMANCE_ROW_ORDER_V1,
  inspectClassPerformanceRequestV1,
  type ClassPerformanceRequestV1,
  type PerformanceStudentSituationV1,
} from '../../../../shared/gradebook-contracts/performance/class-performance-read-model-v1';

const academicYearId = 'academic-year:synthetic:2026' as AcademicYearId;
const classGroupId = 'class-group:synthetic:6a' as ClassGroupId;

const yearContext = {
  selectedAcademicYearId: academicYearId,
  availableAcademicYears: [{ id: academicYearId, label: '2026 sintético' }],
} satisfies OperationalWorkspaceAcademicYearContextV1;

const performanceRequest = {
  contractVersion: CLASS_PERFORMANCE_CONTRACT_VERSION_V1,
  academicYearId,
  classGroupId,
  period: { kind: 'term', term: 1 },
  mode: 'regular',
  lens: 'result',
  comparisonPeriod: null,
  rows: { limit: 25, cursor: null },
  columns: { limit: 25, cursor: null },
  order: {
    rows: PERFORMANCE_ROW_ORDER_V1,
    columns: PERFORMANCE_COLUMN_ORDER_V1,
  },
} satisfies ClassPerformanceRequestV1;

const bulletinRequest = {
  contractVersion: BULLETIN_CONTRACT_VERSION_V1,
  academicYearId,
  period: { kind: 'term', term: 1 },
  target: { kind: 'class-group', classGroupId },
  model: 'synthetic',
  presentation: { locale: 'pt-BR', dateStyle: 'short' },
} satisfies BulletinEmissionRequestV1;

describe('wave 13 contract compatibility', () => {
  it('imports the three contracts together without duplicating versions or authority', () => {
    expect([
      OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,
      CLASS_PERFORMANCE_CONTRACT_VERSION_V1,
      BULLETIN_CONTRACT_VERSION_V1,
    ]).toEqual([1, 1, 1]);

    expect(PERFORMANCE_AUTHORITY_MODE_V1).toBe('imported-source');
    expect(BULLETIN_AUTHORITY_MODE_V1).toBe('imported-source');
    expect(CLASS_PERFORMANCE_CONTRACT_V1.authorityMode).toBe(BULLETIN_CONTRACT_V1.authorityMode);
  });

  it('keeps academic year explicit across all requests and workspace context', () => {
    expect(OPERATIONAL_WORKSPACE_CONTRACT_V1.academicYear.selection).toBe('explicit');
    expect(OPERATIONAL_WORKSPACE_CONTRACT_V1.academicYear.clockFallback).toBe('forbidden');
    expect(isOperationalWorkspaceAcademicYearContextValidV1(yearContext)).toBe(true);
    expect(inspectClassPerformanceRequestV1(performanceRequest)).toBe('ready');
    expect(inspectBulletinEmissionRequestV1(bulletinRequest)).toBe('ready');
    expect(performanceRequest.academicYearId).toBe(academicYearId);
    expect(bulletinRequest.academicYearId).toBe(academicYearId);
  });

  it('keeps authorization on the server and rejects client authority or authorization claims', () => {
    expect(OPERATIONAL_WORKSPACE_CONTRACT_V1.authorization.enforcement).toBe('server');
    expect(OPERATIONAL_WORKSPACE_CONTRACT_V1.search.authorization.enforcement).toBe('server');
    expect(BULLETIN_CONTRACT_V1.authorization.enforcement).toBe('server');

    expect(containsOperationalWorkspaceForbiddenClientFieldV1({ authorized: true })).toBe(true);
    expect(containsOperationalWorkspaceForbiddenClientFieldV1({ authorityMode: 'native-engine' })).toBe(
      true,
    );
    expect(inspectClassPerformanceRequestV1({ ...performanceRequest, authorityMode: 'native-engine' })).toBe(
      'invalid-request',
    );
    expect(inspectBulletinEmissionRequestV1({ ...bulletinRequest, authorityMode: 'native-engine' })).toBe(
      'invalid-request',
    );
  });

  it('preserves opaque pagination without inventing totals', () => {
    expect(OPERATIONAL_WORKSPACE_CONTRACT_V1.search.pagination.cursor).toBe('opaque');
    expect(OPERATIONAL_WORKSPACE_CONTRACT_V1.search.pagination.totalCount).toBe('omitted');
    expect(CLASS_PERFORMANCE_CONTRACT_V1.pagination.cursor).toBe('opaque');
    expect(CLASS_PERFORMANCE_CONTRACT_V1.pagination.totalCount).toBe('omitted');
  });

  it('preserves explicit absence instead of fabricating academic values', () => {
    const operationalEmpty = {
      contractVersion: OPERATIONAL_WORKSPACE_CONTRACT_VERSION_V1,
      state: 'empty',
      context: yearContext,
    } as const;
    const performanceAbsent = { state: 'absent' } satisfies PerformanceStudentSituationV1;
    const bulletinAbsent = {
      imported: { state: 'absent' },
      calculated: { state: 'absent' },
    } satisfies BulletinComparedGradeValueV1;

    expect(isOperationalWorkspaceAvailabilityValidV1(operationalEmpty)).toBe(true);
    expect(performanceAbsent.state).toBe('absent');
    expect(bulletinAbsent.imported.state).toBe('absent');
    expect(bulletinAbsent.calculated.state).toBe('absent');
  });

  it('keeps academic calculation and promotion semantics delegated to existing authorities', () => {
    expect(OPERATIONAL_WORKSPACE_CONTRACT_V1.search.querySemantics.academicRules).toBe('forbidden');
    expect(CLASS_PERFORMANCE_CONTRACT_V1.academicSemantics.calculations).toBe('forbidden');
    expect(CLASS_PERFORMANCE_CONTRACT_V1.academicSemantics.rounding).toBe('forbidden');
    expect(BULLETIN_CONTRACT_V1.academicValues.formulas).toBe('forbidden');
    expect(BULLETIN_CONTRACT_V1.academicValues.weights).toBe('forbidden');
  });
});
