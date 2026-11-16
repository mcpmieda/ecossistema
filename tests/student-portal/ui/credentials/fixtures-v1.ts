import { adminResponseV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import type {
  AdminCommandV1,
  AdminQueryV1,
  AdminResponseV1,
} from '../../../../shared/student-portal-contracts/admin-v1';
import type {
  AdminAccountReadV2,
  AdminReadQueryV2,
} from '../../../../shared/student-portal-contracts/admin-read-v2';
import { createPortalAdminClientV1 } from '../../../../src/features/student-portal-admin/shared/admin-client-v1';
import {
  createPortalAdminReadClientV2,
  type AccountsReadPageV2,
} from '../../../../src/features/student-portal-admin/accounts/accounts-client-v2';
import type { QrRendererV1 } from '../../../../src/features/student-portal-admin/credentials/qr-operation-v1';
import { qrPrintIdV1, qrPrintUrlV1 } from '../../qr-print/fixtures-v1';

export const QR_CLASS_V1 = { kind: 'class', academicYear: 2026, classId: 755001 } as const;
export const QR_META_V1 = { contractVersion: 1 as const, requestId: qrPrintIdV1(9000) };
export const qrJsonV1 = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
export const syntheticQrRendererV1: QrRendererV1 = async (cards, format, signal, progress) => {
  signal.throwIfAborted();
  progress(cards.length, cards.length);
  return {
    blob: new Blob(['SYNTHETIC ARTIFACT'], {
      type: format === 'pdf' ? 'application/pdf' : 'image/png',
    }),
    format,
    count: cards.length,
    pages: Math.ceil(cards.length / 6),
  };
};
export function qrMockV1(
  options: {
    count?: number;
    write?: (command: AdminCommandV1, signal?: AbortSignal | null) => Promise<Response> | undefined;
    query?: (
      query: AdminReadQueryV2 | AdminQueryV1,
      signal?: AbortSignal | null,
    ) => Promise<Response> | undefined;
  } = {},
) {
  const accounts: AdminAccountReadV2[] = Array.from({ length: options.count ?? 3 }, (_, index) => ({
    accountId: qrPrintIdV1(index + 1),
    link: { academicYear: 2026, studentId: 755000 + index + 1 },
    linkClosed: false,
    name: 'SYNTHETIC PRINT ' + String(index + 1).padStart(3, '0'),
    classLabel: 'SYNTHETIC CLASS 6A',
    classId: 755001,
    state: 'pending-activation',
    eligibility: 'eligible',
    blocked: false,
    version: 7 + index,
    access: {
      state: 'resolved',
      enabled: false,
      source: { kind: 'school', academicYear: 2026 },
      settingsVersion: 1,
      accessPermitted: false,
    },
    lastAuthenticationAt: null,
    validSessionCount: 0,
    firstAccess: { state: 'ready', qrIssued: true, recoveryReady: true },
  }));
  const writes: AdminCommandV1[] = [],
    bodies: string[] = [],
    queries: (AdminReadQueryV2 | AdminQueryV1)[] = [];
  const receipts = new Map<string, { body: string; response: AdminResponseV1 }>();
  let scopeVersion = 755;
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body),
      value = JSON.parse(body);
    if (String(input).endsWith('/query')) {
      const query = value as AdminReadQueryV2 | AdminQueryV1;
      queries.push(query);
      const custom = options.query?.(query, init?.signal);
      if (custom) return custom;
      if (query.operation !== 'accounts-read' && query.operation !== 'birth-years')
        return qrJsonV1({ ...QR_META_V1, state: 'invalid-request' }, 400);
      const filtered = accounts.filter((account) =>
        query.scope.kind === 'account'
          ? account.accountId === query.scope.accountId
          : query.scope.kind === 'class'
            ? account.classId === query.scope.classId
            : true,
      );
      const offset = query.page.cursor ? Number(query.page.cursor.slice(32)) : 0;
      if (query.operation === 'birth-years')
        return qrJsonV1({
          ...QR_META_V1,
          state: 'birth-years',
          scopeVersion: 47,
          items: filtered.slice(offset, offset + 100).map((a) => ({
            accountId: a.accountId,
            accountVersion: a.version,
            version: 1,
            year: '2005',
            confirmation: 'confirmed',
          })),
          nextCursor: offset + 100 < filtered.length ? 'b'.repeat(32) + (offset + 100) : null,
        });
      return qrJsonV1({
        ...QR_META_V1,
        contractVersion: 2,
        observedAt: '2026-09-13T18:00:00Z',
        lastAuthenticationWindowMonths: 12,
        state: 'accounts-read',
        scopeVersion,
        items: filtered.slice(offset, offset + 100),
        nextCursor: offset + 100 < filtered.length ? 'q'.repeat(32) + (offset + 100) : null,
      } satisfies AccountsReadPageV2);
    }
    const command = value as AdminCommandV1;
    writes.push(command);
    bodies.push(body);
    const custom = options.write?.(command, init?.signal);
    if (custom) return custom;
    const previous = receipts.get(command.idempotencyKey);
    if (previous)
      return previous.body === body
        ? qrJsonV1(previous.response)
        : qrJsonV1({ ...QR_META_V1, state: 'conflict' }, 409);
    if (!['qr-batch', 'qr-issue', 'qr-reprint'].includes(command.operation))
      return qrJsonV1({ ...QR_META_V1, state: 'invalid-request' }, 400);
    if (
      command.operation !== 'qr-batch' &&
      command.operation !== 'qr-issue' &&
      command.operation !== 'qr-reprint'
    )
      throw new Error('synthetic-operation');
    const ids = command.operation === 'qr-batch' ? command.accountIds : [command.accountId];
    const currentVersion =
      command.operation === 'qr-batch'
        ? scopeVersion
        : accounts.find((a) => a.accountId === ids[0])?.version;
    if (command.expectedVersion !== currentVersion)
      return qrJsonV1({ ...QR_META_V1, state: 'conflict' }, 409);
    const chosen = accounts.filter((a) => ids.includes(a.accountId));
    if (
      chosen.length !== ids.length ||
      chosen.some(
        (a) => a.linkClosed || (command.operation === 'qr-batch' && a.classId !== command.classId),
      )
    )
      return qrJsonV1({ ...QR_META_V1, state: 'forbidden' }, 403);
    const mode = command.operation === 'qr-batch' ? command.mode : 'qr-only';
    // Fixture accounts already possess their synthetic QR: issue/reprint preserve it and CAS.
    const response: AdminResponseV1 = adminResponseV1.parse({
      ...QR_META_V1,
      state: 'qr',
      version: currentVersion!,
      cards: chosen.map((a) => ({
        accountId: a.accountId,
        qr: qrPrintUrlV1(Number(a.accountId.slice(-12))),
        mode,
        ...(mode !== 'qr-only' ? { name: a.name } : {}),
        ...(mode === 'qr-name-class' ? { classLabel: a.classLabel } : {}),
      })),
    });
    receipts.set(command.idempotencyKey, { body, response });
    return qrJsonV1(response);
  };
  const client = createPortalAdminClientV1({ fetch: fetcher }),
    reader = createPortalAdminReadClientV2({ fetch: fetcher });
  return {
    accounts,
    writes,
    bodies,
    queries,
    receipts,
    client,
    reader,
    setScopeVersion: (value: number) => {
      scopeVersion = value;
    },
    props: {
      client,
      reader,
      scope: QR_CLASS_V1,
      identityKey: 'synthetic-operator',
      canWrite: true,
      scopeLabel: 'SYNTHETIC CLASS 6A',
      renderArtifact: syntheticQrRendererV1,
      catalog: async () => ({
        items: [
          { id: 755001, label: 'SYNTHETIC CLASS 6A' },
          { id: 755002, label: 'SYNTHETIC EMPTY CLASS' },
        ],
        nextOffset: null,
      }),
    },
  };
}
