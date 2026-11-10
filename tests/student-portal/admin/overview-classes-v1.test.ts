import { describe, expect, it } from 'vitest';
import {
  overviewClassesV2,
  overviewCountsV2,
} from '../../../server/student-portal/admin/queries-v2';
import { adminReadResponseV2 } from '../../../shared/student-portal-contracts/admin-read-v2';
import { overviewClassRowsV1 } from '../../../src/features/student-portal-admin/overview/overview-classes-v1';

type Item = Parameters<typeof overviewCountsV2>[0][number];
const item = (classId: number | null, extra: Partial<Item> = {}) =>
  ({
    classId,
    state: 'active',
    blocked: false,
    eligibility: classId === null ? 'unlinked' : 'eligible',
    access: { enabled: true, accessPermitted: true },
    validSessionCount: 0,
    ...extra,
  }) as unknown as Item;

describe('Visão geral por turma (10/11/2026)', () => {
  const items = [
    item(2, { state: 'pending-activation' }),
    item(1, { validSessionCount: 2 }),
    item(1, { blocked: true }),
    item(null),
  ];

  it('separa as mesmas contas por turma sem perder nenhuma', () => {
    const classes = overviewClassesV2(items);
    const byId = new Map(classes.map((row) => [row.classId, row.counts]));
    expect(byId.get(1)).toMatchObject({ accounts: 2, active: 2, blocked: 1, validSessions: 2 });
    expect(byId.get(2)).toMatchObject({ accounts: 1, active: 0, pendingActivation: 1 });
    expect(byId.get(null)).toMatchObject({ accounts: 1, unlinked: 1 });
    const total = overviewCountsV2(items);
    for (const key of Object.keys(total) as (keyof typeof total)[])
      expect(classes.reduce((sum, row) => sum + row.counts[key], 0)).toBe(total[key]);
  });

  it('o contrato aceita o resumo com e sem turmas', () => {
    const base = {
      contractVersion: 2,
      requestId: '00000000-0000-4000-8000-000000000001',
      observedAt: '2026-11-10T12:00:00.000Z',
      state: 'overview',
      scopeVersion: 1,
      counts: overviewCountsV2(items),
      health: 'normal',
    };
    expect(adminReadResponseV2.safeParse(base).success).toBe(true);
    expect(
      adminReadResponseV2.safeParse({ ...base, classes: overviewClassesV2(items) }).success,
    ).toBe(true);
  });

  it('ordena por nome da turma e deixa "Sem turma" no fim', () => {
    const rows = overviewClassRowsV1(overviewClassesV2(items), [
      { id: 1, label: '7º ANO B' },
      { id: 2, label: '7º ANO A' },
    ]);
    expect(rows.map((row) => row.label)).toEqual(['7º ANO A', '7º ANO B', 'Sem turma']);
    expect(overviewClassRowsV1([{ classId: 9, counts: overviewCountsV2([]) }], [])[0]?.label).toBe(
      'Turma 9',
    );
  });

  it('turma do cadastro sem alunos aparece com zero', () => {
    const rows = overviewClassRowsV1(overviewClassesV2([item(1)]), [
      { id: 1, label: '7º ANO A' },
      { id: 3, label: '7º ANO C' },
    ]);
    expect(rows.map((row) => [row.label, row.counts.accounts])).toEqual([
      ['7º ANO A', 1],
      ['7º ANO C', 0],
    ]);
  });
});
