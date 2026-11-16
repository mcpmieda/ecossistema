import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupPortalLiveEventsV1,
  dispatchPortalLiveEventsV1,
} from '../../../server/student-portal/live/live-outbox-v1';
import type { PortalCompositionEnvV1 } from '../../../server/student-portal/composition/config-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import type { LivePublishEventV1 } from '../../../shared/student-portal-contracts/live-v1';

// Never connect to a remote or production database. This suite owns a separate disposable
// database so it neither depends on file ordering nor resets another suite's data/schema.
const target = new URL(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://missing.invalid');
if (
  target.protocol !== 'postgres:' ||
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/portal705_test'
)
  throw new Error('A fresh local portal705_test target is required.');
const name = `portal_live839_${crypto.randomUUID().replaceAll('-', '')}`;
const root = postgres(target.toString(), { max: 1, onnotice: () => undefined });
const isolated = new URL(target);
isolated.pathname = `/${name}`;
let admin: ReturnType<typeof postgres>;
let created = false;
const accepted: LivePublishEventV1[] = [];
let failDelivery = false;
const appUrl = new URL(isolated);
appUrl.username = 'student_portal_app';
const env: PortalCompositionEnvV1 = {
  PORTAL_ENVIRONMENT: 'local',
  PORTAL_ORIGIN: 'http://localhost:8787',
  PORTAL_ADMIN_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  PORTAL_DB: { connectionString: appUrl.toString() },
  PORTAL_LIVE: {
    idFromName: (value) => ({ toString: () => value }) as DurableObjectId,
    get: () => ({
      renewSecurity: async () => false,
      presence: async () => ({
        connectedStudents: 0,
        observedAt: new Date().toISOString(),
        windowSeconds: 60,
      }),
      fetch: async () => new Response(null, { status: 404 }),
      publish: async (input) => {
        if (failDelivery) throw new Error('synthetic-delivery-failure');
        accepted.push(input as LivePublishEventV1);
        return 'delivered' as const;
      },
    }),
  },
};

beforeAll(async () => {
  await root.unsafe(`CREATE DATABASE "${name}"`);
  created = true;
  admin = postgres(isolated.toString(), { max: 1, onnotice: () => undefined });
  await admin.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='student_portal_app') THEN
      CREATE ROLE student_portal_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
  END $$;
  CREATE SCHEMA student_portal;
  CREATE TABLE student_portal.live_event_outbox_v1 (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    audience text NOT NULL, domain text NOT NULL, version text NOT NULL, security_relevant boolean NOT NULL DEFAULT false,
    account_id uuid, class_id integer, student_ids integer[] NOT NULL DEFAULT '{}',
    occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    delivered_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0
  );
  GRANT USAGE ON SCHEMA student_portal TO student_portal_app;
  GRANT SELECT,UPDATE,DELETE ON student_portal.live_event_outbox_v1 TO student_portal_app;`);
});
beforeEach(async () => {
  accepted.length = 0;
  failDelivery = false;
  await admin.unsafe('TRUNCATE student_portal.live_event_outbox_v1 RESTART IDENTITY');
});
afterAll(async () => {
  await admin?.end({ timeout: 1 });
  if (created) await root.unsafe(`DROP DATABASE "${name}"`);
  await root.end({ timeout: 1 });
});

async function seed() {
  await admin.unsafe(`INSERT INTO student_portal.live_event_outbox_v1(audience,domain,version,student_ids)
    VALUES ('admin','gradebook','revision:1',ARRAY[1,2]),('student','portal','revision:2',ARRAY[3])`);
}

describe('real postgres.js production options and live delivery', () => {
  it('demonstrates why native arrays cannot be assumed with type discovery disabled', async () => {
    const sql = postgres(appUrl.toString(), { max: 1, fetch_types: false, prepare: true });
    try {
      const rows = await sql.unsafe(
        'SELECT ARRAY[1,2]::integer[] AS native_ids,to_json(ARRAY[1,2]::integer[]) AS json_ids',
      );
      expect(typeof rows[0]?.native_ids).toBe('string');
      expect(rows[0]?.json_ids).toEqual([1, 2]);
      await expect(
        sql.unsafe('SELECT $1::bigint[]', [['1', '2']] as never[]),
      ).rejects.toMatchObject({ code: '22P02' });
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('drains and acknowledges both audiences through the real production client factory', async () => {
    await seed();
    expect(await dispatchPortalLiveEventsV1(env)).toBe(2);
    expect(accepted.map((event) => event.studentIds)).toEqual([[1, 2], [3]]);
    const rows =
      await admin.unsafe(`SELECT count(*)::integer AS delivered FROM student_portal.live_event_outbox_v1
      WHERE delivered_at IS NOT NULL AND lease_token IS NULL AND lease_until IS NULL`);
    expect(rows[0]?.delivered).toBe(2);
    expect(await dispatchPortalLiveEventsV1(env)).toBe(0);
    expect(accepted).toHaveLength(2);
  });

  it('releases a failed delivery into backoff instead of holding the oldest rows forever', async () => {
    await seed();
    failDelivery = true;
    await expect(dispatchPortalLiveEventsV1(env)).rejects.toThrow(
      'student-portal-live-delivery-unavailable',
    );
    const rows =
      await admin.unsafe(`SELECT count(*)::integer AS waiting FROM student_portal.live_event_outbox_v1
      WHERE delivered_at IS NULL AND lease_token IS NULL AND lease_until IS NULL
        AND attempts=1 AND next_attempt_at>statement_timestamp()`);
    expect(rows[0]?.waiting).toBe(2);
    expect(await dispatchPortalLiveEventsV1(env)).toBe(0);
    failDelivery = false;
    await admin.unsafe(
      "UPDATE student_portal.live_event_outbox_v1 SET next_attempt_at=statement_timestamp()-interval '1 second'",
    );
    expect(await dispatchPortalLiveEventsV1(env)).toBe(2);
  });

  it('does not claim one live lease twice across two concurrent dispatchers', async () => {
    await seed();
    const counts = await Promise.all([
      dispatchPortalLiveEventsV1(env),
      dispatchPortalLiveEventsV1(env),
    ]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(new Set(accepted.map((event) => event.cursor)).size).toBe(2);
    expect(accepted).toHaveLength(2);
  });

  it('drains more than one full batch but leaves excess for the next invocation', async () => {
    await admin.unsafe(`INSERT INTO student_portal.live_event_outbox_v1(audience,domain,version)
      SELECT 'admin','gradebook','revision:1' FROM generate_series(1, 205)`);
    expect(await dispatchPortalLiveEventsV1(env)).toBe(200);
    expect(await dispatchPortalLiveEventsV1(env)).toBe(5);
    expect(new Set(accepted.map((event) => event.cursor)).size).toBe(205);
  });

  it('cleans delivered history without pending events, bounded to 100 and preserving pending rows', async () => {
    await admin.unsafe(`INSERT INTO student_portal.live_event_outbox_v1(audience,domain,version,delivered_at)
      SELECT 'admin','gradebook','revision:1',statement_timestamp()-interval '8 days' FROM generate_series(1, 105)`);
    await admin.unsafe(`INSERT INTO student_portal.live_event_outbox_v1(audience,domain,version,next_attempt_at)
      VALUES('admin','gradebook','revision:1',statement_timestamp()+interval '1 hour')`);
    expect(await dispatchPortalLiveEventsV1(env)).toBe(0);
    const sql = postgres(appUrl.toString(), { max: 1, fetch_types: false, prepare: true });
    try {
      expect(await cleanupPortalLiveEventsV1(sql as unknown as StudentPortalPostgresSqlV1)).toBe(
        100,
      );
      expect(await cleanupPortalLiveEventsV1(sql as unknown as StudentPortalPostgresSqlV1)).toBe(5);
      expect(await cleanupPortalLiveEventsV1(sql as unknown as StudentPortalPostgresSqlV1)).toBe(0);
    } finally {
      await sql.end({ timeout: 1 });
    }
    expect(
      (
        await admin.unsafe(
          'SELECT count(*)::integer AS count FROM student_portal.live_event_outbox_v1',
        )
      )[0]?.count,
    ).toBe(1);
  });

  it('logs only aggregate delivery evidence, never event identities or credentials', async () => {
    await seed();
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      expect(await dispatchPortalLiveEventsV1(env)).toBe(2);
      const diagnostics = log.mock.calls
        .flat()
        .filter(
          (value): value is string =>
            typeof value === 'string' && value.includes('student-portal-live-drain-v1'),
        );
      expect(diagnostics).toHaveLength(1);
      const record = JSON.parse(diagnostics[0]!);
      expect(Object.keys(record).sort()).toEqual([
        'accepted',
        'acknowledged',
        'claimed',
        'elapsedMs',
        'event',
        'occurredAt',
        'outcome',
        'rejected',
      ]);
      expect(record).toMatchObject({ accepted: 2, acknowledged: 2, rejected: 0, outcome: 'ok' });
      expect(diagnostics[0]).not.toContain('revision:');
      expect(diagnostics[0]).not.toContain('postgres:');
    } finally {
      log.mockRestore();
    }
  });
});
