import { WorkerEntrypoint } from 'cloudflare:workers';
import * as XLSX from 'xlsx';
import {
  ONEDRIVE_SYNC_CONTRACT_VERSION_V1,
  oneDriveSyncRequestSchemaV1,
  type OneDriveSyncActorV1,
  type OneDriveSyncResponseV1,
} from '../../shared/gradebook-contracts/onedrive-sync/onedrive-sync-contract-v1';
import type { PortalAdminServiceBindingV1 } from '../../shared/student-portal-contracts/ports-v1';
import type { SheetJs } from '../../src/features/gradebook/import/spreadsheet-recognizer';
import {
  graphChildFoldersV1,
  graphCreateDriveSubscriptionV1,
  graphDeleteSubscriptionV1,
  graphDownloadWorkbookV1,
  graphDriveIdV1,
  graphFolderWorkbooksV1,
  WorkbookTooLargeError,
} from '../../server/gradebook/onedrive-sync/graph-drive-v1';
import { processWorkbookV1, type ProcessWorkbookInputV1 } from '../../server/gradebook/onedrive-sync/process-workbook-v1';
import {
  NotasSyncCoordinatorV1,
  type SyncCoordinatorEnvV1,
} from '../../server/gradebook/onedrive-sync/sync-coordinator-v1';
import type { ReadResultV1 } from '../../server/gradebook/onedrive-sync/sync-rules-v1';
import { prepareTeacherWorkbookV1 } from '../../server/gradebook/onedrive-sync/teacher-workbook-preparation-v1';
import { createGradebookPostgresDatabaseV1 } from '../../server/gradebook/persistence/postgres/postgres-database-v1';

export { NotasSyncCoordinatorV1 };

/**
 * Notas OneDrive sync: reads the teachers' grade workbooks from the secretaria's OneDrive and
 * writes what changed, through the same import, Auditoria and persistence as the browser.
 *
 * - `POST /graph/notificacoes`: Graph change notifications; a valid one wakes the coordinator.
 * - cron (every minute): safety-net delta, nightly full check and webhook renewal.
 * - `NotasSyncAdminV1.handle`: the admin panel, reached only through the Pages service binding
 *   after the admin session is checked there. No public route operates the sync.
 * - `NotasSyncReaderV1.fetch`: one read, in its own invocation, requested by the coordinator
 *   through `SELF` (a request, so the Worker runs next to the database).
 */
export interface NotasSyncEnvV1 extends Omit<SyncCoordinatorEnvV1, 'SELF'> {
  NOTAS_SYNC?: DurableObjectNamespace<NotasSyncCoordinatorV1>;
  SELF?: SyncCoordinatorEnvV1['SELF'];
  PROD_DB?: { readonly connectionString: string };
  PORTAL_SERVICE?: PortalAdminServiceBindingV1;
}

const NOTIFICATION_PATH = '/graph/notificacoes';
const DEFAULT_MAX_WORKBOOK_BYTES = 8 * 1024 * 1024;
// Created in South America, next to the database (São Paulo): the reads it starts run there too.
const COORDINATOR_NAME = 'notas-onedrive-sync-sam';
const PREVIEW_NAMES_LIMIT = 60;

function coordinatorV1(env: NotasSyncEnvV1) {
  if (!env.NOTAS_SYNC) throw new Error('notas-sync-coordinator-binding-missing');
  return env.NOTAS_SYNC.get(env.NOTAS_SYNC.idFromName(COORDINATOR_NAME), { locationHint: 'sam' });
}

