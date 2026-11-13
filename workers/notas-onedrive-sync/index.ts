import { WorkerEntrypoint } from 'cloudflare:workers';
import * as XLSX from 'xlsx';
import type { SheetJs } from '../../src/features/gradebook/import/spreadsheet-recognizer';
import type { PortalAdminServiceBindingV1 } from '../../shared/student-portal-contracts/ports-v1';
import { createGradebookPostgresDatabaseV1 } from '../../server/gradebook/persistence/postgres/postgres-database-v1';
import {
  DRIVE_SUBSCRIPTION_MAX_MINUTES_V1,
  graphCreateDriveSubscriptionV1,
  graphDeleteSubscriptionV1,
  graphDownloadWorkbookV1,
  graphDriveDeltaV1,
  graphDriveIdV1,
  graphFolderIdByPathV1,
  graphFolderWorkbooksV1,
  WorkbookTooLargeError,
} from '../../server/gradebook/onedrive-sync/graph-drive-v1';
import { processWorkbookV1, type ProcessWorkbookInputV1 } from '../../server/gradebook/onedrive-sync/process-workbook-v1';
import {
  NotasSyncCoordinatorV1,
  type SyncControlV1,
  type SyncCoordinatorEnvV1,
} from '../../server/gradebook/onedrive-sync/sync-coordinator-v1';
import type { ReadResultV1 } from '../../server/gradebook/onedrive-sync/sync-rules-v1';
import { prepareTeacherWorkbookV1 } from '../../server/gradebook/onedrive-sync/teacher-workbook-preparation-v1';

export { NotasSyncCoordinatorV1 };

/**
 * Notas OneDrive sync: reads the teachers' grade workbooks from the secretaria's OneDrive and
 * writes what changed, through the same import, Auditoria and persistence as the browser.
 *
 * - `POST /graph/notificacoes`: Graph change notifications; a valid one wakes the coordinator.
 * - `GET /status`, `POST /controle`, `POST /sonda`: bearer-protected operation (PR 3 moves the
 *   panel into the admin centre). Answers carry file names and counts, never grades.
 * - cron (every minute): safety-net delta, nightly full check and webhook renewal.
 * - `NotasSyncReaderV1.processFile`: one read, in its own invocation, called by the coordinator.
 */
export interface NotasSyncEnvV1 extends Omit<SyncCoordinatorEnvV1, 'SELF'> {
  NOTAS_SYNC_PROBE_TOKEN?: string;
  NOTAS_SYNC?: DurableObjectNamespace<NotasSyncCoordinatorV1>;
  SELF?: SyncCoordinatorEnvV1['SELF'];
  PROD_DB?: { readonly connectionString: string };
  PORTAL_SERVICE?: PortalAdminServiceBindingV1;
}

const NOTIFICATION_PATH = '/graph/notificacoes';
const DEFAULT_MAX_WORKBOOK_BYTES = 8 * 1024 * 1024;
const COORDINATOR_NAME = 'notas-onedrive-sync';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function coordinatorV1(env: NotasSyncEnvV1) {
  if (!env.NOTAS_SYNC) throw new Error('notas-sync-coordinator-binding-missing');
  return env.NOTAS_SYNC.get(env.NOTAS_SYNC.idFromName(COORDINATOR_NAME));
}

/** Constant-time comparison of two secrets of any length. */
export function sameSecretV1(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0 && expected.length > 0;
}

function authorizedV1(request: Request, env: NotasSyncEnvV1): boolean {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return Boolean(env.NOTAS_SYNC_PROBE_TOKEN) && sameSecretV1(token, env.NOTAS_SYNC_PROBE_TOKEN ?? '');
}

