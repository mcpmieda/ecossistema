import * as XLSX from 'xlsx';
import type { SheetJs } from '../../src/features/gradebook/import/spreadsheet-recognizer';
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
  type GraphAppEnvV1,
} from '../../server/gradebook/onedrive-sync/graph-drive-v1';
import { prepareTeacherWorkbookV1 } from '../../server/gradebook/onedrive-sync/teacher-workbook-preparation-v1';

/**
 * Notas OneDrive sync — connection and read (PR 1 of 3).
 *
 * - `POST /graph/notificacoes`: Microsoft Graph change notifications (validation handshake and
 *   acknowledgement). Nothing is read or written from a notification yet.
 * - `POST /sonda`: a bearer-protected probe of the configured folder. It lists the workbooks,
 *   reads one with the server-side import path (no writes) and, on request, proves that Graph
 *   accepts this Worker's webhook. The answer has counts and timings only: no names or grades.
 */
export interface NotasSyncEnvV1 extends GraphAppEnvV1 {
  NOTAS_SITE_ID: string;
  NOTAS_FOLDER_PATH: string;
  NOTAS_MAX_WORKBOOK_BYTES?: string;
  NOTAS_SYNC_CLIENT_STATE?: string;
  NOTAS_SYNC_PROBE_TOKEN?: string;
}

const NOTIFICATION_PATH = '/graph/notificacoes';
const DEFAULT_MAX_WORKBOOK_BYTES = 8 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
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
export async function handleNotificationV1(request: Request, env: NotasSyncEnvV1): Promise<Response> {
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

export async function handleProbeV1(request: Request, env: NotasSyncEnvV1): Promise<Response> {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!env.NOTAS_SYNC_PROBE_TOKEN || !sameSecretV1(token, env.NOTAS_SYNC_PROBE_TOKEN)) return json({ error: 'unauthorized' }, 401);
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

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname === NOTIFICATION_PATH) return handleNotificationV1(request, env);
    if (request.method === 'POST' && pathname === '/sonda') {
      try {
        return await handleProbeV1(request, env);
      } catch (cause) {
        const status = typeof cause === 'object' && cause && 'status' in cause ? Number(cause.status) : null;
        return json({ error: 'probe-failed', graphStatus: status }, 502);
      }
    }
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<NotasSyncEnvV1>;
