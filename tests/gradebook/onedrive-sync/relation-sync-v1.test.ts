// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

import { isGradebookImportDiagnosticsAuditRequestV1 } from '../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import type {
  GradebookImportPersistenceRequestV9,
  GradebookImportPersistenceResponseV9,
} from '../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type { GradebookPostgresDatabaseV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { relationReviewItemsV1 } from '../../../server/gradebook/onedrive-sync/server-audit-v1';
import { finishReadingV1, newSyncFileV1, rereadFileV1, startReadingV1 } from '../../../server/gradebook/onedrive-sync/sync-rules-v1';
import { writePreparedWorkbookV1, type PreparedWorkbookV1 } from '../../../server/gradebook/onedrive-sync/write-prepared-v1';

const { sourceOfV1 } = await import('../../../server/gradebook/onedrive-sync/sync-coordinator-v1');

const audit = {
  version: 1, academicYear: 2026, fileName: 'RELACAO SINTETICA 2026.xlsb', sha256: 'a'.repeat(64), diagnostics: [],
} as const;
const relation = { operation: 'persist-relacao', ano: 2026, turmas: [{ codigo: '6A' }] } as unknown as GradebookImportPersistenceRequestV9;
const prepared: PreparedWorkbookV1 = { outcome: 'ready', request: relation, audit, studentNames: [] };
const input = { name: 'RELACAO SINTETICA 2026.xlsb', modifiedAt: '2026-11-14T10:00:00Z', expectedYear: 2026, memory: null };

function portsV1(response: GradebookImportPersistenceResponseV9) {
  const audits: Array<{ diagnostics: ReadonlyArray<{ code: string }> }> = [];
  const persist = vi.fn(async () => response);
  const notifyPortal = vi.fn(async () => undefined);
  return {
    audits, persist, notifyPortal,
    ports: {
      database: {} as GradebookPostgresDatabaseV1, notifyPortal, now: () => 0,
      services: {
        recordAudit: async (_database: unknown, written: { diagnostics: ReadonlyArray<{ code: string }> }) => { audits.push(written); },
        persist,
        relationNames: vi.fn(async () => new Map<string, string>()),
      },
    },
  };
}

