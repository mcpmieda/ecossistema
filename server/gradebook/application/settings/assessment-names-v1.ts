import {
  assessmentNamesRequestSchemaV1,
  assessmentNamesResponseSchemaV1,
  assessmentNamesSchemaV1,
  sameAssessmentNamesV1,
  type AssessmentNamesResponseV1,
} from '../../../../shared/gradebook-contracts/settings/assessment-names-v1';
import { type GradebookPostgresWritePortV1, type GradebookPostgresTransactionV1  } from '../../persistence/postgres/postgres-database-v1';

import { postgresJsonTextV1 } from '../../persistence/postgres/postgres-values-v1';
import {
  lockResetWriterV1,
  recordResetWriteV1,
} from '../../../student-portal/integration/year-reset/writer-v1';

type Database = GradebookPostgresWritePortV1 & {
  transaction<T>(run: (db: GradebookPostgresTransactionV1) => Promise<T>): Promise<T>;
};
const failure = (
  state: Exclude<AssessmentNamesResponseV1['state'], 'ready'>,
): AssessmentNamesResponseV1 => ({ contractVersion: 1, state });

/** Same annual lock and revision producer as the other gradebook writers. */
export function createAssessmentNamesServiceV1(database: GradebookPostgresWritePortV1) {
  return {
    async execute(input: unknown): Promise<AssessmentNamesResponseV1> {
      const parsed = assessmentNamesRequestSchemaV1.safeParse(input);
      if (!parsed.success) return failure('invalid-request');
      if (!('transaction' in database) || typeof database.transaction !== 'function')
        return failure('unavailable');
      const request = parsed.data;
      try {
        return await (database as Database).transaction(async (db) => {
          if (request.operation === 'read')
            await db.executeNative('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', []);
          else await lockResetWriterV1(db, request.year);
          const row = (await db.query<{ ano: unknown; names: unknown; version: unknown }>(
              `SELECT ano,
          COALESCE(to_jsonb(y)->'nomes_avaliacoes','{}'::jsonb) AS names,
          COALESCE((to_jsonb(y)->>'nomes_avaliacoes_versao')::bigint,0)::text AS version
          FROM gradebook.ano_letivo y WHERE ano=$1 ${request.operation === 'save' ? 'FOR UPDATE' : ''}`.trim(),
            [request.year],
          ))[0];
          if (!row) return failure('not-found');
          const names = assessmentNamesSchemaV1.parse(row.names);
          const version = Number(row.version);
          if (!Number.isSafeInteger(version) || version < 0 || row.ano !== request.year)
            throw new Error('invalid-assessment-settings');
          const ready = {
            contractVersion: 1,
            state: 'ready',
            year: request.year,
            version,
            names,
          } as const;
          // Safe replay after a lost response; a concurrent different edit is never overwritten.
          if (request.operation === 'read' || sameAssessmentNamesV1(names, request.names))
            return assessmentNamesResponseSchemaV1.parse(ready);
          if (request.expectedVersion !== version) return failure('conflict');
          if (version >= Number.MAX_SAFE_INTEGER) throw new Error('assessment-version-overflow');
          const changed = (await db.executeNative<{ version: string }>(
              `UPDATE gradebook.ano_letivo
          SET nomes_avaliacoes=$1::jsonb,nomes_avaliacoes_versao=nomes_avaliacoes_versao+1
          WHERE ano=$2 AND nomes_avaliacoes_versao=$3::bigint RETURNING nomes_avaliacoes_versao::text AS version`,
            [postgresJsonTextV1(JSON.stringify(request.names)), request.year, version],
          )).rows[0];
          if (!changed || Number(changed.version) !== version + 1)
            throw new Error('assessment-write-conflict');
          await recordResetWriteV1(db, request.year, 'academic-policy', { changed: true });
          return assessmentNamesResponseSchemaV1.parse({
            ...ready,
            names: request.names,
            version: version + 1,
          });
        });
      } catch {
        return failure('unavailable');
      }
    },
  };
}
