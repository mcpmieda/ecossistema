import {
  GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1,
  isGradebookImportDiagnosticsAuditListResponseV1,
  isGradebookImportDiagnosticsAuditWriteResponseV1,
  type GradebookImportDiagnosticsAuditListResponseV1,
  type GradebookImportDiagnosticsAuditRequestV1,
  type GradebookImportDiagnosticsAuditWriteResponseV1,
} from '../../../../shared/gradebook-contracts/imports/import-diagnostics-v1';

const ENDPOINT = '/api/gradebook/import-diagnostics';

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function persistGradebookImportDiagnosticsAuditV1(
  request: GradebookImportDiagnosticsAuditRequestV1,
): Promise<GradebookImportDiagnosticsAuditWriteResponseV1> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (response.status === 401 || response.status === 403) {
    return { version: GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1, state: 'not-authorized' };
  }
  const value = await json(response);
  if (!isGradebookImportDiagnosticsAuditWriteResponseV1(value)) {
    return { version: GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1, state: 'unavailable' };
  }
  return value;
}

export async function listGradebookImportDiagnosticsAuditV1(
  input: {
    readonly academicYear?: number | null;
    readonly limit?: number;
    readonly offset?: number;
  } = {},
  signal?: AbortSignal,
): Promise<GradebookImportDiagnosticsAuditListResponseV1> {
  const params = new URLSearchParams();
  if (input.academicYear !== undefined && input.academicYear !== null) {
    params.set('ano', String(input.academicYear));
  }
  params.set('limit', String(Math.min(200, Math.max(1, input.limit ?? 50))));
  params.set('offset', String(Math.max(0, Math.floor(input.offset ?? 0))));
  const response = await fetch(`${ENDPOINT}?${params.toString()}`, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    return { version: GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1, state: 'not-authorized' };
  }
  if (!response.ok)
    return { version: GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1, state: 'unavailable' };
  const value = await json(response);
  if (!isGradebookImportDiagnosticsAuditListResponseV1(value)) {
    return { version: GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1, state: 'unavailable' };
  }
  return value;
}
