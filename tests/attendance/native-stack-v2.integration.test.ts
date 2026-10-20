// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { applyCurrentGradebookSchemaV1 } from '../../server/gradebook/recovery/current-gradebook-schema-v1';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresSqlV1,
  type GradebookPostgresQuerySqlV1,
} from '../../server/gradebook/persistence/postgres/postgres-database-v1';
import {
  createFrequencyServiceV2,
  summarizeFrequencyPublicOriginsV2,
} from '../../server/attendance/service-v2';
import { createYearResetServiceV1 } from '../../server/gradebook/application/settings/year-reset-v1';
import { resolveReconciledSourceV1 } from '../../server/student-identity/reconciliation/resolve-source-v1';
import type {
  FrequencyActorV2,
  FrequencyCollectionV2,
  FrequencySummaryV2,
} from '../../shared/attendance-contracts/frequency-v2';

const connection = process.env.ATTENDANCE_TEST_POSTGRES_URL ?? '';
const native = connection ? describe : describe.skip;
const actorId = '20000000-0000-4000-8000-000000000001',
  tenant = '90000000-0000-4000-8000-000000000001',
  uid = '10000000-0000-4000-8000-000000000001';
const device = '30000000-0000-4000-8000-000000000001',
  thumb = 'a'.repeat(43),
  account = '70000000-0000-4000-8000-000000000001',
  session = '80000000-0000-4000-8000-000000000001';