/** Constant-time comparison of two secrets of any length. */
export function sameSecretV1(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0 && expected.length > 0;
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

async function webhookAcceptedV1(env: NotasSyncEnvV1, driveId: string): Promise<boolean | null> {
  if (!env.NOTAS_SYNC_CLIENT_STATE || !env.NOTAS_SYNC_PUBLIC_URL) return null;
  try {
    const subscription = await graphCreateDriveSubscriptionV1(env, {
      driveId,
      notificationUrl: `${env.NOTAS_SYNC_PUBLIC_URL.replace(/\/+$/u, '')}${NOTIFICATION_PATH}`,
      clientState: env.NOTAS_SYNC_CLIENT_STATE,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await graphDeleteSubscriptionV1(env, subscription.id);
    return true;
  } catch {
    return false;
  }
}

/** Read-only look at a folder before it is used: its workbooks, one read without writing, the webhook. */
async function previewV1(env: NotasSyncEnvV1, folderId: string, testWebhook: boolean) {
  const driveId = await graphDriveIdV1(env, env.NOTAS_SITE_ID);
  const workbooks = await graphFolderWorkbooksV1(env, driveId, folderId);
  const sample = workbooks[0];
  let result: { outcome: 'ready' | 'blocked' | 'unreadable' | 'too-large' | 'failed' | 'none'; code: string | null;
    readMs: number | null; diagnostics: number | null } = { outcome: 'none', code: null, readMs: null, diagnostics: null };
  if (sample) {
    try {
      const bytes = await graphDownloadWorkbookV1(env, driveId, sample.id, maxWorkbookBytesV1(env));
      const prepared = await prepareTeacherWorkbookV1({
        bytes, fileName: sample.name, lastModified: Date.parse(sample.lastModifiedDateTime) || 0,
        xlsx: XLSX as unknown as SheetJs, now: () => Date.now(),
      });
      result = {
        outcome: prepared.outcome,
        code: prepared.outcome === 'unreadable' ? prepared.code : null,
        readMs: Math.round(prepared.summary.prepareMs),
        diagnostics: prepared.summary.diagnostics,
      };
    } catch (cause) {
      result = { outcome: cause instanceof WorkbookTooLargeError ? 'too-large' : 'failed', code: null, readMs: null, diagnostics: null };
    }
  }
  return {
    workbooks: workbooks.length,
    workbookBytes: workbooks.reduce((total, item) => total + item.size, 0),
    names: workbooks.slice(0, PREVIEW_NAMES_LIMIT).map((item) => item.name),
    sample: result,
    webhook: testWebhook ? { tested: true, accepted: await webhookAcceptedV1(env, driveId) } : { tested: false, accepted: null },
  };
}

/** The admin panel's single entry. The caller (Pages) has already checked the admin session. */
export async function handleAdminV1(env: NotasSyncEnvV1, actor: OneDriveSyncActorV1, input: unknown): Promise<OneDriveSyncResponseV1> {
  const version = ONEDRIVE_SYNC_CONTRACT_VERSION_V1;
  const parsed = oneDriveSyncRequestSchemaV1.safeParse(input);
  if (!parsed.success || !actor.id || !actor.name) return { contractVersion: version, state: 'invalid-request' };
  const request = parsed.data;
  try {
    switch (request.action) {
      case 'status':
        return { contractVersion: version, state: 'status', status: await coordinatorV1(env).status() };
      case 'folders': {
        const driveId = await graphDriveIdV1(env, env.NOTAS_SITE_ID);
        return { contractVersion: version, state: 'folders', parentId: request.parentId,
          folders: await graphChildFoldersV1(env, driveId, request.parentId) };
      }
      case 'preview':
        return { contractVersion: version, state: 'preview', preview: await previewV1(env, request.folderId, request.testWebhook) };
      default:
        return { contractVersion: version, state: 'status', status: await coordinatorV1(env).control(request, actor) };
    }
  } catch {
    return { contractVersion: version, state: 'unavailable' };
  }
}

/** Reached only through the Pages service binding (`NOTAS_SYNC_SERVICE`). */
export class NotasSyncAdminV1 extends WorkerEntrypoint<NotasSyncEnvV1> {
  async handle(actor: OneDriveSyncActorV1, input: unknown): Promise<OneDriveSyncResponseV1> {
    return handleAdminV1(this.env, actor, input);
  }
}

/** Where the reader runs (Cloudflare data center), logged once per isolate: the database is in São Paulo. */
let placementLogged = false;
function logPlacementOnceV1(): void {
  if (placementLogged) return;
  placementLogged = true;
  void fetch('https://www.cloudflare.com/cdn-cgi/trace').then((response) => response.text()).then((text) => {
    console.log(JSON.stringify({ event: 'notas-sync-placement', colo: /^colo=(\w+)$/mu.exec(text)?.[1] ?? null }));
  }).catch(() => undefined);
}

/** One read, in its own invocation: requested by the coordinator through the SELF binding only. */
export class NotasSyncReaderV1 extends WorkerEntrypoint<NotasSyncEnvV1> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    return Response.json(await this.processFile((await request.json()) as ProcessWorkbookInputV1));
  }

  private async processFile(input: ProcessWorkbookInputV1): Promise<ReadResultV1> {
    const env = this.env;
    logPlacementOnceV1();
    return processWorkbookV1(input, {
      env,
      xlsx: XLSX as unknown as SheetJs,
      openDatabase: () => {
        const connectionString = env.PROD_DB?.connectionString;
        if (!connectionString) throw new Error('notas-sync-database-binding-missing');
        // A read is far from the database and runs each query once: unnamed statements save a round trip each.
        return createGradebookPostgresDatabaseV1(connectionString, { prepare: false });
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
    return new Response('Not found', { status: 404 });
  },
  async scheduled(_controller, env, ctx) {
    if (env.NOTAS_SYNC) ctx.waitUntil(coordinatorV1(env).tick());
  },
} satisfies ExportedHandler<NotasSyncEnvV1>;
