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
  const sql: StudentPortalPostgresSqlV1 = {
    unsafe: (text, values) => tx.unsafe(text, values),
    begin: (run) => run(tx),
  };
  const items: { accountId: string; seals: number | null }[] = [];
  const useBatch =
    rows.length > 1 || pendingCacheWrites !== undefined || query.scope.kind === 'school';
  const contexts = useBatch
    ? new Map<string, NonNullable<Awaited<ReturnType<typeof publicationContextV1>>>>()
    : null;
  if (contexts)
    for (let offset = 0; offset < rows.length; offset += 200) {
      const loaded = await sealContextsBatchV1(
        tx,
        rows.slice(offset, offset + 200).map((row) => accountIdV1.parse(row.id)),
        pendingCacheWrites !== undefined ? now : undefined,
      );
      for (const [id, context] of loaded) contexts.set(id, context);
    }
  const plans =
    contexts && pendingCacheWrites ? await readSealCacheV1(tx, [...contexts.values()]) : null;
  for (let offset = 0; offset < rows.length; offset += 200) {
    const selected = rows.slice(offset, offset + 200);
    const misses = contexts
      ? selected.flatMap((row) => {
          const context = contexts.get(accountIdV1.parse(row.id));
          return context && !plans?.get(context.account.id)?.hit ? [context] : [];
        })
      : [];
    const sources = contexts && misses.length ? await sealSourcesBatchV1(tx, misses) : undefined;
    for (const row of selected) {
      const accountId = accountIdV1.parse(row.id);
      if (!contexts)
        items.push({ accountId, seals: await sealsOfV1(sql, tx, accountId, requestId) });
      else {
        const plan = plans?.get(accountId);
        if (plan?.hit) {
          items.push({ accountId, seals: plan.hit.seals });
          continue;
        }
        const context = contexts.get(accountId);
        let seals: number | null = null;
        if (context) {
          try {
            const self = await scopedSelfV2(tx, context, requestId, sources);
            seals =
              self.state === 'ready'
                ? brilliantSealCountV1(self.subjects, self.endedPeriods)
                : null;
            if (plan && pendingCacheWrites) pendingCacheWrites.push({ ...plan.write, seals });
          } catch {
            /* Unprepared publications expose no marks or seals, as in the one-account read. */
          }
        }
        items.push({ accountId, seals });
      }
    }
  }
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
