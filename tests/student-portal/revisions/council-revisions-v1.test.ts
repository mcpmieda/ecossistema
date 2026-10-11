// @vitest-environment node
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRelationalCouncilV3 } from '../../../server/gradebook/application/council/relational-council-v3';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';

const ACTOR = '11111111-1111-4111-8111-111111111111';
let pg: PGlite;
let database: GradebookPostgresDatabaseV1;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  await pg.exec(readFileSync('tests/gradebook/fixtures/student-presentation-relation.sql', 'utf8'));
  await pg.exec(readFileSync('migrations/gradebook-simplified/0003_council_session_v3.sql', 'utf8'));
  await pg.exec(readFileSync('migrations/gradebook-simplified/0004_council_v3_least_privilege.sql', 'utf8'));
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno) VALUES
      (10,2026,'6A','TURMA SINTETICA',6,'M');
    INSERT INTO gradebook.professor (id,ano,nome) VALUES (1,2026,'DOCENTE SINTETICO');
    INSERT INTO gradebook.disciplina (id,ano,nome) VALUES (1,2026,'MATEMATICA');
    INSERT INTO gradebook.oferta (id,ano,turma_id,professor_id,disciplina_id) VALUES (10,2026,10,1,1);
    INSERT INTO gradebook.aluno (id,ano,nome) VALUES
      (1,2026,'ALUNO ELEGIVEL'),(2,2026,'ALUNO APROVADO'),(3,2026,'ALUNO TRANSFERIDO');
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id,situacao) VALUES
      (2026,10,1,1,NULL),(2026,10,2,2,NULL),(2026,10,3,3,4);
    INSERT INTO gradebook.instrumento (id,oferta_id,trimestre,slot,maximo,descricao)
      SELECT 100+t*10+s,10,t,s,15000,'AVALIACAO SINTETICA'
      FROM generate_series(1,3) t CROSS JOIN generate_series(1,2) s;
    INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor)
      SELECT id,1,0 FROM gradebook.instrumento;
    INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor)
      SELECT id,2,15000 FROM gradebook.instrumento;
    INSERT INTO gradebook.nota (instrumento_id,aluno_id,valor)
      SELECT id,3,15000 FROM gradebook.instrumento;
    INSERT INTO gradebook.fechamento (oferta_id,aluno_id,rec1,rec2,rec3,rec_nc_mask,u_fonte)
      VALUES (10,1,10000,10000,10000,0,30000);
  `);
  await installResetSchemaFixtureV1(pg);
  database = createGradebookPostgresDatabaseFromSqlV1({
    async unsafe() { throw new Error('outside-transaction'); },
    async begin(operation) {
      return pg.transaction(async (tx) => operation({ async unsafe(sql, values = []) {
        const result = await tx.query<Record<string, unknown>>(sql, [...values]);
        return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
      } }));
    },
    async end() { await pg.close(); },
  });
}, 30_000);
afterAll(async () => { await database?.close(); });

function request(operation: string, extra: Record<string, unknown> = {}) {
  return { contractVersion: 3, operation, year: 2026, classId: 10, ...extra };
}


async function counters() {
  return (await pg.query<{ academic: number; reset: number }>(`SELECT academic_counter::integer AS academic,
    reset_counter::integer AS reset FROM student_portal.academic_revision WHERE academic_year=2026`)).rows[0]!;
}

describe('Council producer academic classification', () => {
  it('distinguishes decisions/closure from administrative votes, justification and replay', async () => {
    const service=createRelationalCouncilV3(database,ACTOR);
    let expected=await counters();
    const execute=async(operation:string,version:number,extra:Record<string,unknown>,academic:boolean)=>{
      const command=request(operation,{expectedVersion:version,idempotencyKey:crypto.randomUUID(),justification:'Synthetic decision record',...extra});
      const result=await service.execute(command);
      expect(result).toMatchObject({state:'ready'});
      expected={academic:expected.academic+(academic?1:0),reset:expected.reset+1};
      expect(await counters()).toEqual(expected);
      expect(await service.execute(command)).toMatchObject({state:'ready'});
      expect(await counters()).toEqual(expected);
      return result;
    };
    await execute('open',0,{},false);
    await execute('decision',1,{studentId:1,decision:1},true);
    await execute('decision',2,{studentId:1,decision:1,justification:'Synthetic updated justification'},false);
    const voted=await execute('vote',3,{studentId:1,favoraveis:2,contrarios:1},false);
    if(voted.state!=='ready'||voted.operation==='classes') throw new Error('synthetic-workspace-missing');
    await execute('close',4,{reviewReference:voted.workspace.session.reviewReference},true);
    await execute('reopen',5,{},true);
    await execute('decision',6,{studentId:1,decision:2},true);
    expect((await pg.query("SELECT student_ids FROM student_portal.revision_event WHERE cause='council' AND affects_academic AND cardinality(student_ids)>0")).rows)
      .toEqual([{student_ids:[1]},{student_ids:[1]}]);
  });
});
