import {
  lockResetWriterV1,
  recordResetWriteV1,
} from '../../../student-portal/integration/year-reset/writer-v1';
import {
  RELATIONAL_BULLETIN_LIMITS_V2,
  relationalBulletinSnapshotSchemaV2,
  type RelationalBulletinHistoryItemV2,
  type RelationalBulletinSnapshotV2,
} from '../../../../shared/gradebook-contracts/bulletins/relational-bulletin-v2';
import {
  type GradebookPostgresWritePortV1,
  type GradebookPostgresReadPortV1,
  type GradebookPostgresTransactionV1,
} from './postgres-database-v1';

import { createGradebookPostgresParametersV1 } from './postgres-parameters-v1';
import { postgresJsonTextV1 } from './postgres-values-v1';

type Row = Record<string, unknown>;
type TransactionDatabaseV2 = GradebookPostgresWritePortV1 &
  GradebookPostgresReadPortV1 & {
    transaction<T>(operation: (database: GradebookPostgresTransactionV1) => Promise<T>): Promise<T>;
  };

export type RelationalBulletinSnapshotAppendV2 =
  | { readonly state: 'appended'; readonly snapshot: RelationalBulletinSnapshotV2 }
  | { readonly state: 'version-conflict' };

export interface RelationalBulletinSnapshotRepositoryV2 {
  getLatest(seriesKey: string): Promise<RelationalBulletinSnapshotV2 | null>;
  get(snapshotId: string, snapshotVersion: number): Promise<RelationalBulletinSnapshotV2 | null>;
  append(input: {
    readonly seriesKey: string;
    readonly expectedPreviousVersion: number;
    readonly issuerOid: string;
    readonly snapshot: RelationalBulletinSnapshotV2;
  }): Promise<RelationalBulletinSnapshotAppendV2>;
  history(input: {
    readonly year: number;
    readonly classId: number;
    readonly studentIds?: readonly number[];
  }): Promise<readonly RelationalBulletinHistoryItemV2[]>;
}

function asInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('relational-bulletin-snapshot-invalid-row');
  return parsed;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('relational-bulletin-snapshot-invalid-row');
  }
  return value;
}

function snapshotFromRow(row: Row): RelationalBulletinSnapshotV2 {
  const payload = requiredString(row.payload_json);
  const parsed = relationalBulletinSnapshotSchemaV2.safeParse(JSON.parse(payload));
  if (
    !parsed.success ||
    parsed.data.snapshotId !== row.snapshot_id ||
    parsed.data.snapshotVersion !== asInteger(row.versao) ||
    parsed.data.dataVersion !== row.data_version ||
    parsed.data.emittedAt !== row.emitido_em
  ) {
    throw new Error('relational-bulletin-snapshot-invalid-row');
  }
  return Object.freeze(parsed.data);
}

