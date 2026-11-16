// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createGradebookPostgresDatabaseFromSqlV1, type GradebookPostgresDatabaseV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createRelationalWorkspaceV2 } from '../../../server/gradebook/application/operational-workspace/relational-workspace-v2';

let pg: PGlite;
let db: GradebookPostgresDatabaseV1;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
    INSERT INTO gradebook.aluno (id,ano,nome,conselho_anterior,conselho_anterior_por) VALUES
      (1,2026,'SINTETICO SIM',true,'11111111-1111-4111-8111-111111111111'),
      (2,2026,'SINTETICO NAO',false,'11111111-1111-4111-8111-111111111111'),
      (3,2026,'SINTETICO DESCONHECIDO',null,null);
  `);
  db = createGradebookPostgresDatabaseFromSqlV1({
    async unsafe() { throw new Error('read-outside-transaction'); },
    async begin(operation) {
      return pg.transaction(async (tx) => operation({ async unsafe(sql, values = []) {
        const result = await tx.query<Record<string, unknown>>(sql, [...values]);
        return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
      } }));
    },
    async end() { await pg.close(); },
  });
}, 30_000);
afterAll(async () => { await db?.close(); });

it.each([1, 2, 3] as const)(
  'does not expose or consult the historical Council flag for current-year student %i', async (id) => {
    const response = await createRelationalWorkspaceV2(db).execute({ contractVersion: 2, operation: 'center', year: 2026, kind: 'student', id, offset: 0, limit: 100 });
    expect(response).toMatchObject({ state: 'ready', center: { entity: { id } } });
    expect(JSON.stringify(response)).not.toMatch(/councilPrevious|conselhoAnterior|ano anterior/ui);
  },
);
