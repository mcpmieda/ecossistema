export const GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1 = 1 as const;

export const GRADEBOOK_IMPORT_DIAGNOSTIC_SEVERITIES_V1 = [
  'warning',
  'blocking-error',
] as const;
export type GradebookImportDiagnosticSeverityV1 =
  (typeof GRADEBOOK_IMPORT_DIAGNOSTIC_SEVERITIES_V1)[number];

export const GRADEBOOK_IMPORT_DIAGNOSTIC_CODES_V1 = [
  'invalid-text',
  'negative-grade',
  'invalid-precision',
  'invalid-maximum',
  'duplicate-student-number',
  'source-unavailable',
  'above-maximum',
] as const;
export type GradebookImportDiagnosticCodeV1 =
  (typeof GRADEBOOK_IMPORT_DIAGNOSTIC_CODES_V1)[number];

export const GRADEBOOK_IMPORT_DIAGNOSTIC_FIELD_KINDS_V1 = [
  'assessment',
  'term-result',
  'recovery',
  'configuration',
  'student',
  'file',
] as const;
export type GradebookImportDiagnosticFieldKindV1 =
  (typeof GRADEBOOK_IMPORT_DIAGNOSTIC_FIELD_KINDS_V1)[number];

export interface GradebookImportDiagnosticAuditItemV1 {
  readonly key: string;
  readonly severity: GradebookImportDiagnosticSeverityV1;
  readonly code: GradebookImportDiagnosticCodeV1;
  readonly message: string;
  readonly recommendedAction: string;
  readonly classCode?: string;
  readonly subject?: string;
  readonly period?: string;
  readonly studentNumber?: number;
  readonly fieldKind: GradebookImportDiagnosticFieldKindV1;
  readonly slot?: number;
  readonly fieldLabel?: string;
  readonly foundValue?: string;
  readonly cause?: string;
  readonly sheetName?: string;
  readonly cellAddress?: string;
}

export interface GradebookImportDiagnosticsAuditRequestV1 {
  readonly version: typeof GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1;
  readonly academicYear: number | null;
  readonly fileName: string;
  readonly sha256: string;
  readonly diagnostics: readonly GradebookImportDiagnosticAuditItemV1[];
}

export interface GradebookImportDiagnosticsAuditRecordV1
  extends GradebookImportDiagnosticAuditItemV1 {
  readonly id: number;
  readonly academicYear: number | null;
  readonly fileName: string;
  readonly studentName: string | null;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly observations: number;
}

export type GradebookImportDiagnosticsAuditWriteResponseV1 =
  | {
      readonly version: typeof GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1;
      readonly state: 'recorded';
      readonly affected: number;
    }
  | {
      readonly version: typeof GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1;
      readonly state: 'not-authorized' | 'invalid-request' | 'unavailable';
    };

export type GradebookImportDiagnosticsAuditListResponseV1 =
  | {
      readonly version: typeof GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1;
      readonly state: 'ready';
      readonly items: readonly GradebookImportDiagnosticsAuditRecordV1[];
      readonly nextOffset: number | null;
    }
  | {
      readonly version: typeof GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1;
      readonly state: 'not-authorized' | 'invalid-request' | 'unavailable';
    };

export const GRADEBOOK_IMPORT_DIAGNOSTICS_MAX_ITEMS_V1 = 5000;
export const GRADEBOOK_IMPORT_DIAGNOSTICS_BODY_BYTES_V1 = 1_500_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringWithin(value: unknown, maximum: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maximum &&
    (allowEmpty || value.trim().length > 0)
  );
}

function optionalStringWithin(value: unknown, maximum: number): boolean {
  return value === undefined || stringWithin(value, maximum);
}

