import { z } from 'zod';
import type {
  StudentPortalPostgresQueryV1,
  StudentPortalPostgresSqlV1,
} from '../persistence/postgres-persistence-v1';
import type { publicationContextV1 } from '../publication/self-projection-reader-v1';
import { PERIODS_V1, publicationDigestV1 } from '../publication/state-v1';
import { accessGateV1, periodDisclosureV1 } from '../policies/calendar-v1';
import { endedPeriodsV1, termClosingTargetsV1 } from '../publication/term-closing-self-v1';

type ContextV1 = NonNullable<Awaited<ReturnType<typeof publicationContextV1>>>;
// Bump whenever Self interpretation or the shared seal rule changes without a data revision.
const RULE_VERSION_V1 = 'self-seals:1';
const writeV1 = z.object({
  accountId: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  seals: z.number().int().nonnegative().safe().nullable(),
  computedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
});
export type SealCacheWriteV1 = z.infer<typeof writeV1>;
export type SealCachePlanV1 = {
  write: Omit<SealCacheWriteV1, 'seals'>;
  hit: { seals: number | null } | null;
};
const globalV1 = z.object({
  academicGeneration: z.string().regex(/^[a-f0-9]{32}$/u),
  academicCounter: z.string().regex(/^\d+$/u),
  linkGeneration: z.string().regex(/^[a-f0-9]{32}$/u),
  linkCounter: z.string().regex(/^\d+$/u),
  sourceGeneration: z.string().regex(/^[a-f0-9]{32}$/u),
  sourceRevision: z.string().regex(/^\d+$/u),
  controlVersion: z.string().regex(/^\d+$/u),
  enabled: z.literal(true),
  policyEpoch: z.string().regex(/^\d+$/u),
});
type GlobalV1 = z.infer<typeof globalV1>;

/** Dates only set a conservative deadline; all state decisions stay in the canonical helpers. */
export function sealCacheTemporalV1(context: ContextV1) {
  const value = context.policy.enforcedValue;
  const now = context.now.getTime();
  const times: number[] = [];
  const dates = (input: unknown) => {
    if (typeof input === 'string') {
      const at = Date.parse(input);
      if (Number.isFinite(at) && at > now) times.push(at);
    } else if (Array.isArray(input)) input.forEach(dates);
    else if (input && typeof input === 'object') Object.values(input).forEach(dates);
  };
  dates(value.calendar);
  dates(value.accessSchedule);
  return {
    signature: [
      accessGateV1(value, context.now),
      PERIODS_V1.map((period) => periodDisclosureV1(value, period, context.now)),
      endedPeriodsV1(value, context.now),
      termClosingTargetsV1(value, context.profile.academicState, context.now),
    ],
    expiresAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
  };
}

export function sealCacheFingerprintV1(global: GlobalV1, context: ContextV1) {
  const temporal = sealCacheTemporalV1(context);
  return {
    fingerprint: publicationDigestV1([
      RULE_VERSION_V1,
      global,
      context.account.id,
      context.account.version,
      context.account.link,
      context.account.state,
      context.account.eligibility,
      context.account.blocked,
      context.account.closedAt,
      context.eligibility.dataVersion,
      context.eligibility.current,
      context.policy.classId,
      context.policy.policyVersion,
      context.profile.academicState,
      context.profile.result,
      temporal.signature,
    ]),
    expiresAt: temporal.expiresAt,
  };
}

