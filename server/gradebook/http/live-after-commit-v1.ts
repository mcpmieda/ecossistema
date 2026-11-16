import type { Session } from '../../auth/session';
import type { RuntimeEnv } from '../../env';
import type { PortalAdminServiceBindingV1 } from '../../../shared/student-portal-contracts/ports-v1';
import { authorizeGradebookRuntimeV1 } from '../authorization-v1';

export type GradebookAfterCommitV1 = (session: Session) => void;

/** A delivery hint after commit, never a second writer. The transactional outbox and cron
 * remain authoritative if a mixed deployment or an unavailable binding drops this hint. */
export function gradebookAfterCommitV1(
  env: RuntimeEnv,
  waitUntil: (work: Promise<unknown>) => void,
): GradebookAfterCommitV1 {
  return (session) => {
    try {
      authorizeGradebookRuntimeV1(session);
      const binding = env.PORTAL_SERVICE as PortalAdminServiceBindingV1 | undefined;
      if (!binding?.drainLive) return;
      const context = {
        actorId: session.oid,
        tenantId: env.TENANT_ID,
        requestId: crypto.randomUUID(),
        authenticatedAt: new Date().toISOString(),
        capability: 'gradebook.persistence.admin' as const,
      };
      waitUntil(
        Promise.resolve()
          .then(() => binding.drainLive!(context))
          .catch(() => undefined),
      );
    } catch {
      // Failure to notify cannot turn a committed academic write into an HTTP failure.
    }
  };
}