function safeIntegerWithin(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function nullableAcademicYear(value: unknown): value is number | null {
  return value === null || safeIntegerWithin(value, 2000, 9999);
}

function isDiagnosticItem(value: unknown): value is GradebookImportDiagnosticAuditItemV1 {
  if (!isObject(value)) return false;
  if (!stringWithin(value.key, 320)) return false;
  if (
    typeof value.severity !== 'string' ||
    !GRADEBOOK_IMPORT_DIAGNOSTIC_SEVERITIES_V1.includes(
      value.severity as GradebookImportDiagnosticSeverityV1,
    )
  ) {
    return false;
  }
  if (
    typeof value.code !== 'string' ||
    !GRADEBOOK_IMPORT_DIAGNOSTIC_CODES_V1.includes(value.code as GradebookImportDiagnosticCodeV1)
  ) {
    return false;
  }
  if (!stringWithin(value.message, 300) || !stringWithin(value.recommendedAction, 500)) {
    return false;
  }
  if (
    typeof value.fieldKind !== 'string' ||
    !GRADEBOOK_IMPORT_DIAGNOSTIC_FIELD_KINDS_V1.includes(
      value.fieldKind as GradebookImportDiagnosticFieldKindV1,
    )
  ) {
    return false;
  }
  return isDiagnosticLocationV1(value);
}

/** Where a finding points: class, subject, period, student, slot, field and cell, each optional. */
function isDiagnosticLocationV1(value: Record<string, unknown>): boolean {
  if (!optionalStringWithin(value.classCode, 24)) return false;
  if (!optionalStringWithin(value.subject, 160)) return false;
  if (!optionalStringWithin(value.period, 64)) return false;
  if (value.studentNumber !== undefined && !safeIntegerWithin(value.studentNumber, 1, 9999)) {
    return false;
  }
  if (value.slot !== undefined && !safeIntegerWithin(value.slot, 0, 999)) return false;
  if (!optionalStringWithin(value.fieldLabel, 240)) return false;
  if (!optionalStringWithin(value.foundValue, 240)) return false;
  if (!optionalStringWithin(value.cause, 240)) return false;
  if (!optionalStringWithin(value.sheetName, 80)) return false;
  return optionalStringWithin(value.cellAddress, 24);
}

export function isGradebookImportDiagnosticsAuditRequestV1(
  value: unknown,
): value is GradebookImportDiagnosticsAuditRequestV1 {
  if (!isObject(value) || value.version !== GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1) return false;
  if (!nullableAcademicYear(value.academicYear)) return false;
  if (!stringWithin(value.fileName, 255)) return false;
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(value.sha256)) return false;
  if (
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > GRADEBOOK_IMPORT_DIAGNOSTICS_MAX_ITEMS_V1
  ) {
    return false;
  }
  return value.diagnostics.every(isDiagnosticItem);
}

function isAuditRecord(value: unknown): value is GradebookImportDiagnosticsAuditRecordV1 {
  if (!isObject(value) || !isDiagnosticItem(value)) return false;
  if (!safeIntegerWithin(value.id, 1, Number.MAX_SAFE_INTEGER)) return false;
  if (!nullableAcademicYear(value.academicYear)) return false;
  if (!stringWithin(value.fileName, 255)) return false;
  if (!(value.studentName === null || stringWithin(value.studentName, 240))) return false;
  if (!stringWithin(value.firstObservedAt, 64) || !stringWithin(value.lastObservedAt, 64)) return false;
  if (!safeIntegerWithin(value.observations, 1, Number.MAX_SAFE_INTEGER)) return false;
  return true;
}

export function isGradebookImportDiagnosticsAuditWriteResponseV1(
  value: unknown,
): value is GradebookImportDiagnosticsAuditWriteResponseV1 {
  if (!isObject(value) || value.version !== GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1) return false;
  if (value.state === 'recorded') {
    return safeIntegerWithin(value.affected, 0, Number.MAX_SAFE_INTEGER);
  }
  return ['not-authorized', 'invalid-request', 'unavailable'].includes(String(value.state));
}

export function isGradebookImportDiagnosticsAuditListResponseV1(
  value: unknown,
): value is GradebookImportDiagnosticsAuditListResponseV1 {
  if (!isObject(value) || value.version !== GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1) return false;
  if (value.state === 'ready') {
    return (
      Array.isArray(value.items) &&
      value.items.every(isAuditRecord) &&
      (value.nextOffset === null || safeIntegerWithin(value.nextOffset, 1, Number.MAX_SAFE_INTEGER))
    );
  }
  return ['not-authorized', 'invalid-request', 'unavailable'].includes(String(value.state));
}