const admin: FrequencyActorV2 = { mode: 'admin', actorId, tenantId: tenant };
const deviceActor: FrequencyActorV2 = {
  ...admin,
  mode: 'device',
  deviceId: device,
  deviceGeneration: 1,
  keyThumbprint: thumb,
};
let owner: ReturnType<typeof postgres>;
let database: ReturnType<typeof createGradebookPostgresDatabaseFromSqlV1>;
let service: ReturnType<typeof createFrequencyServiceV2>;
let holdAfterEvidence = false;
const exec = (sql: string) => owner.unsafe(sql, [], { prepare: false });
const request = (operation: string, fields: Record<string, unknown> = {}) => ({
  operation,
  academicYear: 2026,
  requestId: crypto.randomUUID(),
  ...fields,
});
function collection(token: number): FrequencyCollectionV2 {
  return {
    operation: 'collect',
    academicYear: 2026,
    requestId: crypto.randomUUID(),
    fencingToken: token,
    expectedRevision: 0,
    classId: 101,
    sourceClassId: '123',
    sourceClassLabel: '6A',
    sourceVersion: `sha256:${'a'.repeat(64)}`,
    observedAt: '2026-01-10T12:00:00Z',
    rosterComplete: true,
    records: [{ recordKey: 'synth-record', originalName: 'SYNTHETIC PERSON', originalClass: '6A' }],
    coverage: [{ recordKey: 'synth-record', date: '2026-01-05', slots: [1], complete: true }],
    marks: [{ recordKey: 'synth-record', date: '2026-01-05', slot: 1, mark: 'X' }],
  };
}
async function asRole<T>(
  role: 'gradebook_app' | 'student_portal_app' | 'anon' | 'authenticated' | 'collector_runtime',
  operation: (tx: GradebookPostgresQuerySqlV1) => PromiseLike<T>,
): Promise<T> {
  return owner.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    return operation(tx as unknown as GradebookPostgresQuerySqlV1);
  }) as Promise<T>;
}
native('frequency V2 complete native migration stack', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname !== '127.0.0.1' ||
      !/^\/attendance_ephemeral_[a-f0-9]{32}$/u.test(url.pathname) ||
      url.username !== 'attendance_ephemeral' ||
      url.password ||
      !url.port ||
      url.search ||
      url.hash ||
      !process.env.ATTENDANCE_TEST_POSTGRES_MARKER ||
      !process.env.ATTENDANCE_TEST_POSTGRES_DATA_DIRECTORY
    )
      throw new Error('frequency-native-target-not-disposable');
    owner = postgres(connection, { max: 1, prepare: false, onnotice: () => undefined });
    const [marker] = await exec('SELECT marker::text FROM public.attendance_test_sandbox_v1');
    const [directory] = await exec('SHOW data_directory');
    if (
      marker?.marker !== process.env.ATTENDANCE_TEST_POSTGRES_MARKER ||
      String(directory?.data_directory).replaceAll('\\', '/').toLowerCase() !==
        process.env.ATTENDANCE_TEST_POSTGRES_DATA_DIRECTORY.replaceAll('\\', '/').toLowerCase()
    )
      throw new Error('frequency-native-sandbox-proof-invalid');
    await exec(`CREATE ROLE frequency_migrator_v2 NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT CREATE ON DATABASE ${url.pathname.slice(1)} TO frequency_migrator_v2;
      GRANT frequency_migrator_v2 TO CURRENT_USER; SET ROLE frequency_migrator_v2;`);
    expect(
      (
        await exec(
          `SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user`,
        )
      )[0],
    ).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: true });
    await applyCurrentGradebookSchemaV1(
      { unsafe: (sql, args = []) => owner.unsafe(sql, [...args] as never[], { prepare: false }) },
      process.cwd(),
    );
    for (const file of readdirSync('migrations/student-portal')
      .filter((f) => /^\d{4}_.*\.sql$/u.test(f) && Number(f.slice(0, 4)) <= 24)
      .sort()) {
      if (file.startsWith('0019_'))
        await exec('UPDATE student_portal.publication_control_v2 SET enabled=true');
      await exec(readFileSync(`migrations/student-portal/${file}`, 'utf8'));
    }
    for (const path of [
      'migrations/gradebook-simplified/0015_student_reconciliation_v1.sql',
      'migrations/student-portal/0025_reconciliation_credentials_v1.sql',
      'migrations/student-portal/0026_publication_source_retention_v1.sql',
      'migrations/gradebook-simplified/0016_reconciliation_year_reset_v1.sql',
      ...readdirSync('migrations/collector')
        .filter((f) => /^\d{4}_.*\.sql$/u.test(f) && !['0007_scheduled_retention_v2.sql','0008_cron_history_retention_v2.sql','0010_daily_evidence_pruning_v2.sql'].includes(f))
        .sort()
        .map((f) => `migrations/collector/${f}`),
      ...readdirSync('migrations/attendance')
        .filter((f) => /^\d{4}_.*\.sql$/u.test(f))
        .sort()
        .map((f) => `migrations/attendance/${f}`),
    ])
      await exec(readFileSync(path, 'utf8'));
    const sql: GradebookPostgresSqlV1 = {
      unsafe: () => {
        throw new Error('frequency-native-query-outside-tx');
      },
      begin: <T>(operation: (tx: GradebookPostgresQuerySqlV1) => Promise<T>) =>
        asRole('gradebook_app', (tx) =>
          operation({
            async unsafe(query, params = []) {
              const r = await tx.unsafe(query, params);
              if (holdAfterEvidence && query.includes('INSERT INTO attendance.source_row_v2')) {
                holdAfterEvidence = false;
                await tx.unsafe('SELECT pg_sleep(0.35)');
              }
              return r;
            },
          }),
        ),
    };
    database = createGradebookPostgresDatabaseFromSqlV1(sql);
    service = createFrequencyServiceV2(database);
    await exec(`INSERT INTO gradebook.ano_letivo VALUES(2026,60000,3);
 INSERT INTO gradebook.student_identity(id) VALUES('${uid}');
 INSERT INTO gradebook.aluno(id,ano,nome,student_uid) VALUES(1,2026,'SYNTHETIC PERSON','${uid}');
 INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno) VALUES(101,2026,'6A','SYNTHETIC CLASS',6,'MATUTINO');
 INSERT INTO gradebook.vinculo(ano,turma_id,aluno_id,numero) VALUES(2026,101,1,1);
 INSERT INTO gradebook.student_reconciliation_scope_v1(academic_year,revision) VALUES(2026,1);
 INSERT INTO gradebook.student_report_batch_v1(id,academic_year,generation,actor_id,source_evidence,normalization_version,digest,request_digest,idempotency_key,base_revision,base_academic_revision,state,expires_at,class_links)
 SELECT '41000000-0000-4000-8000-000000000001',2026,generation,'${actorId}','unknown',1,repeat('a',64),repeat('b',64),gen_random_uuid(),0,'synthetic','applied',clock_timestamp()+interval '1 day','[]'::jsonb FROM gradebook.student_reconciliation_scope_v1;
 INSERT INTO gradebook.student_report_class_v1(id,academic_year,label,class_key,shift,shift_key,stage_label,stage,gradebook_class_id) VALUES('40000000-0000-4000-8000-000000000001',2026,'6A','6A','MATUTINO','MATUTINO','6',6,101);
 INSERT INTO gradebook.student_source_record_v1(id,academic_year,last_batch_id) VALUES('50000000-0000-4000-8000-000000000001',2026,'41000000-0000-4000-8000-000000000001');
 INSERT INTO gradebook.student_source_observation_v1(id,academic_year,source_id,version,batch_id,report_class_id,name,name_key,birth_date,enrollment_hash,shift,shift_key,status,status_key,enrolled_at)
 VALUES('60000000-0000-4000-8000-000000000001',2026,'50000000-0000-4000-8000-000000000001',1,'41000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','SYNTHETIC PERSON','SYNTHETIC PERSON','2014-01-01','synthetic','MATUTINO','MATUTINO','CURSANDO','CURSANDO','2026-01-01');
 INSERT INTO gradebook.student_reconciliation_decision_v1(id,academic_year,generation,sequence,actor_id,action,reason,source_id,student_uid,observation_id)
 SELECT '42000000-0000-4000-8000-000000000001',2026,generation,1,'${actorId}','associate','Synthetic fixture','50000000-0000-4000-8000-000000000001','${uid}','60000000-0000-4000-8000-000000000001' FROM gradebook.student_reconciliation_scope_v1;
 INSERT INTO gradebook.student_source_link_v1(academic_year,source_id,student_uid,version,decision_id) VALUES(2026,'50000000-0000-4000-8000-000000000001','${uid}',1,'42000000-0000-4000-8000-000000000001');
 INSERT INTO collector_auth.oauth_grants(id,tenant_id,actor_id,client_id,generation,credential_version,origin_authenticated_at,encrypted_refresh,state,directory_authorized,directory_checked_at,directory_valid_until)
 VALUES('31000000-0000-4000-8000-000000000001','${tenant}','${actorId}','32000000-0000-4000-8000-000000000001',1,0,clock_timestamp(),repeat('synthetic',5),'active',true,statement_timestamp(),statement_timestamp()+interval '5 minutes');
 INSERT INTO collector_auth.devices(id,grant_id,tenant_id,actor_id,public_key,key_thumbprint,generation,created_at)
 VALUES('${device}','31000000-0000-4000-8000-000000000001','${tenant}','${actorId}','{"kty":"EC","crv":"P-256","x":"synthetic","y":"synthetic"}','${thumb}',1,clock_timestamp());`);
    await exec('RESET ROLE; REVOKE frequency_migrator_v2 FROM CURRENT_USER;');
  }, 120000);
  afterAll(async () => {
    await owner?.end({ timeout: 2 });
  });
  it('executes the exact private bridges, Portal ownership and canonical reset without elevated runtime table grants', async () => {
    const lease = (await service.execute(
      request('lease', { durationSeconds: 300 }),
      deviceActor,
    )) as Record<string, unknown>;
    const input = collection(Number(lease.fencingToken));
    expect(await service.execute(input, deviceActor)).toMatchObject({
      state: 'committed',
      resolvedRecords: 1,
    });
    expect((await service.summary(2026, uid, '2026-01', async () => true)).marks).toHaveLength(1);
    const evidence = {
      academicYear: 2026 as const,
      sourceSnapshotRef: 'synthetic',
      sourceRecordRef: 'synth-record',
      name: 'SYNTHETIC PERSON',
      classLabel: '6A',
    };
    expect(
      await database.transaction((tx) => resolveReconciledSourceV1(tx, evidence)),
    ).toMatchObject({ state: 'resolved', studentUid: uid });
    expect(
      await database.transaction((tx) =>
        resolveReconciledSourceV1(tx, { ...evidence, academicYear: 2025 as 2026 }),
      ),
    ).toEqual({ state: 'not_found', decisionVersion: 0 });
    const [acl] =
      await exec(`SELECT has_table_privilege('gradebook_app','collector_auth.oauth_grants','SELECT') AS auth_table,
 has_table_privilege('student_portal_app','attendance.occurrence_v2','SELECT') AS portal_table,
 has_function_privilege('anon','attendance.read_portal_origins_v2(uuid,uuid,text)','EXECUTE') AS public_rpc,
 has_function_privilege('collector_runtime','collector_auth.lock_active_device_v2(uuid,uuid,uuid,bigint,text)','EXECUTE') AS collector_lock`);
    expect(acl).toEqual({
      auth_table: false,
      portal_table: false,
      public_rpc: false,
      collector_lock: false,
    });
    const owners = await exec(
      `SELECT rolname,rolsuper,rolbypassrls,rolinherit,rolcanlogin FROM pg_roles WHERE rolname IN('frequency_bridge_v2','frequency_portal_bridge_v2') ORDER BY rolname`,
    );
    expect(owners).toHaveLength(2);
    for (const role of owners)
      expect(role).toMatchObject({
        rolsuper: false,
        rolbypassrls: false,
        rolinherit: false,
        rolcanlogin: false,
      });
    const [authority] = await exec(`SELECT
      EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles member_role ON member_role.oid=m.member
        WHERE r.rolname IN('frequency_bridge_v2','frequency_portal_bridge_v2')
        AND (m.set_option OR m.inherit_option OR member_role.rolname IN('gradebook_app','student_portal_app','collector_runtime','anon','authenticated'))) AS owner_membership,
      has_schema_privilege('frequency_bridge_v2','attendance','CREATE') OR has_schema_privilege('frequency_bridge_v2','collector_auth','CREATE') OR has_schema_privilege('frequency_portal_bridge_v2','attendance','CREATE') AS owner_create`);
    expect(authority).toEqual({ owner_membership: false, owner_create: false });
    await exec(`SET ROLE frequency_migrator_v2;
 INSERT INTO student_portal.account(id,academic_year,gradebook_student_id,auth_state,eligibility,student_uid) VALUES('${account}',2026,1,'active','eligible','${uid}');
 INSERT INTO student_portal.session(id,account_id,token_hash,security_version,expires_at,persistent) VALUES('${session}','${account}','synthetic-hash',0,clock_timestamp()+interval '10 minutes',false); RESET ROLE;`);
    const portalRead = () =>
      asRole('student_portal_app', (tx) =>
        tx.unsafe(
          `SELECT attendance.read_portal_origins_v2($1::uuid,$2::uuid,$3::text) AS origins`,
          [account, session, '2026-01'],
        ),
      );
    const [read] = await portalRead();
    expect(
      summarizeFrequencyPublicOriginsV2(read!.origins as Record<string, unknown>[], '2026-01')
        .marks,
    ).toHaveLength(1);
    const [wrong] = await asRole('student_portal_app', (tx) =>
      tx.unsafe(`SELECT attendance.read_portal_origins_v2($1::uuid,$2::uuid,$3::text) AS origins`, [
        crypto.randomUUID(),
        session,
        '2026-01',
      ]),
    );
    expect(wrong!.origins).toBeNull();
    await exec(
      `UPDATE student_portal.session SET revoked_at=clock_timestamp() WHERE id='${session}'`,
    );
    expect((await portalRead())[0]!.origins).toBeNull();
    for (const role of [
      'anon',
      'authenticated',
      'student_portal_app',
      'collector_runtime',
    ] as const)
      await expect(
        asRole(role, (tx) => tx.unsafe('SELECT * FROM attendance.occurrence_v2')),
      ).rejects.toMatchObject({ code: '42501' });
    await exec(
      `WITH t AS(SELECT clock_timestamp() AS ts) UPDATE collector_auth.oauth_grants SET directory_checked_at=t.ts-interval '4 minutes 59.75 seconds',directory_valid_until=t.ts+interval '0.25 seconds' FROM t`,
    );
    holdAfterEvidence = true;
    await expect(
      service.execute(
        {
          ...input,
          requestId: crypto.randomUUID(),
          expectedRevision: 1,
          sourceVersion: `sha256:${'b'.repeat(64)}`,
          marks: [{ recordKey: 'synth-record', date: '2026-01-05', slot: 1, mark: 'J' }],
        },
        deviceActor,
      ),
    ).rejects.toMatchObject({ code: 'not-authorized' });
    expect(holdAfterEvidence).toBe(false);
    expect((await exec('SELECT count(*)::integer AS n FROM attendance.batch_v2'))[0]!.n).toBe(1);
    await service.execute(request('revoke-device', { deviceId: device }), admin);
    await expect(service.execute(input, deviceActor)).rejects.toMatchObject({
      code: 'not-authorized',
    });
    await exec(
      `UPDATE student_portal.account SET gradebook_student_id=NULL,eligibility='unlinked',closed_at=clock_timestamp() WHERE id='${account}'`,
    );
    const reset = createYearResetServiceV1(database, actorId);
    let preview = await reset.execute({ contractVersion: 1, operation: 'preview', year: 2026 });
    if (preview.state !== 'ready' || preview.operation !== 'preview')
      throw new Error('frequency-native-reset-preview-unavailable');
    expect(preview.counts.attendance).toBeGreaterThan(0);
    const stale = {
      contractVersion: 1,
      operation: 'execute',
      year: 2026,
      previewRevision: preview.previewRevision,
      confirmationPhrase: preview.confirmationPhrase,
      understandsIrreversible: true,
    };
    await service.execute(request('set-paused', { expectedRevision: 0, paused: true }), admin);
    expect(await reset.execute(stale)).toMatchObject({ state: 'preview-changed' });
    preview = await reset.execute({ contractVersion: 1, operation: 'preview', year: 2026 });
    if (preview.state !== 'ready' || preview.operation !== 'preview')
      throw new Error('frequency-native-reset-preview-unavailable');
    expect(
      await reset.execute({
        ...stale,
        previewRevision: preview.previewRevision,
        confirmationPhrase: preview.confirmationPhrase,
      }),
    ).toMatchObject({ state: 'ready', operation: 'execute' });
    const [remaining] = await exec(
      `SELECT (SELECT count(*)::integer FROM attendance.batch_v2) AS batches,(SELECT count(*)::integer FROM attendance.receipt_v2) AS receipts,(SELECT count(*)::integer FROM gradebook.student_identity WHERE id='${uid}') AS identities,(SELECT paused FROM attendance.school_state_v2 WHERE academic_year=2026) AS paused`,
    );
    expect(remaining).toEqual({ batches: 0, receipts: 0, identities: 1, paused: true });
    expect(
      ((await service.summary(2026, uid, '2026-01', async () => true)) as FrequencySummaryV2).marks,
    ).toEqual([]);
  }, 60000);
});
