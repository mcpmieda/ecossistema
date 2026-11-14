import { installResetSchemaFixtureV1 } from '../../student-portal/year-reset/schema-fixture';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEnv } from '../../../server/env';
import { AuthenticationError } from '../../../server/auth/session';
import { AuthorizationError } from '../../../server/auth/roles';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresDatabaseV1,
  type GradebookPostgresQuerySqlV1,
  type GradebookPostgresSqlV1,
  type GradebookPostgresTransactionV1,
  type GradebookPostgresScalarV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import type { GradebookPostgresValueV1 } from '../../../server/gradebook/persistence/postgres/postgres-values-v1';
import { replaceGradebookImportDiagnosticsSnapshotV1 as replace } from '../../../server/gradebook/application/import/import-diagnostics-snapshot-v1';
import type { GradebookImportDiagnosticsAuditRequestV1 } from '../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import { onRequest } from '../../../functions/api/gradebook/import-diagnostics';

const mocks = vi.hoisted(() => ({auth:vi.fn(),authorize:vi.fn()}));
vi.mock('../../../server/env', () => ({validateEnv:(env:unknown) => env}));
vi.mock('../../../server/auth/session', () => ({
  requireAuth:mocks.auth,
  AuthenticationError:class extends Error { readonly status=401; },
}));
vi.mock('../../../server/auth/roles', () => ({
  AuthorizationError:class extends Error { readonly status=403; },
}));
vi.mock('../../../server/gradebook/authorization-v1', () => ({authorizeGradebookRuntimeV1:mocks.authorize}));
vi.mock('../../../server/gradebook/persistence/postgres/official-gradebook-database-v1', () => ({
  withOfficialGradebookDatabaseV1:async (env:RuntimeEnv, operation:(env:RuntimeEnv)=>Promise<Response|null>) => operation(env),
}));

type Row=Record<string,unknown>;
let pg:PGlite;
let database:GradebookPostgresDatabaseV1;
let failInsert=false;
let wrongInsertCount=false;
let failCoordination=false;
let transactions=0;
const queries:string[]=[];

async function execute(client:Pick<PGlite,'query'>,query:string,values:readonly unknown[],transactional:boolean) {
  queries.push(query);
  if (!transactional && (!query.startsWith('SELECT') || query.includes('pg_advisory_xact_lock'))) {
    throw new Error('snapshot-write-or-lock-outside-transaction');
  }
  if (failInsert && query.startsWith('INSERT INTO gradebook.importacao_diagnostico')) throw new Error('synthetic-insert-failure');
  if (failCoordination && query.includes('ensure_year_coordination_v1')) throw new Error('synthetic-coordination-failure');
  const result=await client.query<Row>(query,[...values]);
  const count=wrongInsertCount && query.startsWith('INSERT INTO gradebook.importacao_diagnostico') ? 0 : result.affectedRows ?? result.rows.length;
  return Object.assign(result.rows,{count});
}

beforeAll(async () => {
  pg=new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql','utf8'));
  await pg.exec('CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;');
  await pg.exec(readFileSync('migrations/gradebook-simplified/0006_import_diagnostic_treatment_v1.sql','utf8'));
  await installResetSchemaFixtureV1(pg);
  await pg.exec(`INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho)
    VALUES (2090,60000,2),(2091,60000,2)`);
  const sql:GradebookPostgresSqlV1={
    unsafe:(query,values=[]) => execute(pg,query,values,false),
    async begin(operation) {
      transactions++;
      return pg.transaction(async (transaction) => {
        const sql:GradebookPostgresQuerySqlV1={unsafe:(query,values=[])=>execute(transaction,query,values,true)};
        return operation(sql);
      });
    },
    async end() { await pg.close(); },
  };
  database=createGradebookPostgresDatabaseFromSqlV1(sql);
},30_000);
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  failInsert=false; wrongInsertCount=false; failCoordination=false; transactions=0; queries.length=0;
  await pg.exec('TRUNCATE gradebook.importacao_diagnostico_tratamento, gradebook.importacao_diagnostico;');
  mocks.auth.mockReset().mockResolvedValue({oid:'00000000-0000-4000-8000-000000000001'});
  mocks.authorize.mockReset().mockReturnValue({});
});