/** Graph handshake: echo `validationToken` as text/plain within 10 s; otherwise acknowledge. */
export async function handleNotificationV1(request: Request, env: NotasSyncEnvV1,
  waitUntil: (work: Promise<unknown>) => void = () => undefined): Promise<Response> {
  const validationToken = new URL(request.url).searchParams.get('validationToken');
  if (validationToken !== null) {
    return new Response(validationToken, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  let accepted = 0;
  let rejected = 0;
  try {
    const body = (await request.json()) as { value?: Array<{ clientState?: unknown }> };
    for (const notification of Array.isArray(body.value) ? body.value : []) {
      const state = typeof notification.clientState === 'string' ? notification.clientState : '';
      if (env.NOTAS_SYNC_CLIENT_STATE && sameSecretV1(state, env.NOTAS_SYNC_CLIENT_STATE)) accepted++;
      else rejected++;
    }
  } catch {
    rejected++;
  }
  console.log(JSON.stringify({ event: 'notas-sync-notification', accepted, rejected }));
  if (accepted > 0 && env.NOTAS_SYNC) waitUntil(coordinatorV1(env).notify().catch(() => undefined));
  return new Response(null, { status: 202 });
}

function maxWorkbookBytesV1(env: NotasSyncEnvV1): number {
  const configured = Number(env.NOTAS_MAX_WORKBOOK_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_WORKBOOK_BYTES;
}

async function probeWebhookV1(env: NotasSyncEnvV1, driveId: string, origin: string) {
  if (!env.NOTAS_SYNC_CLIENT_STATE) return { tested: false, reason: 'client-state-missing' };
  try {
    const subscription = await graphCreateDriveSubscriptionV1(env, {
      driveId,
      notificationUrl: `${origin}${NOTIFICATION_PATH}`,
      clientState: env.NOTAS_SYNC_CLIENT_STATE,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await graphDeleteSubscriptionV1(env, subscription.id);
    return { tested: true, accepted: true, maxMinutes: DRIVE_SUBSCRIPTION_MAX_MINUTES_V1 };
  } catch (cause) {
    const status = typeof cause === 'object' && cause && 'status' in cause ? Number(cause.status) : null;
    return { tested: true, accepted: false, status };
  }
}

/** Read-only probe of the folder: lists, reads one workbook without writing, optionally tests the webhook. */
export async function handleProbeV1(request: Request, env: NotasSyncEnvV1): Promise<Response> {
  if (!authorizedV1(request, env)) return json({ error: 'unauthorized' }, 401);
  const url = new URL(request.url);
  const started = Date.now();
  const driveId = await graphDriveIdV1(env, env.NOTAS_SITE_ID);
  const folderId = await graphFolderIdByPathV1(env, driveId, env.NOTAS_FOLDER_PATH);
  const workbooks = await graphFolderWorkbooksV1(env, driveId, folderId);
  const delta = await graphDriveDeltaV1(env, driveId, null);
  const inFolder = delta.changes.filter((item) => item.parentId === folderId && !item.deleted).length;
  const index = Math.min(Math.max(Number(url.searchParams.get('arquivo') ?? 1), 1), Math.max(workbooks.length, 1)) - 1;
  const sample = workbooks[index];
  let read: Record<string, unknown> = { tested: false };
  if (sample) {
    const downloadStarted = Date.now();
    try {
      const bytes = await graphDownloadWorkbookV1(env, driveId, sample.id, maxWorkbookBytesV1(env));
      const downloadMs = Date.now() - downloadStarted;
      const prepared = await prepareTeacherWorkbookV1({
        bytes,
        fileName: sample.name,
        lastModified: Date.parse(sample.lastModifiedDateTime),
        xlsx: XLSX as unknown as SheetJs,
        now: () => Date.now(),
      });
      read = {
        tested: true,
        file: index + 1,
        outcome: prepared.outcome,
        ...(prepared.outcome === 'unreadable' ? { code: prepared.code } : {}),
        downloadMs,
        ...prepared.summary,
      };
    } catch (cause) {
      read = { tested: true, file: index + 1, outcome: cause instanceof WorkbookTooLargeError ? 'too-large' : 'failed' };
    }
  }
  const webhook = url.searchParams.get('webhook') === '1' ? await probeWebhookV1(env, driveId, url.origin) : { tested: false };
  return json({
    drive: true,
    folder: true,
    workbooks: workbooks.length,
    workbookBytes: workbooks.reduce((total, item) => total + item.size, 0),
    withQuickXorHash: workbooks.filter((item) => item.quickXorHash !== null).length,
    deltaWorkbooksInFolder: inFolder,
    read,
    webhook,
    totalMs: Date.now() - started,
  });
}

const CONTROL_ACTIONS_V1 = new Set(['enable', 'disable', 'pause', 'resume', 'read-all', 'set-wait', 'set-parallel', 'read-now']);

/** Validates a control command from the bearer-protected route. */
export function parseControlV1(value: unknown): SyncControlV1 | null {
  if (typeof value !== 'object' || value === null) return null;
  const command = value as Record<string, unknown>;
  if (typeof command.action !== 'string' || !CONTROL_ACTIONS_V1.has(command.action)) return null;
  if (command.action === 'set-wait') return typeof command.seconds === 'number' ? { action: 'set-wait', seconds: command.seconds } : null;
  if (command.action === 'set-parallel') return typeof command.count === 'number' ? { action: 'set-parallel', count: command.count } : null;
  if (command.action === 'read-now') return typeof command.fileId === 'string' && command.fileId ? { action: 'read-now', fileId: command.fileId } : null;
  return { action: command.action as 'enable' | 'disable' | 'pause' | 'resume' | 'read-all' };
}

async function handleOperationV1(request: Request, env: NotasSyncEnvV1, pathname: string): Promise<Response> {
  if (!authorizedV1(request, env)) return json({ error: 'unauthorized' }, 401);
  if (pathname === '/status') return json(await coordinatorV1(env).status());
  let command: SyncControlV1 | null;
  try {
    command = parseControlV1(await request.json());
  } catch {
    command = null;
  }
  if (!command) return json({ error: 'invalid-command' }, 400);
  return json(await coordinatorV1(env).control(command, 'token-de-operacao'));
}

/** One read, in its own invocation: called by the coordinator through the SELF binding. */
export class NotasSyncReaderV1 extends WorkerEntrypoint<NotasSyncEnvV1> {
  async processFile(input: ProcessWorkbookInputV1): Promise<ReadResultV1> {
    const env = this.env;
    return processWorkbookV1(input, {
      env,
      xlsx: XLSX as unknown as SheetJs,
      openDatabase: () => {
        const connectionString = env.PROD_DB?.connectionString;
        if (!connectionString) throw new Error('notas-sync-database-binding-missing');
        return createGradebookPostgresDatabaseV1(connectionString);
      },
      notifyPortal: async () => {
        // The app identity is the technical author of the sync; the Portal outbox stays authoritative.
        await env.PORTAL_SERVICE?.drainLive?.({
          actorId: env.GRAPH_CLIENT_ID, tenantId: env.TENANT_ID, requestId: crypto.randomUUID(),
          authenticatedAt: new Date().toISOString(), capability: 'gradebook.persistence.admin',
        });
      },
      now: () => performance.now(),
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname === NOTIFICATION_PATH)
      return handleNotificationV1(request, env, (work) => ctx?.waitUntil(work));
    try {
      if (request.method === 'POST' && pathname === '/sonda') return await handleProbeV1(request, env);
      if ((request.method === 'GET' && pathname === '/status') || (request.method === 'POST' && pathname === '/controle'))
        return await handleOperationV1(request, env, pathname);
    } catch (cause) {
      const status = typeof cause === 'object' && cause && 'status' in cause ? Number(cause.status) : null;
      return json({ error: 'operation-failed', graphStatus: status }, 502);
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(_controller, env, ctx) {
    if (env.NOTAS_SYNC) ctx.waitUntil(coordinatorV1(env).tick());
  },
} satisfies ExportedHandler<NotasSyncEnvV1>;
