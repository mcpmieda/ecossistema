import { beforeEach, describe, expect, it } from 'vitest';
import { sessionsCasesV2 } from './sessions-cases-v2';
import {
  adminClassCatalogRequestV2,
  adminReadQueryV2,
  adminReadResponseV2,
} from '../../../shared/student-portal-contracts/admin-read-v2';
import { adminResponseV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { createRelationalWorkspaceV2 } from '../../../server/gradebook/application/operational-workspace/relational-workspace-v2';
import {
  createGradebookPostgresDatabaseFromSqlV1,
  type GradebookPostgresSqlV1,
} from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import { PolicyServiceV1 } from '../../../server/student-portal/policies/policy-service-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import {
  readApiV2,
  readAccountIdV2,
  readContextV2,
  READ_CLASS_V2,
  READ_SCHOOL_V2,
  resetAdminReadFixtureV2,
} from './read-fixture-v2';

export function adminReadCasesV2(
  get: () => {
    sql: StudentPortalPostgresSqlV1;
    admin: StudentPortalPostgresSqlV1;
    gradebook: StudentPortalPostgresSqlV1;
    calls: () => number;
    resetCalls: () => void;
  },
) {
  const input = (extra: Record<string, unknown> = {}) => ({
    contractVersion: 2,
    operation: 'accounts-read',
    scope: READ_CLASS_V2,
    page: { limit: 100 },
    ...extra,
  });
  const read = async (extra: Record<string, unknown> = {}) => {
    const response = await readApiV2(get().sql).query(readContextV2(), input(extra));
    expect(response.state).toBe('accounts-read');
    if (response.state !== 'accounts-read') throw new Error(`Unexpected ${response.state}`);
    return response;
  };
  beforeEach(async () => {
    await resetAdminReadFixtureV2(get().admin);
    get().resetCalls();
  });
  sessionsCasesV2(get);
  describe('administrative read V2, bounded and compatible', () => {
    it('reads 400 accounts per page and preserves the signed continuation and other operation limits', async () => {
      const admin = get().admin;
      await admin.unsafe(`INSERT INTO gradebook.aluno(id,ano,nome)
        SELECT 746000+n,2026,'SYNTHETIC READ STUDENT '||lpad(n::text,3,'0') FROM generate_series(107,406) n`);
      await admin.unsafe(`INSERT INTO gradebook.vinculo(ano,turma_id,numero,aluno_id)
        SELECT 2026,746001,n,746000+n FROM generate_series(107,406) n`);
      await admin.unsafe(`INSERT INTO student_portal.account(id,gradebook_student_id,auth_state,eligibility)
        SELECT ('74600000-0000-4000-8000-'||lpad((n+1000)::text,12,'0'))::uuid,746000+n,'pending-activation','eligible'
        FROM generate_series(107,406) n`);
      try {
        get().resetCalls();
        const first = await read({ page: { limit: 400 } });
        expect(first.items).toHaveLength(400);
        expect(get().calls()).toBeLessThanOrEqual(5);
        const last = await read({ page: { limit: 400, cursor: first.nextCursor } });
        expect(last.items).toHaveLength(5);
        expect(last.nextCursor).toBeNull();
        expect(new Set([...first.items, ...last.items].map((item) => item.accountId)).size).toBe(
          405,
        );
        await expect(read({ page: { limit: 100, cursor: first.nextCursor } })).rejects.toThrow();
        expect(adminReadQueryV2.safeParse(input({ page: { limit: 401 } })).success).toBe(false);
        expect(
          adminReadQueryV2.safeParse(input({ operation: 'sessions-read', page: { limit: 400 } }))
            .success,
        ).toBe(false);
        expect(
          adminResponseV1.safeParse({
            contractVersion: 1,
            state: 'accounts',
            requestId: readContextV2().requestId,
            scopeVersion: 0,
            items: first.items,
            nextCursor: null,
          }).success,
        ).toBe(false);
      } finally {
        await admin.unsafe(
          'DELETE FROM student_portal.account WHERE gradebook_student_id BETWEEN 746107 AND 746406',
        );
        await admin.unsafe(
          'DELETE FROM gradebook.vinculo WHERE aluno_id BETWEEN 746107 AND 746406',
        );
        await admin.unsafe('DELETE FROM gradebook.aluno WHERE id BETWEEN 746107 AND 746406');
      }
    });
    it('returns complete keyset pages without N+1 and preserves V1 response shape', async () => {
      const first = await read();
      const firstCalls = get().calls();
      expect(first.items).toHaveLength(100);
      expect(first.nextCursor).not.toBeNull();
      get().resetCalls();
      const second = await read({ page: { limit: 100, cursor: first.nextCursor } });
      expect(second.items).toHaveLength(5);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.items, ...second.items].map((item) => item.accountId)).size).toBe(
        105,
      );
      expect(firstCalls).toBeLessThanOrEqual(5);
      expect(get().calls()).toBeLessThanOrEqual(5);
      expect(first.items[0]).toMatchObject({
        linkClosed: false,
        classId: 746001,
        lastAuthenticationAt: null,
        access: {
          state: 'resolved',
          enabled: false,
          source: READ_SCHOOL_V2,
          accessPermitted: false,
        },
        firstAccess: { state: 'not-required', qrIssued: false, recoveryReady: false },
      });
      expect(first.items[1]).toMatchObject({
        firstAccess: { state: 'birth-missing', qrIssued: false, recoveryReady: false },
      });
      const legacy = await readApiV2(get().sql).query(readContextV2(), {
        ...input(),
        contractVersion: 1,
        operation: 'accounts',
      });
      expect(adminResponseV1.safeParse(legacy).success).toBe(true);
      expect(adminReadResponseV2.safeParse(legacy).success).toBe(false);
    });
    it('adds read context only when requested, preserving strict responses for open older clients', async () => {
      const api = readApiV2(get().sql);
      const accountId = readAccountIdV2(1);
      const scope = { kind: 'account', academicYear: 2026, accountId };
      const birthQuery = { contractVersion: 1, operation: 'birth-years', scope, page: { limit: 1 } };
      const legacyBirth = await api.query(readContextV2(), birthQuery);
      expect(legacyBirth).not.toHaveProperty('accountsScopeVersion');
      const birth = await api.query(readContextV2(), { ...birthQuery, includeReadContext: true });
      const accounts = await read({ scope, page: { limit: 1 } });
      expect(birth).toMatchObject({ state: 'birth-years', accountsScopeVersion: accounts.scopeVersion });
      const eventId = readAccountIdV2(950);
      await get().admin.unsafe(`INSERT INTO student_portal.audit_event
        (event_id,occurred_at,actor_id,account_id,scope_json,kind,result,request_id,version)
        VALUES($1::uuid,now(),$2::uuid,$2::uuid,
          jsonb_build_object('kind','account','academicYear',2026,'accountId',$2::text),
          'login','success',$1::uuid,0)`, [eventId, accountId]);
      try {
        const query = { contractVersion: 1, operation: 'audit-detail', scope, eventId, page: { limit: 1 } };
        const auditContext = { ...readContextV2(), capability: 'platform.settings.write' };
        const legacyAudit = await api.query(auditContext, query);
        expect(legacyAudit.state).toBe('audit-detail');
        expect(legacyAudit).not.toHaveProperty('observedAt');
        const audit = await api.query(auditContext, { ...query, includeReadContext: true });
        expect(audit.state).toBe('audit-detail');
        if (audit.state !== 'audit-detail') throw new Error('Synthetic audit unavailable');
        expect(Number.isFinite(Date.parse(audit.observedAt!))).toBe(true);
      } finally {
        await get().admin.unsafe('DELETE FROM student_portal.audit_event WHERE event_id=$1::uuid', [eventId]);
      }
    });
    it('orders accented names and homonyms across account pages with a stable cursor', async () => {
      await get().admin.unsafe(`UPDATE gradebook.aluno SET nome=CASE id
        WHEN 746001 THEN 'ÁGATA' WHEN 746002 THEN 'ANA'
        WHEN 746003 THEN 'ANA' WHEN 746004 THEN 'BIA' END
        WHERE id BETWEEN 746001 AND 746004`);
      try {
        const first = await read({ page: { limit: 2 } });
        const second = await read({ page: { limit: 2, cursor: first.nextCursor } });
        const third = await read({ page: { limit: 2, cursor: second.nextCursor } });
        expect([...first.items, ...second.items].map((item) => item.accountId)).toEqual([
          readAccountIdV2(1),
          readAccountIdV2(2),
          readAccountIdV2(3),
          readAccountIdV2(4),
        ]);
        expect(second.nextCursor).not.toBeNull();
        expect(third.items[0]?.accountId).toBe(readAccountIdV2(5));
        const birth = async (cursor?: string) => {
          const result = await readApiV2(get().sql).query(readContextV2(), {
            contractVersion: 1,
            operation: 'birth-years',
            scope: READ_CLASS_V2,
            page: { limit: 2, ...(cursor ? { cursor } : {}) },
          });
          expect(result.state).toBe('birth-years');
          if (result.state !== 'birth-years') throw new Error('Birth page unavailable');
          return result;
        };
        const birthFirst = await birth();
        const birthSecond = await birth(birthFirst.nextCursor ?? undefined);
        const birthThird = await birth(birthSecond.nextCursor ?? undefined);
        expect([...birthFirst.items, ...birthSecond.items].map((item) => item.accountId)).toEqual(
          [...first.items, ...second.items].map((item) => item.accountId),
        );
        expect(birthThird.items.map((item) => item.accountId)).toEqual(
          third.items.map((item) => item.accountId),
        );
      } finally {
        await get().admin.unsafe(`UPDATE gradebook.aluno
          SET nome='SYNTHETIC READ STUDENT '||lpad((id-746000)::text,3,'0')
          WHERE id BETWEEN 746001 AND 746004`);
      }
    });
    it('reuses the complete BN catalog including empty classes and ignores the BN global year', async () => {
      const database = createGradebookPostgresDatabaseFromSqlV1(
        get().gradebook as unknown as GradebookPostgresSqlV1,
      );
      const catalog = createRelationalWorkspaceV2(database);
      const first = await catalog.execute(adminClassCatalogRequestV2());
      expect(first.state).toBe('ready');
      if (first.state !== 'ready' || first.operation !== 'search')
        throw new Error('Catalog unavailable');
      expect(first.items).toHaveLength(100);
      const second = await catalog.execute(adminClassCatalogRequestV2(first.nextOffset!));
      if (second.state !== 'ready' || second.operation !== 'search')
        throw new Error('Catalog unavailable');
      expect(second.items).toHaveLength(6);
      expect(second.items.at(-1)?.entity.id).toBe(746106);
      expect(second.nextOffset).toBeNull();
      expect(first.context.year).toBe(2026);
      expect((await read({ scope: { ...READ_CLASS_V2, classId: 746106 } })).items).toEqual([]);
    });
    it('distinguishes unlinked and ambiguous accounts without guessing a class or access', async () => {
      // Deliberate corrupt-data simulation in this disposable database only.
      // Production enforces this index; restore it even when the assertion fails.
      await get().admin.unsafe('DROP INDEX gradebook.vinculo_um_corrente_por_aluno_uidx');
      try {
        await get().admin.unsafe(
          'INSERT INTO gradebook.vinculo(ano,turma_id,numero,aluno_id) VALUES(2026,746002,1,746001)',
        );
        const ambiguous = await read({
          scope: { kind: 'account', academicYear: 2026, accountId: readAccountIdV2(1) },
        });
        expect(ambiguous.items[0]).toMatchObject({
          linkClosed: false,
          classId: null,
          eligibility: 'unresolved',
          access: { state: 'unresolved', enabled: null, accessPermitted: false },
        });
      } finally {
        await get().admin.unsafe(
          'DELETE FROM gradebook.vinculo WHERE turma_id=746002 AND aluno_id=746001',
        );
        await get().admin.unsafe(
          'CREATE UNIQUE INDEX vinculo_um_corrente_por_aluno_uidx ON gradebook.vinculo(aluno_id) WHERE situacao IS DISTINCT FROM 6',
        );
      }
      const unlinked = await read({
        scope: { kind: 'account', academicYear: 2026, accountId: readAccountIdV2(200) },
      });
      expect(unlinked.items[0]).toMatchObject({
        linkClosed: true,
        link: null,
        classId: null,
        eligibility: 'unlinked',
        access: { state: 'unresolved' },
      });
    });
    it('binds cursors to actor, operation and filters; searches literal names', async () => {
      const first = await read();
      const api = readApiV2(get().sql);
      expect(
        (
          await api.query(
            readContextV2(),
            input({ blocked: true, page: { limit: 100, cursor: first.nextCursor } }),
          )
        ).state,
      ).toBe('invalid-request');
      expect(
        (
          await api.query(
            { ...readContextV2(), actorId: readAccountIdV2(500) },
            input({ page: { limit: 100, cursor: first.nextCursor } }),
          )
        ).state,
      ).toBe('invalid-request');
      expect((await read({ nameSearch: '%' })).items).toEqual([]);
      expect((await read({ nameSearch: 'student 001' })).items).toHaveLength(1);
    });
    it('uses only retained successful authentication events, never account updated_at or failed events', async () => {
      const accountId = readAccountIdV2(1);
      await get().admin.unsafe(
        `INSERT INTO student_portal.audit_event(event_id,occurred_at,actor_id,account_id,scope_json,kind,result,request_id,version)
        SELECT gen_random_uuid(),now()-age,$1::uuid,$1::uuid,jsonb_build_object('kind','account','academicYear',2026,'accountId',$1::text),kind,result,gen_random_uuid(),0
        FROM (VALUES(interval '1 day','login','success'),(interval '1 hour','login-failed','denied'),
          (interval '13 months','activated','success'),(interval '-1 day','login','success')) v(age,kind,result)`,
        [accountId],
      );
      const row = (await read({ nameSearch: 'student 001' })).items[0]!;
      expect(Date.now() - Date.parse(row.lastAuthenticationAt!)).toBeGreaterThan(23 * 3600_000);
      expect(Date.now() - Date.parse(row.lastAuthenticationAt!)).toBeLessThan(25 * 3600_000);
      await get().admin.unsafe(
        "DELETE FROM student_portal.audit_event WHERE occurred_at>now()-interval '12 months'",
      );
      expect((await read({ nameSearch: 'student 001' })).items[0]!.lastAuthenticationAt).toBeNull();
    });
    it('uses inherited policy and counts only currently authorized sessions', async () => {
      await get().admin.unsafe(
        "UPDATE student_portal.setting SET value_json='true'::jsonb WHERE scope_key='school:2026' AND field_key='accessEnabled'",
      );
      const defaults = await new PolicyServiceV1(get().admin).read(READ_SCHOOL_V2);
      const calendar = {
        ...defaults.value.calendar,
        yearStartsAt: new Date(Date.now() - 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        yearEndsAt: new Date(Date.now() + 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      };
      await get().admin.unsafe(
        "UPDATE student_portal.setting SET value_json=$1::text::jsonb WHERE scope_key='school:2026' AND field_key='calendar'",
        [JSON.stringify(calendar)],
      );
      await get().admin
        .unsafe(`INSERT INTO student_portal.setting(scope_key,field_key,scope_kind,class_id,value_json,source_scope_json,version)
        VALUES('class:2026:746001','accessEnabled','class',746001,'true'::jsonb,'{"kind":"class","academicYear":2026,"classId":746001}'::jsonb,1)`);
      await get().admin.unsafe(
        `INSERT INTO student_portal.session(id,account_id,token_hash,security_version,created_at,expires_at,revoked_at,persistent)
        SELECT gen_random_uuid(),$1::uuid,'synthetic-read-session-'||n,CASE WHEN n=3 THEN 1 ELSE 0 END,
          now()-CASE WHEN n=5 THEN interval '13 hours' ELSE interval '1 hour' END,CASE WHEN n=2 THEN now()-interval '1 minute' ELSE now()+interval '1 hour' END,
          CASE WHEN n=4 THEN now() ELSE NULL END,false FROM generate_series(1,5) n`,
        [readAccountIdV2(1)],
      );
      const row = (await read({ nameSearch: 'student 001' })).items[0]!;
      expect(row.access).toMatchObject({
        enabled: true,
        source: READ_CLASS_V2,
        accessPermitted: true,
      });
      expect(row.validSessionCount).toBe(1);
      get().resetCalls();
      const overview = await readApiV2(get().sql).query(
        readContextV2(),
        input({ operation: 'overview' }),
      );
      expect(overview).toMatchObject({
        state: 'overview',
        counts: {
          accounts: 105,
          active: 1,
          pendingActivation: 104,
          accessEnabled: 105,
          validSessions: 1,
        },
        health: 'normal',
      });
      expect(get().calls()).toBeLessThanOrEqual(8);
      expect('classes' in overview).toBe(false);
      // Visão geral (10/11/2026): the school summary brings every class only when asked.
      const school = await readApiV2(get().sql).query(
        readContextV2(),
        input({ operation: 'overview', scope: READ_SCHOOL_V2, byClass: true }),
      );
      if (school.state !== 'overview' || !school.classes) throw new Error('per-class totals missing');
      expect(school.classes.reduce((sum, row) => sum + row.counts.accounts, 0)).toBe(
        school.counts.accounts,
      );
      const plain = await readApiV2(get().sql).query(
        readContextV2(),
        input({ operation: 'overview', scope: READ_SCHOOL_V2 }),
      );
      expect(plain.state === 'overview' && plain.classes).toBeFalsy();
      expect(
        (await readApiV2(get().sql).query(readContextV2(), input({ operation: 'overview', byClass: true })))
          .state,
      ).toBe('invalid-request');
      await get().admin.unsafe('UPDATE student_portal.account SET blocked=true WHERE id=$1::uuid', [
        readAccountIdV2(1),
      ]);
      expect((await read({ nameSearch: 'student 001' })).items[0]).toMatchObject({
        validSessionCount: 0,
        access: { accessPermitted: false },
      });
    });
    it('checks trusted tenant/capability/context and rejects extra fields before SQL', async () => {
      const api = readApiV2(get().sql);
      for (const context of [
        { ...readContextV2(), tenantId: readAccountIdV2(900) },
        { ...readContextV2(), capability: 'student' },
        { ...readContextV2(), authenticatedAt: '2020-01-01T00:00:00Z' },
      ])
        expect((await api.query(context, input())).state).toBe('forbidden');
      expect((await api.query(readContextV2(), input({ role: 'ADMINISTRADOR' }))).state).toBe(
        'invalid-request',
      );
      expect(get().calls()).toBe(0);
    });
    // Includes inserting/removing 5,001 fixtures; verifies bounded correctness, not latency.
    it('refuses an oversized overview instead of returning truncated school totals', async () => {
      await get().admin
        .unsafe(`INSERT INTO student_portal.account(id,auth_state,eligibility,closed_at)
        SELECT ('74600000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'pending-activation','unlinked',now()
        FROM generate_series(1000,6000) n`);
      try {
        const response = await readApiV2(get().sql).query(
          readContextV2(),
          input({ operation: 'overview', scope: READ_SCHOOL_V2 }),
        );
        expect(response.state).toBe('unavailable');
        expect(response).not.toHaveProperty('counts');
      } finally {
        await get().admin.unsafe(
          'DELETE FROM student_portal.account WHERE id BETWEEN $1::uuid AND $2::uuid',
          [readAccountIdV2(1000), readAccountIdV2(6000)],
        );
      }
    }, 30_000);
  });
}