function observation(keys:readonly string[]=['synthetic-key'], input:{fileName?:string;hash?:string;year?:number|null}={}):GradebookImportDiagnosticsAuditRequestV1 {
  return {
    version:1,academicYear:input.year===undefined?2090:input.year,
    fileName:input.fileName??'synthetic.xlsx',sha256:(input.hash??'a').repeat(64),
    diagnostics:keys.map((key)=>({key,severity:'blocking-error',code:'invalid-text',message:'Valor inválido.',recommendedAction:'Corrija a fonte.',fieldKind:'assessment'})),
  };
}
async function state() {
  return (await pg.query<Row>('SELECT id,ano,arquivo,encode(hash,\'hex\') AS hash,chave,nivel,codigo,primeiro_em,ultimo_em,ocorrencias FROM gradebook.importacao_diagnostico ORDER BY arquivo,chave')).rows;
}
async function request(method:'GET'|'POST',body?:unknown,origin='https://school.test',query='') {
  return onRequest({
    request:new Request(`https://school.test/api/gradebook/import-diagnostics${query}`,{
      method,headers:{Origin:origin,'Content-Type':'application/json'},
      ...(method==='POST'?{body:JSON.stringify(body)}:{}),
    }),
    env:{OFFICIAL_ORIGIN:'https://school.test',GRADEBOOK_DATABASE:database},
  } as unknown as Parameters<typeof onRequest>[0]);
}