export function createRelationalBulletinSnapshotRepositoryV2(
  database: GradebookPostgresWritePortV1,
): RelationalBulletinSnapshotRepositoryV2 {
  const transactional = database as TransactionDatabaseV2;
  if (typeof transactional.transaction !== 'function') {
    throw new TypeError('relational-bulletin-postgres-required');
  }

  return {
    async getLatest(seriesKey) {
      const [row] = await transactional.query<Row>(
        `SELECT snapshot_id, versao, data_version, emitido_em,
                snapshot_json AS payload_json
           FROM gradebook.boletim_snapshot
          WHERE chave_serie = $1
          ORDER BY versao DESC
          LIMIT 1`,
        [seriesKey],
      );
      return row === undefined ? null : snapshotFromRow(row);
    },

    async get(snapshotId, snapshotVersion) {
      const [row] = await transactional.query<Row>(
        `SELECT snapshot_id, versao, data_version, emitido_em,
                snapshot_json AS payload_json
           FROM gradebook.boletim_snapshot
          WHERE snapshot_id = $1 AND versao = $2`,
        [snapshotId, snapshotVersion],
      );
      return row === undefined ? null : snapshotFromRow(row);
    },

    async append(input) {
      const parsed = relationalBulletinSnapshotSchemaV2.safeParse(input.snapshot);
      if (
        !parsed.success ||
        !Number.isInteger(input.expectedPreviousVersion) ||
        input.expectedPreviousVersion < 0
      ) {
        throw new Error('relational-bulletin-snapshot-invalid-input');
      }
      try {
        return await transactional.transaction(async (tx) => {
          await lockResetWriterV1(tx, input.snapshot.model.year);
          const [current] = await tx.query<Row>(
            `SELECT snapshot_id, versao
               FROM gradebook.boletim_snapshot
              WHERE chave_serie = $1
              ORDER BY versao DESC
              LIMIT 1`,
            [input.seriesKey],
          );
          const currentVersion = current === undefined ? 0 : asInteger(current.versao);
          if (
            currentVersion !== input.expectedPreviousVersion ||
            input.snapshot.snapshotVersion !== currentVersion + 1 ||
            (current !== undefined && current.snapshot_id !== input.snapshot.snapshotId)
          ) {
            return { state: 'version-conflict' } as const;
          }
          const model = input.snapshot.model;
          const inserted = await tx.executeNative(
            `INSERT INTO gradebook.boletim_snapshot (
               snapshot_id, versao, chave_serie, ano, turma_id, aluno_id,
               emitido_em, emitido_por_oid, data_version, periodo_json,
               detalhe, apresentacao_json, snapshot_json
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13::jsonb)`,
            [
              input.snapshot.snapshotId,
              input.snapshot.snapshotVersion,
              input.seriesKey,
              model.year,
              model.classGroup.id,
              model.student.id,
              input.snapshot.emittedAt,
              input.issuerOid,
              input.snapshot.dataVersion,
              postgresJsonTextV1(JSON.stringify(model.period)),
              model.detail,
              postgresJsonTextV1(JSON.stringify(input.snapshot.presentation)),
              postgresJsonTextV1(JSON.stringify(input.snapshot)),
            ],
          );
          if (inserted.changes !== 1) throw new Error('relational-bulletin-snapshot-write-failed');
          await recordResetWriteV1(tx, model.year, 'bulletin-snapshot');
          return { state: 'appended', snapshot: input.snapshot } as const;
        });
      } catch (cause) {
        if (
          cause !== null &&
          typeof cause === 'object' &&
          'code' in cause &&
          cause.code === '23505'
        ) {
          return { state: 'version-conflict' };
        }
        throw cause;
      }
    },

    async history(input) {
      const uniqueStudents = input.studentIds === undefined ? null : [...new Set(input.studentIds)];
      if (
        uniqueStudents !== null &&
        uniqueStudents.length > RELATIONAL_BULLETIN_LIMITS_V2.batchStudents
      ) {
        throw new Error('relational-bulletin-history-too-large');
      }
      if (uniqueStudents?.length === 0) return [];
      const { param, values } = createGradebookPostgresParametersV1();
      const predicates = [`b.ano = ${param(input.year)}`, `b.turma_id = ${param(input.classId)}`];
      if (uniqueStudents !== null) {
        predicates.push(`b.aluno_id IN (${uniqueStudents.map(param).join(', ')})`);
      }
      const rows = await transactional.query<Row>(
        `SELECT b.snapshot_id, b.versao, b.data_version, b.emitido_em,
                b.turma_id, t.nome AS turma_nome, b.aluno_id, a.nome AS aluno_nome,
                b.periodo_json AS payload_json, b.detalhe
           FROM gradebook.boletim_snapshot b
           JOIN gradebook.turma t ON t.id = b.turma_id AND t.ano = b.ano
           JOIN gradebook.aluno a ON a.id = b.aluno_id AND a.ano = b.ano
          WHERE ${predicates.join(' AND ')}
          ORDER BY b.emitido_em DESC, b.snapshot_id, b.versao DESC
          LIMIT ${param(RELATIONAL_BULLETIN_LIMITS_V2.historyItems)}`,
        values,
      );
      return rows.map((row) => {
        const period = JSON.parse(requiredString(row.payload_json));
        return {
          snapshotId: requiredString(row.snapshot_id),
          snapshotVersion: asInteger(row.versao),
          dataVersion: requiredString(row.data_version),
          emittedAt: requiredString(row.emitido_em),
          classId: asInteger(row.turma_id),
          className: requiredString(row.turma_nome),
          studentId: asInteger(row.aluno_id),
          studentName: requiredString(row.aluno_nome),
          period,
          detail: requiredString(row.detalhe),
        } as RelationalBulletinHistoryItemV2;
      });
    },
  };
}
