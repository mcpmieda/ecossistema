import { SCHOOL_TIME_ZONE_V1 } from '../../../shared/school-time-zone-v1';
import { cleanupPortalLiveEventsV1 } from '../live/live-outbox-v1';
import { cleanupPortalV1 } from '../maintenance/retention-v1';
import type { PortalCompositionEnvV1 } from './config-v1';
import { portalDatabaseV1 } from './database-v1';

/** The retention cleanups run every this many minutes (the scheduled minute itself runs every minute). */
export const PORTAL_CLEANUP_EVERY_MINUTES_V1 = 10;

/** Midnight at the school: the pruning runs once a day. */
const PRUNE_CLOCK_V1 = new Intl.DateTimeFormat('en-GB', {
  timeZone: SCHOOL_TIME_ZONE_V1,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Retention is the only scheduled work (privacy, reconciliation leftovers and publication editions
 * no target can reach); scoped releases are read on demand. */
export async function portalScheduledV1(
  env: PortalCompositionEnvV1,
  scheduledTime?: number,
): Promise<void> {
  if (env.PORTAL_ENVIRONMENT !== 'production' || env.PORTAL_SERVING_ENABLED !== 'true') return;
  // The minute the cron was due, not when this run started: the request that carries the run or
  // the connection may push it past 00:01 and skip the day's pruning.
  const at = scheduledTime ?? Date.now();
  const pruneDue = PRUNE_CLOCK_V1.format(new Date(at)) === '00:00';
  // The retention finds almost nothing from one minute to the next: every 10 min is enough, and the
  // midnight pruning (00:00 at the school = 03:00 UTC, a multiple of 10) still runs.
  if (!pruneDue && Math.floor(at / 60_000) % PORTAL_CLEANUP_EVERY_MINUTES_V1 !== 0) return;
  try {
    await portalDatabaseV1(env, 'cleanup', async (sql) => {
      // Each family is its own single-statement transaction; sent together they share the round
      // trips to the database, and a failure does not suppress unrelated retention.
      const results = await Promise.allSettled(
        [
          () => cleanupPortalLiveEventsV1(sql),
          () => cleanupPortalV1(sql),
          () => sql.unsafe('SELECT student_portal.cleanup_reconciliation_credentials_v1(100)'),
          () => sql.unsafe('SELECT student_portal.cleanup_reconciliation_pending_v1(100)'),
        ].map(async (cleanup) => cleanup()),
      );
      let failed = results.some((result) => result.status === 'rejected');
      // Editions no publication target can reach any more. They pile up slowly and the pruning
      // holds the year lock (~130 ms), so it runs once a day, at midnight.
      if (pruneDue) {
        try {
          await sql.begin((tx) =>
            Promise.resolve(tx.unsafe('SELECT student_portal.prune_publication_source_v1()')),
          );
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error('student-portal-cleanup-unavailable');
    });
  } catch {
    /* The connection wrapper already emitted sanitized unavailable. */
  }
}
