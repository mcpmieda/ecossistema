import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyRecoverySchemaV2,
  assertDisposableRecoveryTargetV2,
  LogicalBackupRecoveryErrorV2,
  readLogicalBackupV2,
  repositoryRootForRecoveryV2,
  restoreLogicalBackupV2,
  sanitizedRecoveryFailureV2,
  validateLogicalRecoveryV2,
  type RecoveryDatabaseV2,
} from './logical-backup-recovery-v2.ts';

function backupArgument(): string {
  const index = process.argv.indexOf('--backup');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new LogicalBackupRecoveryErrorV2('recovery-backup-argument-missing');
  return resolve(value);
}

async function run(): Promise<void> {
  try {
    const target = assertDisposableRecoveryTargetV2(process.env.GRADEBOOK_RECOVERY_DATABASE_URL ?? '');
    const input = await readLogicalBackupV2(backupArgument());
    const postgresModule = await import('postgres');
    const sql = postgresModule.default(target.connectionString, {
      max: 1,
      prepare: true,
      ssl: false,
      connect_timeout: 10,
      idle_timeout: 2,
      max_lifetime: 60,
      connection: {
        application_name: 'gradebook-disposable-recovery-v2',
        statement_timeout: 120_000,
        lock_timeout: 10_000,
        idle_in_transaction_session_timeout: 120_000,
      },
    }) as unknown as RecoveryDatabaseV2 & {end(options?: {timeout?: number}): Promise<void>};
    try {
      const startedAt = performance.now();
      await applyRecoverySchemaV2(sql, repositoryRootForRecoveryV2());
      await restoreLogicalBackupV2(sql, input.backup);
      const report = await validateLogicalRecoveryV2(sql, input.backup, input.bytes);
      process.stdout.write(`${JSON.stringify({...report, elapsedMilliseconds: Math.round(performance.now() - startedAt)})}\n`);
    } finally {
      await sql.end({timeout: 1});
    }
  } catch (cause) {
    process.stderr.write(`${sanitizedRecoveryFailureV2(cause)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await run();
}
