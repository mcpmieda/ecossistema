// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { GradebookImportPersistenceResponseV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type { GradebookPostgresDatabaseV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { WorkbookTooLargeError } from '../../../server/gradebook/onedrive-sync/graph-drive-v1';
import { processWorkbookV1, type ProcessWorkbookPortsV1 } from '../../../server/gradebook/onedrive-sync/process-workbook-v1';
import { loadRealSheetJsV1, writeRealWorkbookV1, type RealSheetJsV1 } from '../fixtures/sheetjs-real-v1';
import { WORKBOOK_READER_EQUIVALENCE_CASES_V1 } from '../fixtures/workbook-reader-equivalence-v1';

let xlsx: RealSheetJsV1;
beforeAll(async () => {
  xlsx = await loadRealSheetJsV1();
});
const input = { driveId: 'd', itemId: 'i', name: 'SINTETICO.xlsb', hash: 'h1', modifiedAt: '2026-11-13T10:00:00.000Z', maxBytes: 8 << 20 };
const bytesOf = (id: string) =>
  writeRealWorkbookV1(xlsx, WORKBOOK_READER_EQUIVALENCE_CASES_V1.find((item) => item.id === id)!.workbook, 'xlsb');

function portsV1(options: {
  bytes?: ArrayBuffer; download?: () => Promise<ArrayBuffer>; persistState?: GradebookImportPersistenceResponseV9['state'];
  persistThrows?: boolean; openFails?: boolean;
}) {
  const calls: string[] = [];
  const database = { close: vi.fn(async () => undefined) } as unknown as GradebookPostgresDatabaseV1;
  const ports: ProcessWorkbookPortsV1 = {
    env: { TENANT_ID: 't', GRAPH_CLIENT_ID: 'c' },
    xlsx,
    openDatabase: async () => {
      if (options.openFails) throw new Error('down');
      calls.push('open');
      return database;
    },
    notifyPortal: async () => { calls.push('portal'); },
    now: () => 0,
    download: options.download ?? (async () => options.bytes!),
    services: {
      recordAudit: async () => { calls.push('audit'); },
      persist: async () => {
        calls.push('persist');
        if (options.persistThrows) throw new Error('write failed');
        return { transportVersion: 9, state: options.persistState ?? 'applied' } as GradebookImportPersistenceResponseV9;
      },
    },
  };
  return { ports, calls, database };
}

describe('one sync read', () => {
  it('records the Auditoria, then writes the grades, then nudges the Portal', async () => {
    const { ports, calls, database } = portsV1({ bytes: bytesOf('teacher') });
    const result = await processWorkbookV1(input, ports);
    expect(result).toMatchObject({ outcome: 'applied', readHash: 'h1' });
    expect(calls).toEqual(['open', 'audit', 'persist', 'portal']);
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('reports no-changes without nudging the Portal', async () => {
    const { ports, calls } = portsV1({ bytes: bytesOf('teacher'), persistState: 'no-changes' });
    expect((await processWorkbookV1(input, ports)).outcome).toBe('no-changes');
    expect(calls).not.toContain('portal');
  });

  it('an invalid grade is never written', async () => {
    const written: string[] = [];
    const { ports, calls } = portsV1({ bytes: bytesOf('negative-grade') });
    const services = ports.services!;
    const result = await processWorkbookV1(input, {
      ...ports,
      services: { ...services, persist: async (database, request) => {
        written.push(JSON.stringify(request));
        return services.persist(database, request);
      } },
    });
    // Before BN-DEC-045 the whole file is blocked; with it, only that grade and its AM are held.
    if (!calls.includes('persist')) {
      expect(result.outcome).toBe('blocked');
      return;
    }
    expect(written[0]).not.toContain('-1000');
    expect(written[0]).toContain('["u"]');
  });

  it('maps service refusals and failures', async () => {
    expect((await processWorkbookV1(input, portsV1({ bytes: bytesOf('teacher'), persistState: 'conflict' }).ports)).outcome).toBe('rejected');
    expect((await processWorkbookV1(input, portsV1({ bytes: bytesOf('teacher'), persistState: 'unavailable' }).ports)).outcome).toBe('failed');
    expect((await processWorkbookV1(input, portsV1({ bytes: bytesOf('teacher'), persistThrows: true }).ports)).outcome).toBe('failed');
    expect((await processWorkbookV1(input, portsV1({ bytes: bytesOf('teacher'), openFails: true }).ports)).outcome).toBe('failed');
  });

  it('separates a download failure, a file too large and an unreadable file', async () => {
    const failing = portsV1({ download: async () => { throw new Error('graph'); } });
    expect(await processWorkbookV1(input, failing.ports)).toMatchObject({ outcome: 'failed', readHash: null });
    const large = portsV1({ download: async () => { throw new WorkbookTooLargeError(9 << 20); } });
    expect((await processWorkbookV1(input, large.ports)).outcome).toBe('too-large');
    const junk = portsV1({ bytes: new Uint8Array([1, 2, 3]).buffer });
    expect((await processWorkbookV1(input, junk.ports)).outcome).toBe('unreadable');
    expect(junk.calls).toEqual([]);
  });
});
