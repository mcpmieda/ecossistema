// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { GradebookImportPersistenceResponseV9 } from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type { GradebookPostgresDatabaseV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { WorkbookTooLargeError } from '../../../server/gradebook/onedrive-sync/graph-drive-v1';
import { processWorkbookV1, type ProcessWorkbookPortsV1 } from '../../../server/gradebook/onedrive-sync/process-workbook-v1';
import { prepareTeacherWorkbookV1 } from '../../../server/gradebook/onedrive-sync/teacher-workbook-preparation-v1';
import { loadRealSheetJsV1, writeRealWorkbookV1, type RealSheetJsV1 } from '../fixtures/sheetjs-real-v1';
import { WORKBOOK_READER_EQUIVALENCE_CASES_V1 } from '../fixtures/workbook-reader-equivalence-v1';

let xlsx: RealSheetJsV1;
beforeAll(async () => {
  xlsx = await loadRealSheetJsV1();
});
const input = {
  driveId: 'd', itemId: 'i', name: 'SINTETICO.xlsb', hash: 'h1', modifiedAt: '2026-11-13T10:00:00.000Z', maxBytes: 8 << 20,
  expectedYear: null as number | null,
};
const bytesOf = (id: string) =>
  writeRealWorkbookV1(xlsx, WORKBOOK_READER_EQUIVALENCE_CASES_V1.find((item) => item.id === id)!.workbook, 'xlsb');

function portsV1(options: {
  bytes?: ArrayBuffer; download?: () => Promise<ArrayBuffer>; persistState?: GradebookImportPersistenceResponseV9['state'];
  persistThrows?: boolean; openFails?: boolean; relation?: ReadonlyMap<string, string>;
}) {
  const calls: string[] = [];
  const audits: Array<{ academicYear: number | null; diagnostics: ReadonlyArray<{ code: string }> }> = [];
  const persisted: unknown[] = [];
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
      recordAudit: async (_database, audit) => { calls.push('audit'); audits.push(audit); },
      persist: async (_database, request) => {
        calls.push('persist');
        persisted.push(request);
        if (options.persistThrows) throw new Error('write failed');
        return { transportVersion: 9, state: options.persistState ?? 'applied' } as GradebookImportPersistenceResponseV9;
      },
      relationNames: async () => options.relation ?? new Map(),
    },
  };
  return { ports, calls, database, audits, persisted };
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

  it('rule 3: a workbook of another year writes nothing and is reported under the folder year', async () => {
    const probe = portsV1({ bytes: bytesOf('teacher') });
    await processWorkbookV1(input, probe.ports);
    const year = probe.audits[0]!.academicYear!;
    const wrong = portsV1({ bytes: bytesOf('teacher') });
    expect(await processWorkbookV1({ ...input, expectedYear: year + 1 }, wrong.ports)).toMatchObject({ outcome: 'blocked', code: 'WRONG-YEAR' });
    expect(wrong.calls).not.toContain('persist');
    expect(wrong.audits[0]!.academicYear).toBe(year + 1);
    expect(wrong.audits[0]!.diagnostics.map((item) => item.code)).toContain('wrong-year');
    expect((await processWorkbookV1({ ...input, expectedYear: year }, portsV1({ bytes: bytesOf('teacher') }).ports)).outcome).toBe('applied');
  });

  it('rule 14: a student whose name differs from the Relação is held; a matching one is written', async () => {
    const prepared = await prepareTeacherWorkbookV1({ bytes: bytesOf('teacher'), fileName: 'SINTETICO.xlsb', lastModified: 0, xlsx });
    if (prepared.outcome !== 'ready') throw new Error('unexpected');
    const [key, name] = [...prepared.studentNames.entries()][0]!;
    const numero = Number(key.split('|')[1]);
    const studentRow = (request: unknown) => (request as { ofertas: Array<{ trimestres: Array<{ alunos: Array<[number, unknown[], unknown]> }> }> })
      .ofertas[0]!.trimestres[0]!.alunos.find(([number]) => number === numero)!;

    const other = portsV1({ bytes: bytesOf('teacher'), relation: new Map([[key, 'PESSOA SINTÉTICA DIFERENTE']]) });
    await processWorkbookV1(input, other.ports);
    expect(studentRow(other.persisted[0])[2]).toEqual(['u']);
    expect(studentRow(other.persisted[0])[1].every((cell) => Array.isArray(cell))).toBe(true);
    expect(other.audits[0]!.diagnostics.map((item) => item.code)).toContain('student-name-mismatch');

    const same = portsV1({ bytes: bytesOf('teacher'), relation: new Map([[key, name]]) });
    await processWorkbookV1(input, same.ports);
    expect(same.audits[0]!.diagnostics.map((item) => item.code)).not.toContain('student-name-mismatch');
  });

  it('separates a download failure, a file too large and an unreadable file', async () => {
    const failing = portsV1({ download: async () => { throw new Error('graph'); } });
    expect(await processWorkbookV1(input, failing.ports)).toMatchObject({ outcome: 'failed', readHash: null });
    const large = portsV1({ download: async () => { throw new WorkbookTooLargeError(9 << 20); } });
    expect((await processWorkbookV1(input, large.ports)).outcome).toBe('too-large');
    const junk = portsV1({ bytes: new Uint8Array([1, 2, 3]).buffer });
    expect((await processWorkbookV1(input, junk.ports)).outcome).toBe('unreadable');
    // The connection is opened early (alongside the download), but nothing is written.
    expect(junk.calls).toEqual(['open']);
    expect(junk.database.close).toHaveBeenCalledOnce();
  });
});

describe('memory of the last write (speed)', () => {
  it('a save with nothing new touches neither the Auditoria nor the grades', async () => {
    const first = portsV1({ bytes: bytesOf('teacher') });
    const written = await processWorkbookV1(input, first.ports);
    expect(written.memory?.audit).toMatch(/^[0-9a-f]{32}$/u);
    const again = portsV1({ bytes: bytesOf('teacher') });
    const result = await processWorkbookV1({ ...input, memory: written.memory }, again.ports);
    expect(result.outcome).toBe('no-changes');
    expect(again.calls).toEqual(['open']);
  });

  it('only the classes/subjects that changed are sent', async () => {
    const first = portsV1({ bytes: bytesOf('teacher') });
    const written = await processWorkbookV1(input, first.ports);
    const offers = (first.persisted[0] as { ofertas: Array<{ turmaCodigo: string; disciplina: string }> }).ofertas;
    const [kept] = offers;
    const stale = { ...written.memory!, offers: { ...written.memory!.offers, [`${kept!.turmaCodigo}|${kept!.disciplina}`]: 'old' } };
    const next = portsV1({ bytes: bytesOf('teacher') });
    await processWorkbookV1({ ...input, memory: stale }, next.ports);
    expect(next.calls).toEqual(['open', 'persist', 'portal']);
    expect((next.persisted[0] as { ofertas: unknown[] }).ofertas).toHaveLength(1);
  });

  it('a failed write keeps the old memory, so the next read writes again', async () => {
    const failing = portsV1({ bytes: bytesOf('teacher'), persistThrows: true });
    const result = await processWorkbookV1(input, failing.ports);
    expect(result.outcome).toBe('failed');
    expect(result.memory).toBeUndefined();
  });
});
