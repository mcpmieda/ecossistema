// @vitest-environment node
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGradebookPostgresDatabaseFromSqlV1, type GradebookPostgresDatabaseV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { createRelationalPerformanceV2 } from '../../../server/gradebook/application/read-models/performance/relational-performance-v2';

let pg: PGlite;
let db: GradebookPostgresDatabaseV1;
const queries: string[] = [];
const request = { transportVersion: 2, operation: 'matrix', year: 2026, classId: 1, period: 1, mode: 'regular', statuses: [null, 7] };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec(readFileSync('tests/gradebook/fixtures/student-presentation-relation.sql', 'utf8'));
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES (1,2026,'A','TURMA SINTETICA',6,'M');
    INSERT INTO gradebook.professor (id,ano,nome) VALUES (1,2026,'DOCENTE SINTETICO');
    INSERT INTO gradebook.disciplina (id,ano,nome) SELECT n,2026,'COMPONENTE SINTETICO '||n FROM generate_series(1,10) n;
    INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id) SELECT n,2026,1,1,n FROM generate_series(1,10) n;
    INSERT INTO gradebook.aluno (id,ano,nome) SELECT n,2026,'ALUNO SINTETICO '||n FROM generate_series(1,100) n;
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) SELECT 2026,1,n,n FROM generate_series(1,100) n;
    INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo)
      SELECT o*100+t*20+s,o,t,s,CASE WHEN s=11 THEN CASE WHEN t=3 THEN 22000 ELSE 16500 END ELSE CASE WHEN t=3 THEN 9000 ELSE 6750 END END
      FROM generate_series(1,10) a(o) CROSS JOIN generate_series(1,3) b(t) CROSS JOIN (VALUES (1),(2),(11)) c(s);
    INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor)
      SELECT i.id,a.id,CASE WHEN i.slot=11 THEN 12000 ELSE 6000 END FROM gradebook.instrumento i CROSS JOIN gradebook.aluno a;
  `);
  db = createGradebookPostgresDatabaseFromSqlV1({
    async unsafe() { throw new Error('read-outside-transaction'); },
    async begin(operation) {
      return pg.transaction(async (tx) => operation({ async unsafe(sql, values = []) {
        queries.push(sql);
        const result = await tx.query<Record<string, unknown>>(sql, [...values]);
        return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
      } }));
    },
    async end() { await pg.close(); },
  });
}, 30_000);
beforeEach(() => { queries.length = 0; });
afterAll(async () => { await db?.close(); });

describe('bounded complete performance matrix, with synthetic data only', () => {
  it.each([1, 2, 3, 'annual'])('reads exactly 1,000 pairs in six statements for period %s', async (period) => {
    const result = await createRelationalPerformanceV2(db).execute({ ...request, period });
    expect(result.state).toBe('ready');
    if (result.state !== 'ready' || result.operation !== 'matrix') throw new Error('matrix-not-ready');
    expect(result.rows).toHaveLength(100);
    expect(result.offers).toHaveLength(10);
    expect(result.rows.every((row) => row.cells.length === 10)).toBe(true);
    expect(result.statistics.completeCells).toBe(1000);
    expect(queries).toHaveLength(6);
    expect(queries.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b|academic_entity|academic_record/u);
    expect(gzipSync(JSON.stringify(result)).length).toBeLessThan(500_000);
  });
  it('rejects 1,010 pairs before the fact query instead of returning a partial class', async () => {
    await pg.exec("INSERT INTO gradebook.aluno (id,ano,nome) VALUES (101,2026,'LIMITE SINTETICO'); INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES (2026,1,101,101)");
    try {
      expect(await createRelationalPerformanceV2(db).execute(request)).toEqual({ transportVersion: 2, state: 'scope-too-large' });
      expect(queries).toHaveLength(5);
      expect(queries.some((sql) => sql.includes('LEFT JOIN gradebook.nota'))).toBe(false);
    } finally {
      await pg.exec('DELETE FROM gradebook.vinculo WHERE aluno_id=101; DELETE FROM gradebook.aluno WHERE id=101');
    }
  });
});