describe('atomic current diagnostic snapshot on the complete relational schema', () => {
  it('uses eleven physical calls for a changed one-year snapshot and seven for an identical one', async () => {
    expect(await replace(database,observation(['a','z','A']))).toBe(3);
    // The SQL facade counts physical unsafe calls, including locks and revisions.
    expect(queries).toHaveLength(11);
    const annualLock=queries.findIndex((query)=>query==='SELECT pg_advisory_xact_lock(613,$1::integer)');
    expect(annualLock).toBeGreaterThan(0);
    expect(queries[annualLock+1]).toContain('ensure_year_coordination_v1(y.ano)');
    expect(queries.filter((query)=>query.includes('ensure_year_coordination_v1'))).toHaveLength(1);
    expect(queries.filter((query)=>query.startsWith('SELECT DISTINCT ano'))).toHaveLength(1);
    expect(queries.filter((query)=>query.includes('AS previous_years_json'))).toHaveLength(1);
    const previous=await state();
    queries.length=0;
    expect(await replace(database,observation(['z','A','a']))).toBe(0);
    expect(queries).toHaveLength(7);
    expect(await state()).toEqual(previous);
    expect(queries.some((query)=>/^(DELETE|INSERT) /u.test(query))).toBe(false);
  });

  it('validates newly observed years before accepting equality and retries under the same lock order', async () => {
    await replace(database,observation(['same']));
    const previous=await state();
    queries.length=0;
    let attempts=0;
    const scoped={
      ...database,
      transaction<T>(operation:(transaction:GradebookPostgresTransactionV1)=>Promise<T>) {
        attempts++;
        return database.transaction((transaction)=>operation({
          query:async <Row extends Record<string,unknown>>(text:string,parameters:readonly GradebookPostgresScalarV1[])=>{
            const result=await transaction.query<Row>(text,parameters);
            return (attempts===2 && text.startsWith('SELECT DISTINCT ano')
              ? [{ano:2090},{ano:2091}] : result) as unknown as readonly Row[];
          },
          executeNative:async <Row extends Record<string,unknown>>(text:string,parameters:readonly GradebookPostgresValueV1[])=>{
            const result=await transaction.executeNative<Row>(text,parameters);
            return attempts===1 && text.includes('AS previous_years_json')
              ? {...result,rows:[{previous_years_json:'[2090,2091]',unchanged:1}] as unknown as readonly Row[]}
              : result;
          },
        }));
      },
    };
    expect(await replace(scoped,observation(['same']))).toBe(0);
    expect(attempts).toBe(2);
    expect(await state()).toEqual(previous);
    const firstContent=queries.findIndex((query)=>query.includes('hashtextextended'));
    const nextTransaction=queries.findIndex((query,index)=>index>0 && query.includes('pg_advisory_xact_lock_shared'));
    expect(queries.slice(firstContent,nextTransaction).some((query)=>query==='SELECT pg_advisory_xact_lock(613,$1::integer)')).toBe(false);
    expect(queries.some((query)=>/^(DELETE|INSERT) /u.test(query))).toBe(false);
  });

  it('propagates a persistent scope change after exactly three transactions without writing', async () => {
    let attempts=0;
    const scoped={
      ...database,
      transaction<T>(operation:(transaction:GradebookPostgresTransactionV1)=>Promise<T>) {
        attempts++;
        return database.transaction((transaction)=>operation({
          query:transaction.query.bind(transaction),
          executeNative:async <Row extends Record<string,unknown>>(text:string,parameters:readonly GradebookPostgresValueV1[])=>{
            const result=await transaction.executeNative<Row>(text,parameters);
            return text.includes('AS previous_years_json')
              ? {...result,rows:[{previous_years_json:'[2091]',unchanged:1}] as unknown as readonly Row[]}
              : result;
          },
        }));
      },
    };
    await expect(replace(scoped,observation(['same']))).rejects.toThrow('diagnostic-year-scope-changed');
    expect(attempts).toBe(3);
    expect(await state()).toEqual([]);
    expect(queries.some((query)=>/^(DELETE|INSERT) /u.test(query))).toBe(false);
  });

  it('captures the request before the first asynchronous lock and uses the original observation', async () => {
    const value=observation(['original']);
    let changed=false;
    const scoped={
      ...database,
      transaction<T>(operation:(transaction:GradebookPostgresTransactionV1)=>Promise<T>) {
        return database.transaction((transaction)=>operation({
          query:async <Row extends Record<string,unknown>>(text:string,parameters:readonly GradebookPostgresScalarV1[])=>{
            if (!changed) {
              changed=true;
              Object.assign(value,{academicYear:2091,fileName:'late-mutated.xlsx',sha256:'f'.repeat(64)});
              Object.assign(value.diagnostics[0]!,{key:'late-mutated',foundValue:'late-private-sentinel'});
            }
            return transaction.query<Row>(text,parameters);
          },
          executeNative:transaction.executeNative.bind(transaction),
        }));
      },
    };
    expect(await replace(scoped,value)).toBe(1);
    expect(await state()).toMatchObject([{ano:2090,arquivo:'synthetic.xlsx',hash:'a'.repeat(64),chave:'original'}]);
  });

  it('preserves the previous evidence and revisions if conditional coordination fails', async () => {
    await replace(database,observation(['old']));
    const previous=await state();
    const revision=(await pg.query('SELECT * FROM student_portal.academic_revision ORDER BY academic_year')).rows;
    failCoordination=true;
    await expect(replace(database,observation(['new'],{hash:'b'}))).rejects.toThrow('synthetic-coordination-failure');
    expect(await state()).toEqual(previous);
    expect((await pg.query('SELECT * FROM student_portal.academic_revision ORDER BY academic_year')).rows).toEqual(revision);
  });

  it('keeps an identical observation unchanged and revisions only years whose evidence changes', async () => {
    const revision = async (year:number) => (await pg.query<{reset_counter:number;academic_counter:number}>(
      'SELECT reset_counter::integer,academic_counter::integer FROM student_portal.academic_revision WHERE academic_year=$1',[year])).rows[0];
    await replace(database,observation(['same']));
    const before=await state();
    const version=await revision(2090);
    expect(await replace(database,observation(['same']))).toBe(0);
    expect(await state()).toEqual(before);
    expect(await revision(2090)).toEqual(version);
    await replace(database,observation(['same'],{year:2091}));
    expect(await revision(2090)).toEqual({reset_counter:version!.reset_counter+1,academic_counter:version!.academic_counter});
    expect(await revision(2091)).toMatchObject({academic_counter:1});
    expect(await state()).toMatchObject([{ano:2091}]);
  });

  it('ignores annual diagnostics for an unmaterialized year without recreating coordination', async () => {
    expect(await replace(database,observation(['stale'],{year:2092,hash:'f'}))).toBe(0);
    expect(queries).toHaveLength(4);
    expect(await state()).toEqual([]);
    expect(
      (await pg.query(`SELECT
        (SELECT count(*)::integer FROM student_portal.academic_revision WHERE academic_year=2092) AS revision,
        (SELECT count(*)::integer FROM student_portal.revision_event WHERE academic_year=2092) AS events`)).rows,
    ).toEqual([{revision:0,events:0}]);
  });

  it('locks before replacing and writes the entire set in one transaction', async () => {
    expect(await replace(database,observation(['k1','k2']))).toBe(2);
    expect(transactions).toBe(1);
    expect(queries[0]).toContain('pg_advisory_xact_lock_shared(613,0)');
    const deletion = queries.findIndex((query) => query.startsWith('DELETE FROM'));
    const insertion = queries.findIndex((query) => query.startsWith('INSERT INTO'));
    const revision = queries.findIndex((query) => query.includes('record_gradebook_change_v1'));
    expect(deletion).toBeGreaterThan(0);
    expect(insertion).toBeGreaterThan(deletion);
    expect(revision).toBeGreaterThan(insertion);
    expect((await state()).map((row)=>row.chave)).toEqual(['k1','k2']);
  });

  it('persists only blocking findings and the actionable warnings', async () => {
    const mixed: GradebookImportDiagnosticsAuditRequestV1 = {
      ...observation([]),
      diagnostics: [
        {
          key:'blocking-invalid-maximum',
          severity:'blocking-error',
          code:'invalid-maximum',
          message:'Máximo obrigatório inválido.',
          recommendedAction:'Corrija a configuração.',
          fieldKind:'configuration',
        },
        {
          key:'above-maximum',
          severity:'warning',
          code:'above-maximum',
          message:'Nota acima do máximo.',
          recommendedAction:'Confira o lançamento.',
          fieldKind:'assessment',
        },
        {
          key:'recovery-cache-missing',
          severity:'warning',
          code:'source-unavailable',
          message:'Resultado de recuperação indisponível.',
          recommendedAction:'Recalcule a planilha.',
          fieldKind:'recovery',
        },
        {
          key:'maxima-over-ceiling',
          severity:'warning',
          code:'qualitative-maxima-over-ceiling',
          message:'Máximos acima do teto qualitativo.',
          recommendedAction:'Distribua os máximos.',
          fieldKind:'configuration',
        },
        {
          key:'qualitative-star',
          severity:'warning',
          code:'invalid-maximum',
          message:'Máximo qualitativo não definido.',
          recommendedAction:'Confira a atividade.',
          fieldKind:'configuration',
          foundValue:'*',
        },
      ],
    };
    expect(await replace(database,mixed)).toBe(3);
    expect((await state()).map((row)=>({chave:row.chave,nivel:row.nivel,codigo:row.codigo}))).toEqual([
      {chave:'above-maximum',nivel:'warning',codigo:'above-maximum'},
      {chave:'blocking-invalid-maximum',nivel:'blocking-error',codigo:'invalid-maximum'},
      {chave:'maxima-over-ceiling',nivel:'warning',codigo:'qualitative-maxima-over-ceiling'},
    ]);
  });

  it('removes resolved evidence and leaves only the current source version', async () => {
    await replace(database,observation(['old1','old2']));
    expect(await replace(database,observation(['current'],{hash:'b'}))).toBe(3);
    expect(await state()).toMatchObject([{chave:'current',hash:'b'.repeat(64),ocorrencias:1}]);
  });

  it('deletes Audit treatment when the next source snapshot resolves its diagnostic', async () => {
    await pg.exec("INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho) VALUES (2026,60000,2) ON CONFLICT DO NOTHING");
    await replace(database,observation(['keep','resolved'],{year:2026}));
    const diagnostics=await pg.query<{id:number;chave:string}>(
      "SELECT id,chave FROM gradebook.importacao_diagnostico WHERE ano=2026 ORDER BY chave",
    );
    const resolved=diagnostics.rows.find((row)=>row.chave==='resolved')!;
    const keep=diagnostics.rows.find((row)=>row.chave==='keep')!;
    for (const [row,key] of [[resolved,'idem-resolved'],[keep,'idem-keep']] as const) {
      await pg.query(
        `INSERT INTO gradebook.importacao_diagnostico_tratamento
        (diagnostico_origem_id,ano,arquivo,hash,chave,nivel,codigo,campo,acao,nota,chave_idempotencia,registrado_por)
        VALUES ($1,2026,'synthetic.xlsx',decode(repeat('a',64),'hex'),$2,'blocking-error','invalid-text','assessment',1,NULL,$3,'00000000-0000-4000-8000-000000000001')`,
        [row.id,row.chave,key],
      );
    }
    await replace(database,observation(['keep'],{year:2026,hash:'b'}));
    expect(
      (await pg.query("SELECT chave FROM gradebook.importacao_diagnostico_tratamento ORDER BY chave")).rows,
    ).toEqual([{chave:'keep'}]);
  });

  it('preserves the exact previous rows if insertion fails after deletion', async () => {
    await pg.exec("INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho) VALUES (2026,60000,2) ON CONFLICT DO NOTHING");
    await replace(database,observation(['old'],{year:2026}));
    const previous=await state();
    const row=previous[0]!;
    await pg.query(`INSERT INTO gradebook.importacao_diagnostico_tratamento
      (diagnostico_origem_id,ano,arquivo,hash,chave,nivel,codigo,campo,acao,nota,chave_idempotencia,registrado_por)
      VALUES ($1,2026,'synthetic.xlsx',decode(repeat('a',64),'hex'),'old','blocking-error','invalid-text','assessment',1,NULL,'rollback-treatment','00000000-0000-4000-8000-000000000001')`,[row.id]);
    const treatments=(await pg.query('SELECT * FROM gradebook.importacao_diagnostico_tratamento')).rows;
    const revisions=(await pg.query('SELECT * FROM student_portal.academic_revision ORDER BY academic_year')).rows;
    const events=(await pg.query('SELECT * FROM student_portal.revision_event ORDER BY event_id')).rows;
    failInsert=true;
    await expect(replace(database,observation(['new'],{hash:'b',year:2026}))).rejects.toThrow('synthetic-insert-failure');
    expect(await state()).toEqual(previous);
    expect((await pg.query('SELECT * FROM gradebook.importacao_diagnostico_tratamento')).rows).toEqual(treatments);
    expect((await pg.query('SELECT * FROM student_portal.academic_revision ORDER BY academic_year')).rows).toEqual(revisions);
    expect((await pg.query('SELECT * FROM student_portal.revision_event ORDER BY event_id')).rows).toEqual(events);
  });

  it('rolls back an incomplete write confirmation instead of reporting a partial snapshot', async () => {
    await replace(database,observation(['old']));
    const previous=await state();
    wrongInsertCount=true;
    await expect(replace(database,observation(['new'],{hash:'b'}))).rejects.toThrow('import-diagnostics-incomplete-snapshot');
    expect(await state()).toEqual(previous);
  });

  it('clears an empty observation even if the source hash is unchanged', async () => {
    await replace(database,observation(['old']));
    queries.length=0;
    expect(await replace(database,observation([]))).toBe(1);
    expect(await state()).toEqual([]);
    expect(queries.some((query)=>query.startsWith('INSERT'))).toBe(false);
  });

  it('does not clear another file or year', async () => {
    await replace(database,observation(['other-file'],{fileName:'other-synthetic.xlsx',hash:'b'}));
    await replace(database,observation(['other-year'],{year:2091,hash:'c'}));
    await replace(database,observation(['mine']));
    await replace(database,observation([]));
    expect((await state()).map((row)=>row.chave).sort()).toEqual(['other-file','other-year']);
  });

  it('treats renamed identical bytes as one current content, with the current filename', async () => {
    await replace(database,observation(['key']));
    await replace(database,observation(['key'],{fileName:'renamed-synthetic.xlsx'}));
    expect(await state()).toMatchObject([{arquivo:'renamed-synthetic.xlsx',chave:'key'}]);
    expect(await state()).toHaveLength(1);
  });

  it('handles unknown years without accumulating unresolved versions', async () => {
    await replace(database,observation(['old'],{year:null}));
    await replace(database,observation(['new'],{year:null,hash:'b'}));
    expect(await state()).toMatchObject([{ano:null,chave:'new'}]);
    expect(await state()).toHaveLength(1);
    const previous=await state();
    queries.length=0;
    expect(await replace(database,observation(['new'],{year:null,hash:'b'}))).toBe(0);
    expect(queries).toHaveLength(5);
    expect(await state()).toEqual(previous);
    expect(queries.some((query)=>query.includes('ensure_year_coordination_v1'))).toBe(false);
  });

  it('rejects duplicate keys and missing transaction support before writing', async () => {
    await expect(replace(database,observation(['duplicate','duplicate']))).rejects.toThrow('invalid-import-diagnostics-snapshot');
    await expect(replace({query:database.query,executeNative:database.executeNative},observation())).rejects.toThrow('import-diagnostics-transaction-unavailable');
    expect(queries).toHaveLength(0);
    expect(transactions).toBe(0);
  });

  it('supports the existing 5,000-item bound without per-item SQL', async () => {
    const value=observation(Array.from({length:5000},(_,index)=>`key-${index}`));
    expect(await replace(database,value)).toBe(5000);
    expect(queries.length).toBeLessThanOrEqual(13);
    expect(queries.filter((query)=>/^(DELETE|INSERT) /u.test(query))).toHaveLength(3);
    expect(await state()).toHaveLength(5000);
    const counts=(await pg.query('SELECT (SELECT count(*)::integer FROM gradebook.nota) AS notas,(SELECT count(*)::integer FROM gradebook.importacao) AS imports')).rows;
    expect(counts).toEqual([{notas:0,imports:0}]);
  });

  it('concurrent invocations leave a complete committed set, never a mixture', async () => {
    // PGlite serializes connections: this proves transaction boundaries and final sets,
    // not multi-session PostgreSQL advisory-lock contention (a private pilot gate).
    await Promise.all([
      replace(database,observation(['a1','a2'])),
      replace(database,observation(['b1','b2','b3'],{hash:'b'})),
    ]);
    const keys=(await state()).map((row)=>row.chave);
    expect([['a1','a2'],['b1','b2','b3']]).toContainEqual(keys);
    expect(transactions).toBe(2);
  });
});

