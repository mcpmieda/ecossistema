// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  LOGICAL_BACKUP_SEQUENCE_NAMES_V2,
  LOGICAL_BACKUP_TABLE_ORDER_V2,
  RECOVERY_SCHEMA_PLAN_V2,
  LogicalBackupRecoveryErrorV2,
  assertDisposableRecoveryTargetV2,
  parseLogicalBackupCsvV2,
  sanitizedRecoveryFailureV2,
} from '../../../server/gradebook/recovery/logical-backup-recovery-v2';

function backup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'gradebook-logical-backup-v2',
    source: 'synthetic-test',
    captured_at: '2026-09-11T03:51:24.000Z',
    source_head: '40722110b2d30782666a158e772409ad347089c8',
    catalog: {
      index_count: 58,
      table_count: 28,
      column_count: 214,
      constraint_count: 188,
      foreign_key_count: 48,
    },
    tables: Object.fromEntries(LOGICAL_BACKUP_TABLE_ORDER_V2.map((table) => [table, []])),
    sequences: LOGICAL_BACKUP_SEQUENCE_NAMES_V2.map((sequencename) => ({
      schemaname: 'gradebook',
      sequencename,
      last_value: null,
      start_value: 1,
      increment_by: 1,
    })),
    ...overrides,
  };
}

function csv(value: Record<string, unknown>): string {
  return `gradebook_backup\n"${JSON.stringify(value).replace(/"/gu, '""')}"\n`;
}

describe('logical backup recovery v2 safeguards', () => {
  it('parses only the exact V2 envelope, table set, catalog and sequence set', () => {
    const parsed = parseLogicalBackupCsvV2(csv(backup()));
    expect(parsed.format).toBe('gradebook-logical-backup-v2');
    expect(Object.keys(parsed.tables).sort()).toEqual([...LOGICAL_BACKUP_TABLE_ORDER_V2].sort());
    expect(parsed.sequences.map((item) => item.sequencename).sort()).toEqual(
      [...LOGICAL_BACKUP_SEQUENCE_NAMES_V2].sort(),
    );
  });

  it.each([
    ['legacy header', 'other\n"{}"', 'recovery-backup-header-invalid'],
    [
      'wrong format',
      csv(backup({ format: 'gradebook-logical-backup-v1' })),
      'recovery-backup-envelope-invalid',
    ],
    [
      'wrong catalog',
      csv(
        backup({
          catalog: {
            index_count: 57,
            table_count: 28,
            column_count: 214,
            constraint_count: 188,
            foreign_key_count: 48,
          },
        }),
      ),
      'recovery-backup-catalog-invalid',
    ],
    ['missing table', csv(backup({ tables: {} })), 'recovery-backup-tables-invalid'],
    ['missing sequence', csv(backup({ sequences: [] })), 'recovery-backup-sequences-invalid'],
  ])('rejects %s without attempting a restore', (_label, input, code) => {
    expect(() => parseLogicalBackupCsvV2(input)).toThrowError(
      new LogicalBackupRecoveryErrorV2(code),
    );
  });

  it.each([
    ['postgres://owner@db.example/gradebook_recovery_662', 'recovery-target-not-loopback'],
    ['postgres://owner@127.0.0.1/production', 'recovery-target-name-invalid'],
    ['https://127.0.0.1/gradebook_recovery_662', 'recovery-target-protocol-invalid'],
    ['', 'recovery-target-url-invalid'],
  ])('refuses unsafe target %s', (target, code) => {
    expect(() => assertDisposableRecoveryTargetV2(target)).toThrowError(
      new LogicalBackupRecoveryErrorV2(code),
    );
  });

  it('accepts only an explicitly named disposable loopback database', () => {
    expect(
      assertDisposableRecoveryTargetV2('postgres://owner@127.0.0.1:55432/gradebook_recovery_662'),
    ).toMatchObject({
      host: '127.0.0.1',
      databaseName: 'gradebook_recovery_662',
    });
  });

  it('never replays the historical 0002 relation already folded into the baseline', () => {
    expect(RECOVERY_SCHEMA_PLAN_V2).toEqual([
      '0001_current_schema.sql',
      'application_role_grants.sql',
      '0003_council_session_v3.sql',
      '0004_council_v3_least_privilege.sql',
      '0005_relational_bulletin_snapshot_v2.sql',
    ]);
    expect(RECOVERY_SCHEMA_PLAN_V2).not.toContain('0002_import_diagnostics_audit_v1.sql');
  });

  it('orders parent relations before dependents and handles the Council closure cycle separately', () => {
    const position = (table: (typeof LOGICAL_BACKUP_TABLE_ORDER_V2)[number]) =>
      LOGICAL_BACKUP_TABLE_ORDER_V2.indexOf(table);
    expect(position('ano_letivo')).toBeLessThan(position('aluno'));
    expect(position('turma')).toBeLessThan(position('oferta'));
    expect(position('oferta')).toBeLessThan(position('instrumento'));
    expect(position('instrumento')).toBeLessThan(position('nota'));
    expect(position('conselho_sessao')).toBeLessThan(position('conselho_fechamento'));
    expect(position('conselho_fechamento')).toBeLessThan(position('conselho_fechamento_item'));
  });

  it('returns only a stable code for unexpected failures', () => {
    expect(sanitizedRecoveryFailureV2(new Error('postgres://secret@host/student-name'))).toBe(
      'unexpected-recovery-failure',
    );
    expect(sanitizedRecoveryFailureV2(new LogicalBackupRecoveryErrorV2('safe-code'))).toBe(
      'safe-code',
    );
  });
});
