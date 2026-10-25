import { z } from 'zod';
import {
  livePublishEventV1,
  type LivePublishEventV1,
} from '../../../shared/student-portal-contracts/live-v1';
import type { StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';
import { portalDatabaseV1 } from '../composition/database-v1';
import type { PortalCompositionEnvV1 } from '../composition/config-v1';
import { portalLiveStubV1 } from './live-connect-v1';

const rowV1 = z
  .object({
    security_relevant: z.boolean(),
    id: z.string().regex(/^[1-9]\d*$/u),
    audience: z.enum(['admin', 'student']),
    domain: z.enum(['gradebook', 'portal']),
    version: z.string(),
    account_id: z.uuid().nullable(),
    class_id: z.coerce.number().int().positive().safe().nullable(),
    student_ids: z.array(z.coerce.number().int().positive().safe()).max(1000),
    occurred_at: z
      .union([z.date(), z.string()])
      .transform((value) => new Date(value).toISOString()),
  })
  .strict();

async function claimLiveEventsV1(sql: StudentPortalPostgresSqlV1, token: string, limit: number) {
  return sql.begin(async (tx) =>
    tx.unsafe(
      `WITH pending AS (
      SELECT id FROM student_portal.live_event_outbox_v1
      WHERE delivered_at IS NULL AND next_attempt_at<=statement_timestamp()
        AND (lease_until IS NULL OR lease_until<statement_timestamp())
      ORDER BY security_relevant DESC,id LIMIT $1 FOR UPDATE SKIP LOCKED
    )
    UPDATE student_portal.live_event_outbox_v1 event SET lease_token=$2::uuid,
      lease_until=statement_timestamp()+interval '30 seconds',attempts=attempts+1
    FROM pending WHERE event.id=pending.id
    RETURNING event.id::text,event.audience,event.domain,event.version,event.account_id,
      event.class_id,event.security_relevant,to_json(event.student_ids) AS student_ids,event.occurred_at`,
      [limit, token],
    ),
  );
}

function eventFromRowV1(input: unknown): LivePublishEventV1 {
  const row = rowV1.parse(input);
  return livePublishEventV1.parse({
    securityRelevant: row.security_relevant,
    cursor: row.id.padStart(20, '0'),
    audience: row.audience,
    domain: row.domain,
    version: row.version,
    accountId: row.account_id,
    classId: row.class_id,
    studentIds: row.student_ids,
    occurredAt: row.occurred_at,
  });
}

/** Runs from scheduled maintenance even when there are no new notifications. */
export async function cleanupPortalLiveEventsV1(sql: StudentPortalPostgresSqlV1): Promise<number> {
  return (await sql.unsafe(`WITH expired AS (
    SELECT id FROM student_portal.live_event_outbox_v1
    WHERE delivered_at<statement_timestamp()-interval '7 days'
    ORDER BY delivered_at,id LIMIT 100 FOR UPDATE SKIP LOCKED)
    DELETE FROM student_portal.live_event_outbox_v1 event USING expired
    WHERE event.id=expired.id RETURNING event.id`)).length;
}

async function publishBeforeDeadlineV1(env: PortalCompositionEnvV1, input: unknown, deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('student-portal-live-delivery-unavailable');
  const event = eventFromRowV1(input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      portalLiveStubV1(env, event.audience).publish(event),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('student-portal-live-delivery-unavailable')), remaining);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function settleLiveEventsV1(env: PortalCompositionEnvV1, token: string,
  delivered: string[], failed: string[], deferred: string[]) {
  return portalDatabaseV1(env, 'live-drain', async (sql) => {
    let acknowledged = 0;
    if (delivered.length) {
      const rows = await sql.unsafe(`UPDATE student_portal.live_event_outbox_v1
        SET delivered_at=statement_timestamp(),lease_token=NULL,lease_until=NULL
        WHERE lease_token=$1::uuid
          AND id IN (SELECT value::bigint FROM jsonb_array_elements_text($2::text::jsonb))
        RETURNING id::text`, [token, JSON.stringify(delivered)]);
      acknowledged = rows.length;
    }
    if (failed.length) await sql.unsafe(`UPDATE student_portal.live_event_outbox_v1
      SET lease_token=NULL,lease_until=NULL,next_attempt_at=statement_timestamp()+
        make_interval(secs=>LEAST(300,power(2,LEAST(attempts,8))::integer))
      WHERE lease_token=$1::uuid
        AND id IN (SELECT value::bigint FROM jsonb_array_elements_text($2::text::jsonb))`,
    [token, JSON.stringify(failed)]);
    if (deferred.length) await sql.unsafe(`UPDATE student_portal.live_event_outbox_v1
      SET lease_token=NULL,lease_until=NULL,attempts=GREATEST(0,attempts-1)
      WHERE lease_token=$1::uuid
        AND id IN (SELECT value::bigint FROM jsonb_array_elements_text($2::text::jsonb))`,
    [token, JSON.stringify(deferred)]);
    return acknowledged;
  });
}

/** Publishes a claimed batch in order; what the deadline leaves out is deferred, not failed. */
async function deliverLiveEventsV1(env: PortalCompositionEnvV1, events: readonly Record<string, unknown>[], deadline: number) {
  const delivered: string[] = [], failed: string[] = [], deferred: string[] = [];
  for (const input of events) {
    if (Date.now() >= deadline) { deferred.push(input.id as string); continue; }
    try {
      await publishBeforeDeadlineV1(env, input, deadline);
      delivered.push(input.id as string);
    } catch { failed.push(input.id as string); }
  }
  return { delivered, failed, deferred };
}

/** At most four batches and 20 seconds of delivery work, below each 30-second lease.
 * Database settlement can exceed that budget; token guards prevent acknowledging a new owner.
 * A timed-out RPC may finish remotely: the existing cursor deduplication handles its retry.
 * JSON boundaries preserve production fetch_types:false compatibility.
 */
export async function dispatchPortalLiveEventsV1(env: PortalCompositionEnvV1, limit = 50): Promise<number> {
  if (!env.PORTAL_LIVE) return 0;
  const started = Date.now(), deadline = started + 20_000;
  const size = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
  let claimed = 0, accepted = 0, acknowledged = 0, rejected = 0;
  let outcome: 'ok' | 'unavailable' = 'unavailable';
  try {
    for (let batch = 0; batch < 4 && Date.now() < deadline; batch++) {
      const token = crypto.randomUUID();
      const events = Array.from(await portalDatabaseV1(env, 'live-drain', (sql) => claimLiveEventsV1(sql, token, size)));
      claimed += events.length;
      if (!events.length) break;
      // UPDATE RETURNING does not preserve the pending CTE's priority ordering.
      events.sort((a, b) => Number(b.security_relevant) - Number(a.security_relevant)
        || (BigInt(a.id as string) < BigInt(b.id as string) ? -1 : 1));
      const { delivered, failed, deferred } = await deliverLiveEventsV1(env, events, deadline);
      accepted += delivered.length;
      rejected += failed.length;
      const settled = await settleLiveEventsV1(env, token, delivered, failed, deferred);
      acknowledged += settled;
      if (failed.length || settled !== delivered.length)
        throw new Error('student-portal-live-delivery-unavailable');
      if (events.length < size || deferred.length) break;
    }
    outcome = 'ok';
    return acknowledged;
  } finally {
    if (claimed || outcome === 'unavailable') console.info(JSON.stringify({
      event: 'student-portal-live-drain-v1', outcome, occurredAt: new Date().toISOString(),
      elapsedMs: Math.max(0, Date.now() - started), claimed, accepted, acknowledged, rejected,
    }));
  }
}
