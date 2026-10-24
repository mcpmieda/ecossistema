import { z } from 'zod';
import {
  adminReadResponseV2,
  type AdminReadQueryV2,
} from '../../../shared/student-portal-contracts/admin-read-v2';
import { brilliantSealCountV1 } from '../../../shared/student-portal-contracts/brilliant-seal-v1';
import {
  StudentPortalPostgresPersistenceV1,
  type StudentPortalPostgresQueryV1,
  type StudentPortalPostgresSqlV1,
} from '../persistence/postgres-persistence-v1';
import { publicationContextV1 } from '../publication/self-projection-reader-v1';
import { scopedSelfV2 } from '../publication/scoped-self-v2';
import { ACCOUNT_JOIN_V1, ENROLLED_ACCOUNT_SQL_V1 } from './queries-v1';
import { sealContextsBatchV1, sealSourcesBatchV1 } from './seal-source-batch-v1';
import { readSealCacheV1, type SealCacheWriteV1 } from './seal-cache-v1';

const accountIdV1 = z.uuid();

type SealContextV1 = NonNullable<Awaited<ReturnType<typeof publicationContextV1>>>;
type SealPlansV1 = Awaited<ReturnType<typeof readSealCacheV1>>;

/** The accounts of the read: the chosen ones (school), the one record, or the class's enrolled. */
async function sealRowsV1(tx: StudentPortalPostgresQueryV1, query: AdminReadQueryV2) {
  const selectedIds = 'accountIds' in query ? query.accountIds : undefined;
  if (query.scope.kind === 'school' && selectedIds === undefined)
    throw new Error('student-portal-seals-invalid-request');
  let rows;
  if (query.scope.kind === 'school') {
    rows = z
      .array(z.uuid())
      .min(1)
      .max(400)
      .transform((ids) => ids.map((id) => id.toLowerCase()))
      .refine((ids) => new Set(ids).size === ids.length)
      .parse(selectedIds)
      .map((id) => ({ id: id.toLowerCase() }));
  } else if (query.scope.kind === 'account') {
    rows = [{ id: query.scope.accountId.toLowerCase() }];
  } else {
    rows = await tx.unsafe(
      `SELECT a.id ${ACCOUNT_JOIN_V1} WHERE a.academic_year=2026 AND a.closed_at IS NULL
            AND ${ENROLLED_ACCOUNT_SQL_V1} AND b.class_id=$1 ORDER BY a.id LIMIT 201`,
      [query.scope.classId],
    );
  }
  if (rows.length > (query.scope.kind === 'school' ? 400 : 200))
    throw new Error('student-portal-admin-scope-unavailable');
  return rows;
}

/** The publication contexts of every account, read 200 at a time. */
async function loadSealContextsV1(
  tx: StudentPortalPostgresQueryV1,
  rows: readonly Readonly<Record<string, unknown>>[],
  cacheTime: Date | undefined,
) {
  const contexts = new Map<string, SealContextV1>();
  for (let offset = 0; offset < rows.length; offset += 200) {
    const loaded = await sealContextsBatchV1(
      tx,
      rows.slice(offset, offset + 200).map((row) => accountIdV1.parse(row.id)),
      cacheTime,
    );
    for (const [id, context] of loaded) contexts.set(id, context);
  }
  return contexts;
}

/** One account in a batch read: the cached count when it still holds, else the projection's. */
async function batchSealsOfV1(
  tx: StudentPortalPostgresQueryV1,
  accountId: string,
  batch: {
    contexts: ReadonlyMap<string, SealContextV1>;
    plans: SealPlansV1 | null;
    sources: Awaited<ReturnType<typeof sealSourcesBatchV1>> | undefined;
    requestId: string;
    pendingCacheWrites: SealCacheWriteV1[] | undefined;
  },
): Promise<number | null> {
  const plan = batch.plans?.get(accountId);
  if (plan?.hit) return plan.hit.seals;
  const context = batch.contexts.get(accountId);
  if (!context) return null;
  try {
    const self = await scopedSelfV2(tx, context, batch.requestId, batch.sources);
    const seals =
      self.state === 'ready' ? brilliantSealCountV1(self.subjects, self.endedPeriods) : null;
    if (plan && batch.pendingCacheWrites) batch.pendingCacheWrites.push({ ...plan.write, seals });
    return seals;
  } catch {
    /* Unprepared publications expose no marks or seals, as in the one-account read. */
    return null;
  }
}

/**
 * Selos brilhantes in the ADM (owner request 29/09/2026): the count each student sees on the
 * Portal, from the same projection and the same shared rule, never a second rule. One record or
 * one class per read, inside the dispatcher's read-only snapshot; it writes nothing.
 */
export async function readSealsV1(
  tx: StudentPortalPostgresQueryV1,
  query: AdminReadQueryV2,
  requestId: string,
  now: Date,
  pendingCacheWrites?: SealCacheWriteV1[],
) {
  const rows = await sealRowsV1(tx, query);
  const sql: StudentPortalPostgresSqlV1 = {
    unsafe: (text, values) => tx.unsafe(text, values),
    begin: (run) => run(tx),
  };
  const items: { accountId: string; seals: number | null }[] = [];
  const useBatch =
    rows.length > 1 || pendingCacheWrites !== undefined || query.scope.kind === 'school';
  if (!useBatch) {
    for (const row of rows) {
      const accountId = accountIdV1.parse(row.id);
      items.push({ accountId, seals: await sealsOfV1(sql, tx, accountId, requestId) });
    }
    return sealsResponseV1(requestId, now, items);
  }
  const contexts = await loadSealContextsV1(
    tx,
    rows,
    pendingCacheWrites !== undefined ? now : undefined,
  );
  const plans = pendingCacheWrites ? await readSealCacheV1(tx, [...contexts.values()]) : null;
  for (let offset = 0; offset < rows.length; offset += 200) {
    const selected = rows.slice(offset, offset + 200);
    const misses = selected.flatMap((row) => {
      const context = contexts.get(accountIdV1.parse(row.id));
      return context && !plans?.get(context.account.id)?.hit ? [context] : [];
    });
    const sources = misses.length ? await sealSourcesBatchV1(tx, misses) : undefined;
    for (const row of selected) {
      const accountId = accountIdV1.parse(row.id);
      const seals = await batchSealsOfV1(tx, accountId, {
        contexts,
        plans,
        sources,
        requestId,
        pendingCacheWrites,
      });
      items.push({ accountId, seals });
    }
  }
  return sealsResponseV1(requestId, now, items);
}

function sealsResponseV1(
  requestId: string,
  now: Date,
  items: { accountId: string; seals: number | null }[],
) {
  return adminReadResponseV2.parse({
    contractVersion: 2,
    requestId,
    observedAt: now.toISOString(),
    state: 'seals-read',
    items,
  });
}

async function sealsOfV1(
  sql: StudentPortalPostgresSqlV1,
  tx: StudentPortalPostgresQueryV1,
  accountId: string,
  requestId: string,
): Promise<number | null> {
  const context = await new StudentPortalPostgresPersistenceV1(sql).transaction((store) =>
    publicationContextV1(sql, tx, store, accountId, false, false),
  );
  if (!context) return null;
  try {
    const self = await scopedSelfV2(tx, context, requestId);
    return self.state === 'ready' ? brilliantSealCountV1(self.subjects, self.endedPeriods) : null;
  } catch {
    // A student whose publication is not prepared sees no marks, hence no seals.
    return null;
  }
}
