import { cleanupPortalLiveEventsV1 } from '../live/live-outbox-v1';
import { cleanupPortalV1 } from '../maintenance/retention-v1';
import type { PortalCompositionEnvV1 } from './config-v1';
import { portalDatabaseV1 } from './database-v1';

/** Midnight in Brasília: the scheduled work runs every minute, the pruning once a day. */
const PRUNE_CLOCK_V1 = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Retention is the only scheduled work (privacy, reconciliation leftovers and publication editions
 * no target can reach); scoped releases are read on demand. */
export async function portalScheduledV1(env: PortalCompositionEnvV1): Promise<void> {
  if (env.PORTAL_ENVIRONMENT !== 'production' || env.PORTAL_SERVING_ENABLED !== 'true') return;
  try {
    await portalDatabaseV1(env, 'cleanup', async (sql) => {
      // Each family is its own single-statement transaction; sent together they share the round
      // trips to the database, and a failure does not suppress unrelated retention.
      const results = await Promise.allSettled([
        () => cleanupPortalLiveEventsV1(sql),
        () => cleanupPortalV1(sql),
        () => sql.unsafe('SELECT student_portal.cleanup_reconciliation_credentials_v1(100)'),
        () => sql.unsafe('SELECT student_portal.cleanup_reconciliation_pending_v1(100)'),
      ].map(async (cleanup) => cleanup()));
      let failed = results.some((result) => result.status === 'rejected');
      // Editions no publication target can reach any more (owner request of 14/10/2026). They pile
      // up slowly and the pruning holds the year lock (~130 ms), so it runs once a day, at midnight.
      if (PRUNE_CLOCK_V1.format(new Date()) === '00:00') {
        try {
          await sql.begin((tx) => Promise.resolve(tx.unsafe('SELECT student_portal.prune_publication_source_v1()')));
        } catch { failed = true; }
      }
      if (failed) throw new Error('student-portal-cleanup-unavailable');
    });
  } catch { /* The connection wrapper already emitted sanitized unavailable. */ }
}