describe('diagnostic HTTP integration with synthetic identity and real SQL transaction', () => {
  it('POST records and an empty POST removes the snapshot, with no-store', async () => {
    const first=await request('POST',observation());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({version:1,state:'recorded',affected:1});
    expect(first.headers.get('Cache-Control')).toContain('no-store');
    const empty=await request('POST',observation([]));
    expect(await empty.json()).toEqual({version:1,state:'recorded',affected:1});
    expect(await state()).toEqual([]);
  });

  it.each(['?ano=2090&limit=1', '?limit=1'])('GET reads current evidence through the native port with bounded pagination: %s', async (query) => {
    await replace(database,observation(['k1','k2']));
    const previous=await state();
    queries.length=0;
    expect('prepare' in database).toBe(false);
    const nativeQuery = vi.spyOn(database, 'query');
    let result: Response;
    try {
      result=await request('GET',undefined,'https://school.test',query);
      expect(nativeQuery).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(query.includes('ano=') ? 'WHERE d.ano = $1' : 'LIMIT $1 OFFSET $2'), query.includes('ano=') ? [2090,2,0] : [2,0]);
    } finally {
      nativeQuery.mockRestore();
    }
    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toContain('no-store');
    expect(await result.json()).toMatchObject({version:1,state:'ready',nextOffset:1,items:[{academicYear:2090,fileName:'synthetic.xlsx',code:'invalid-text',studentName:null}]});
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^SELECT/u);
    expect(await state()).toEqual(previous);
  });

  it('rejects unauthenticated requests before any SQL', async () => {
    mocks.auth.mockRejectedValueOnce(new AuthenticationError());
    const result=await request('POST',observation());
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({version:1,state:'not-authorized'});
    expect(queries).toHaveLength(0);
  });

  it('rejects missing capability before any SQL', async () => {
    mocks.authorize.mockImplementationOnce(()=>{throw new AuthorizationError();});
    const result=await request('POST',observation());
    expect(result.status).toBe(403);
    expect(queries).toHaveLength(0);
  });

  it('rejects a cross-origin write before any SQL', async () => {
    expect((await request('POST',observation(),'https://untrusted.test')).status).toBe(403);
    expect(queries).toHaveLength(0);
  });

  it('maps duplicate input to invalid-request and preserves the old set', async () => {
    await replace(database,observation(['old']));
    const previous=await state();
    const result=await request('POST',observation(['same','same']));
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({version:1,state:'invalid-request'});
    expect(await state()).toEqual(previous);
  });

  it('reports insertion failure without exposing SQL or erasing earlier evidence', async () => {
    await replace(database,observation(['old']));
    const previous=await state();
    failInsert=true;
    const log=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    try {
      const result=await request('POST',observation(['new'],{hash:'b'}));
      expect(result.status).toBe(500);
      expect(await result.json()).toEqual({version:1,state:'unavailable'});
      expect(await state()).toEqual(previous);
      expect(log).toHaveBeenCalledWith(JSON.stringify({message:'gradebook_import_diagnostics_failed'}));
    } finally { log.mockRestore(); }
  });
});
