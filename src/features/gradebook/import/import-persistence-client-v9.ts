import { notifyLiveChangeV1 } from '../../../shared/live-data/live-refresh-v1';
import {
  isGradebookImportPersistenceRequestV9,
  isGradebookImportPersistenceResponseV9,
  type GradebookImportPersistenceRequestV9,
  type GradebookImportPersistenceResponseV9,
} from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import {
  IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1,
  parseImportCommitDiagnosticsHeaderV1,
  type ImportCommitDiagnosticsV1,
} from '../../../../shared/gradebook-contracts/imports/import-commit-diagnostics-v1';

export interface ImportPersistenceHttpTimingV1 {
  readonly serializationMs: number | null;
  readonly payloadBytes: number | null;
  readonly persistRequestMs: number | null;
  readonly outcome: GradebookImportPersistenceResponseV9['state'] | 'confirmation-required';
  readonly commitDiagnostics?: ImportCommitDiagnosticsV1 | null;
}

function nowMs(): number {
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now();
}

/** Retry-After in whole seconds, 1 s to one day; 60 s when missing or unreadable. */
function retryAfterSecondsV9(raw: string | null) {
  const seconds = raw !== null && /^\d+$/u.test(raw) ? Number(raw) : 60;
  return Number.isFinite(seconds) ? Math.max(1, Math.min(86400, seconds)) : 60;
}

/** The server time header, when it is a non-negative number. */
function serverMsV9(raw: string | null) {
  const parsed = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Optional commit diagnostics; they cannot claim confirmation for an academically unconfirmed
 * response, change confirmation or repeat the POST. */
function commitDiagnosticsV9(
  headers: Headers,
  state: GradebookImportPersistenceResponseV9['state'],
): ImportCommitDiagnosticsV1 | null {
  try {
    const diagnostics = parseImportCommitDiagnosticsHeaderV1(
      headers.get(IMPORT_COMMIT_DIAGNOSTICS_HEADER_V1),
    );
    if (state !== 'applied' && state !== 'no-changes' && diagnostics?.confirmed !== null)
      return null;
    return diagnostics;
  } catch {
    return null;
  }
}

/** Optional timing cannot change a confirmed or uncertain result. */
function reportTimingV9(
  onTiming: ((timing: ImportPersistenceHttpTimingV1) => void) | undefined,
  timing: ImportPersistenceHttpTimingV1,
) {
  if (!onTiming) return;
  try {
    onTiming(timing);
  } catch {
    /* Timing has no authority over the result. */
  }
}

export async function persistGradebookCanonicalImportV9(
  request: GradebookImportPersistenceRequestV9,
  onTiming?: (timing: ImportPersistenceHttpTimingV1) => void,
  onDispatch?: () => void,
): Promise<{
  readonly response: GradebookImportPersistenceResponseV9;
  readonly serverMs: number | null;
}> {
  if (!isGradebookImportPersistenceRequestV9(request))
    throw new Error('Pacote acadêmico canônico inválido.');
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), 120_000);
  let serializationMs: number | null = null;
  let payloadBytes: number | null = null;
  let requestStartedAt: number | null = null;
  let outcome: ImportPersistenceHttpTimingV1['outcome'] = 'confirmation-required';
  let commitDiagnostics: ImportCommitDiagnosticsV1 | null = null;
  try {
    const serializationStartedAt = nowMs();
    const body = JSON.stringify(request);
    serializationMs = nowMs() - serializationStartedAt;
    payloadBytes = new TextEncoder().encode(body).byteLength;
    requestStartedAt = nowMs();
    try {
      onDispatch?.();
    } catch {
      /* Timing has no authority over dispatch. */
    }
    const response = await fetch('/api/gradebook/import-persistence', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (response.status === 401 || response.status === 403) {
      outcome = 'not-authorized';
      return { response: { transportVersion: 9, state: 'not-authorized' }, serverMs: null };
    }
    if (response.status === 429) {
      const wait = retryAfterSecondsV9(response.headers.get('Retry-After'));
      outcome = 'unavailable';
      // A refused request is not committed. The existing queue stops; never repeat this POST here.
      throw new Error(`Muitas solicitações. Aguarde ${wait} segundos antes de tentar novamente.`);
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error(`Gravação sem confirmação (HTTP ${response.status}; resposta não JSON).`);
    }
    if (!isGradebookImportPersistenceResponseV9(value)) {
      throw new Error(`Resposta incompatível do Banco de Notas (HTTP ${response.status}).`);
    }
    if (
      !response.ok &&
      !['blocked', 'conflict', 'invalid-request', 'unavailable'].includes(value.state)
    ) {
      throw new Error('Gravação sem confirmação válida.');
    }
    const serverMs = serverMsV9(response.headers.get('X-Gradebook-Server-Ms'));
    outcome = value.state;
    commitDiagnostics = commitDiagnosticsV9(response.headers, value.state);
    if (value.state === 'applied' || value.state === 'no-changes') notifyLiveChangeV1('gradebook');
    return { response: value, serverMs };
  } finally {
    globalThis.clearTimeout(timer);
    reportTimingV9(onTiming, {
      serializationMs,
      payloadBytes,
      persistRequestMs: requestStartedAt === null ? null : nowMs() - requestStartedAt,
      outcome,
      commitDiagnostics,
    });
  }
}