describe('the Relação through the OneDrive sync', () => {
  it('is written whole, nudges the Portal and asks the year to be read again', async () => {
    const { ports, persist, notifyPortal, audits } = portsV1({ transportVersion: 9, state: 'applied' } as GradebookImportPersistenceResponseV9);
    const written = await writePreparedWorkbookV1(input, prepared, ports);
    expect(written).toMatchObject({ outcome: 'applied', relationChanged: true });
    expect(persist).toHaveBeenCalledWith(ports.database, relation);
    expect(ports.services.relationNames).not.toHaveBeenCalled();
    expect(notifyPortal).toHaveBeenCalledOnce();
    expect(audits).toHaveLength(1);
    expect(Object.keys(written.memory!.offers)).toEqual(['#relacao']);
  });

  it('the same Relação again does not touch the database', async () => {
    const first = portsV1({ transportVersion: 9, state: 'applied' } as GradebookImportPersistenceResponseV9);
    const { memory } = await writePreparedWorkbookV1(input, prepared, first.ports);
    const again = portsV1({ transportVersion: 9, state: 'applied' } as GradebookImportPersistenceResponseV9);
    const written = await writePreparedWorkbookV1({ ...input, memory: memory! }, prepared, again.ports);
    expect(written.outcome).toBe('no-changes');
    expect(written.relationChanged).toBeUndefined();
    expect(again.persist).not.toHaveBeenCalled();
    expect(again.audits).toHaveLength(0);
  });

  it('a doubtful class move holds the Relação and becomes one Auditoria finding per move', async () => {
    const review = {
      digest: 'd',
      groups: [{ origins: [{ classCode: '6A', number: 12, name: 'ALUNO SINTETICO UM' }, { classCode: '6A', number: 13, name: 'ALUNO SINTETICO DOIS' }],
        destinations: [{ classCode: '6B', number: 30, name: 'ALUNO SINTETICO UM' }, { classCode: '6B', number: 31, name: 'ALUNO SINTETICO DOIS' }] }],
    };
    const { ports, audits, notifyPortal } = portsV1({ transportVersion: 9, state: 'review-required', reason: 'Confira.', movementReview: review });
    const written = await writePreparedWorkbookV1(input, prepared, ports);
    expect(written).toMatchObject({ outcome: 'blocked', code: 'RELATION-REVIEW' });
    expect(written.relationChanged).toBeUndefined();
    expect(written.memory?.offers).toEqual({});
    expect(notifyPortal).not.toHaveBeenCalled();
    expect(audits[0]!.diagnostics.map((item) => item.code)).toEqual(['class-move-review']);
  });

  it('a save that changes only the file bytes (manifest) is not written again', async () => {
    const first = portsV1({ transportVersion: 9, state: 'applied' } as GradebookImportPersistenceResponseV9);
    const withManifest = { ...relation, manifest: { sha256: 'a' } } as unknown as GradebookImportPersistenceRequestV9;
    const { memory } = await writePreparedWorkbookV1(input, { ...prepared, request: withManifest }, first.ports);
    const again = portsV1({ transportVersion: 9, state: 'applied' } as GradebookImportPersistenceResponseV9);
    const resaved = { ...relation, manifest: { sha256: 'b' } } as unknown as GradebookImportPersistenceRequestV9;
    expect((await writePreparedWorkbookV1({ ...input, memory: memory! }, { ...prepared, request: resaved }, again.ports)).outcome).toBe('no-changes');
    expect(again.persist).not.toHaveBeenCalled();
  });

  it('a Relação committed before a later failure still asks the year to be read again', async () => {
    const { ports } = portsV1({ transportVersion: 9, state: 'applied' } as GradebookImportPersistenceResponseV9);
    ports.services.recordAudit = async () => { throw Object.assign(new Error('down'), { code: '08006' }); };
    const written = await writePreparedWorkbookV1(input, prepared, ports);
    expect(written).toMatchObject({ outcome: 'failed', code: 'DATABASE-WRITE', relationChanged: true });
  });

  it('findings follow the Auditoria contract, with or without the pairs', () => {
    const groups = [{ origins: [{ classCode: '7C', number: 2, name: 'X'.repeat(300) }], destinations: [{ classCode: '7D', number: 9, name: 'Y' }] }];
    for (const items of [relationReviewItemsV1('R.xlsb', 'Confira os alunos.', { digest: 'd', groups }), relationReviewItemsV1('R.xlsb', 'Confira.', undefined)]) {
      expect(items).toHaveLength(1);
      expect(isGradebookImportDiagnosticsAuditRequestV1({ ...audit, diagnostics: items })).toBe(true);
    }
  });
});

describe('teacher workbooks after the Relação changed', () => {
  const file = { ...newSyncFileV1({ id: 'f', name: 'NOTAS.xlsb', size: 1, modifiedAt: '', hash: 'h', deleted: false }),
    processedHash: 'h', memory: { audit: 'a', offers: { x: 'y' } } };

  it('an idle workbook is read again whole', () => {
    expect(rereadFileV1(file, 100)).toMatchObject({ state: 'pending', dueAt: 100, memory: null, processedHash: null });
  });

  it('a read in progress is repeated whole when it ends', () => {
    const reading = rereadFileV1(startReadingV1(file, 'lease', 0), 50);
    const finished = finishReadingV1(reading, 'lease',
      { outcome: 'no-changes', code: null, readHash: 'h', readMs: 1, savedToWrittenMs: null, memory: { audit: 'b', offers: {} } }, 60)!;
    expect(finished).toMatchObject({ state: 'pending', dueAt: 60, memory: null, processedHash: null, forget: false });
  });

  it('a removed workbook stays as it is', () => {
    const removed = { ...file, removed: true };
    expect(rereadFileV1(removed, 1)).toBe(removed);
  });
});

describe('sources of the sync', () => {
  const sources = {
    folder26: { itemId: 'folder26', kind: 'folder' as const, path: 'NOTAS 2026', year: 2026, setBy: 'A', setAt: 0 },
    rel26: { itemId: 'rel26', kind: 'file' as const, path: 'ADM/2026/RELACAO 2026.xlsb', year: 2026, setBy: 'A', setAt: 0 },
  };
  it('a workbook belongs to its folder source or is itself a source; anything else is ignored', () => {
    expect(sourceOfV1({ id: 'x', parentId: 'folder26' }, sources)?.itemId).toBe('folder26');
    expect(sourceOfV1({ id: 'rel26', parentId: 'adm2026' }, sources)?.itemId).toBe('rel26');
    expect(sourceOfV1({ id: 'other', parentId: 'adm2026' }, sources)).toBeNull();
    expect(sourceOfV1({ id: 'y', parentId: null }, sources)).toBeNull();
  });
});