/** No academic payload is selected on a hit. Fresh authorization/policy contexts are mandatory. */
export async function readSealCacheV1(
  tx: StudentPortalPostgresQueryV1,
  contexts: readonly ContextV1[],
) {
  const plans = new Map<string, SealCachePlanV1>();
  if (!contexts.length) return plans;
  const metadata =
    await tx.unsafe(`SELECT to_regclass('student_portal.seal_count_cache_v1')::text AS cache_table,
    jsonb_build_object('academicGeneration',r.academic_generation,'academicCounter',r.academic_counter::text,
      'linkGeneration',r.portal_link_generation,'linkCounter',r.portal_link_counter::text,
      'sourceGeneration',h.generation,'sourceRevision',h.revision::text,
      'controlVersion',c.version::text,'enabled',c.enabled,
      'policyEpoch',(SELECT max(version)::text FROM student_portal.setting WHERE scope_key='school:2026')) AS revisions
    FROM student_portal.academic_revision r
    LEFT JOIN student_portal.publication_source_head_v2 h ON h.academic_year=r.academic_year
    LEFT JOIN student_portal.publication_control_v2 c ON c.academic_year=r.academic_year
    WHERE r.academic_year=2026`);
  const global = globalV1.safeParse(metadata[0]?.revisions);
  // The legacy release model has no complete cheap token; it intentionally bypasses this cache.
  if (metadata.length !== 1 || !metadata[0]?.cache_table || !global.success) return plans;
  const ids = z
    .array(z.uuid())
    .max(400)
    .parse(contexts.map((context) => context.account.id));
  const rows = await tx.unsafe(
    `SELECT account_id,fingerprint,seals,computed_at,expires_at
    FROM student_portal.seal_count_cache_v1
    WHERE account_id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::text::jsonb))`,
    [JSON.stringify(ids)],
  );
  const stored = new Map(rows.map((row) => [row.account_id, row]));
  for (const context of contexts) {
    const { fingerprint, expiresAt } = sealCacheFingerprintV1(global.data, context);
    const write = {
      accountId: context.account.id,
      fingerprint,
      computedAt: context.now.toISOString(),
      expiresAt,
    };
    const row = stored.get(context.account.id);
    const instant = (input: unknown) => {
      if (input === null) return null;
      let value;
      if (input instanceof Date) {
        value = input;
      } else if (typeof input === 'string') {
        value = new Date(input);
      } else {
        value = null;
      }
      return value && Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
    };
    const saved = row
      ? writeV1.safeParse({
          accountId: row.account_id,
          fingerprint: row.fingerprint,
          seals: row.seals,
          computedAt: instant(row.computed_at),
          expiresAt: instant(row.expires_at),
        })
      : null;
    const hit =
      saved?.success &&
      saved.data.fingerprint === fingerprint &&
      Date.parse(saved.data.computedAt) <= context.now.getTime() &&
      (saved.data.expiresAt === null || Date.parse(saved.data.expiresAt) > context.now.getTime())
        ? { seals: saved.data.seals }
        : null;
    plans.set(context.account.id, { write, hit });
  }
  return plans;
}

/** Called only after the read-only snapshot commits. Cache failures never change a successful response. */
export async function saveSealCacheV1(
  sql: StudentPortalPostgresSqlV1,
  input: readonly SealCacheWriteV1[],
): Promise<void> {
  try {
    const checked = z.array(writeV1).max(400).safeParse(input);
    if (!checked.success || !checked.data.length) return;
    const unique = new Map<string, SealCacheWriteV1>();
    for (const write of checked.data) {
      const previous = unique.get(write.accountId);
      if (!previous || Date.parse(previous.computedAt) <= Date.parse(write.computedAt))
        unique.set(write.accountId, write);
    }
    await sql.unsafe(
      `INSERT INTO student_portal.seal_count_cache_v1(account_id,fingerprint,seals,computed_at,expires_at)
      SELECT x.account_id,x.fingerprint,x.seals,x.computed_at,x.expires_at
      FROM jsonb_to_recordset($1::text::jsonb) AS x(account_id uuid,fingerprint text,seals integer,computed_at timestamptz,expires_at timestamptz)
      JOIN student_portal.account a ON a.id=x.account_id
      ON CONFLICT(account_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,seals=EXCLUDED.seals,
        computed_at=EXCLUDED.computed_at,expires_at=EXCLUDED.expires_at
      WHERE seal_count_cache_v1.computed_at<=EXCLUDED.computed_at
        AND (seal_count_cache_v1.fingerprint,seal_count_cache_v1.seals,seal_count_cache_v1.expires_at)
          IS DISTINCT FROM (EXCLUDED.fingerprint,EXCLUDED.seals,EXCLUDED.expires_at)`,
      [
        JSON.stringify(
          [...unique.values()].map((write) => ({
            account_id: write.accountId,
            fingerprint: write.fingerprint,
            seals: write.seals,
            computed_at: write.computedAt,
            expires_at: write.expiresAt,
          })),
        ),
      ],
    );
  } catch {
    /* Optional derived data; never log identifiers, SQL, or raw database failures. */
  }
}
