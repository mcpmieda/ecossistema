import type { RuntimeEnv } from '../../env';
import { HttpError, readBoundedJson } from '../../http/security';
import { isGradebookImportDiagnosticsAuditRequestV1 } from '../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import {
  inspectGradebookImportPersistenceRequestV9,
  type GradebookImportPersistenceRequestV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type { PortalAdminServiceBindingV1 } from '../../../shared/student-portal-contracts/ports-v1';
import type { GradebookPostgresDatabaseV1 } from '../persistence/postgres/postgres-database-v1';
import {
  writePreparedWorkbookV1,
  type PreparedWorkbookV1,
  type WriteInputV1,
} from '../onedrive-sync/write-prepared-v1';

/**
 * The database half of a OneDrive read, run here (next to the database) at the request of the
 * notas-onedrive-sync Worker. Server to server only: a shared secret, no session, no browser.
 */
export const ONEDRIVE_SYNC_WRITE_PATH_V1 = '/api/gradebook/onedrive-sync/gravar';
const MAX_BODY_BYTES_V1 = 8 * 1024 * 1024;

function sameSecretV1(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0 && expected.length >= 32;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

function writeInputV1(value: unknown): WriteInputV1 | null {
  if (!record(value) || !text(value.name, 255) || !text(value.modifiedAt, 64)) return null;
  const year = value.expectedYear;
  if (year !== null && !(Number.isSafeInteger(year) && Number(year) >= 2000 && Number(year) <= 9999)) return null;
  const memory = value.memory;
  if (memory !== null) {
    if (!record(memory) || !(memory.audit === null || text(memory.audit, 64)) || !record(memory.offers)) return null;
    const offers = Object.entries(memory.offers);
    if (offers.length > 600 || !offers.every(([key, print]) => key.length <= 400 && text(print, 64))) return null;
  }
  return { name: value.name, modifiedAt: value.modifiedAt, expectedYear: year as number | null, memory: memory as WriteInputV1['memory'] };
}

function preparedV1(value: unknown): PreparedWorkbookV1 | null {
  if (!record(value) || !isGradebookImportDiagnosticsAuditRequestV1(value.audit)) return null;
  if (value.outcome === 'blocked') return { outcome: 'blocked', audit: value.audit };
  if (value.outcome !== 'ready' || !record(value.request) || value.request.operation !== 'persist-notas') return null;
  if (inspectGradebookImportPersistenceRequestV9(value.request) !== 'ready') return null;
  const names = value.studentNames;
  if (!Array.isArray(names) || names.length > 5000
    || !names.every((pair) => Array.isArray(pair) && pair.length === 2 && text(pair[0], 64) && typeof pair[1] === 'string' && pair[1].length <= 256)) return null;
  return {
    outcome: 'ready', request: value.request as unknown as GradebookImportPersistenceRequestV9,
    audit: value.audit, studentNames: names as ReadonlyArray<readonly [string, string]>,
  };
}

export async function handleOneDriveSyncWriteRequestV1(
  request: Request,
  env: RuntimeEnv,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== ONEDRIVE_SYNC_WRITE_PATH_V1) return null;
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const secret = env.NOTAS_SYNC_WRITE_TOKEN;
  const given = request.headers.get('Authorization')?.replace(/^Bearer\s+/u, '') ?? '';
  if (!secret || !sameSecretV1(given, secret)) return Response.json({ version: 1, state: 'not-authorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_BODY_BYTES_V1);
  } catch (cause) {
    return Response.json({ version: 1, state: 'invalid-request' }, { status: cause instanceof HttpError ? cause.status : 400 });
  }
  const input = record(body) && body.version === 1 ? writeInputV1(body.input) : null;
  const prepared = record(body) ? preparedV1(body.prepared) : null;
  if (!input || !prepared) return Response.json({ version: 1, state: 'invalid-request' }, { status: 400 });

  const database = env.GRADEBOOK_DATABASE as GradebookPostgresDatabaseV1 | undefined;
  if (!database) return Response.json({ version: 1, state: 'unavailable' }, { status: 503 });
  const portal = env.PORTAL_SERVICE as PortalAdminServiceBindingV1 | undefined;
  const outcome = await writePreparedWorkbookV1(input, prepared, {
    database,
    source: 'notas-sync-pages',
    now: () => performance.now(),
    // The app identity is the technical author of the sync; the Portal outbox stays authoritative.
    notifyPortal: async () => {
      if (!portal?.drainLive) return;
      waitUntil(Promise.resolve().then(() => portal.drainLive!({
        actorId: env.GRAPH_CLIENT_ID, tenantId: env.TENANT_ID, requestId: crypto.randomUUID(),
        authenticatedAt: new Date().toISOString(), capability: 'gradebook.persistence.admin',
      })).catch(() => undefined));
    },
  });
  return Response.json({ version: 1, state: 'written', outcome });
}
