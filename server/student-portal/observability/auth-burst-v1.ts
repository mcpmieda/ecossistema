import { createHash } from 'node:crypto';
import {
  emitPortalAuthBurstMetricV1,
  type PortalAuthBurstMetricV1,
} from './metrics-v1';

export type AuthBurstGuardV1 = (opaqueSubject: string, networkSubject?: string) => Promise<boolean>;
type BurstMetricSinkV1 = (metric: PortalAuthBurstMetricV1) => void;

/** Per-location burst protection complements the durable PG counter; never use IP as identity.
 * I supplies account-unique namespaces with global 3000/minute and subject 30/minute limits.
 * The global limit admits the whole school's first access at once (28/09/2026).
 * With a network subject (the anonymous peer), that 3000/minute budget is per peer, so one
 * client repeating a valid QR cannot spend every family's entry. Without one (load harness
 * only) it stays a single location-wide key.
 * https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 */
export function portalAuthBurstV1(
  global: Pick<RateLimit, 'limit'>,
  subject: Pick<RateLimit, 'limit'>,
  emit: BurstMetricSinkV1 = emitPortalAuthBurstMetricV1,
): AuthBurstGuardV1 {
  return async (opaqueSubject, networkSubject) => {
    if (opaqueSubject.length > 512 || (networkSubject !== undefined && (!networkSubject || networkSubject.length > 512))) {
      emit({ event: 'student-portal-auth-burst-v1', outcome: 'invalid-subject' });
      return false;
    }
    try {
      const globalKey = networkSubject === undefined ? 'student-portal-auth-v1' : createHash('sha256')
        .update('student-portal-auth-v1\0network\0')
        .update(networkSubject)
        .digest('hex');
      const globalResult = await global.limit({ key: globalKey });
      if (typeof globalResult?.success !== 'boolean') throw new Error('invalid-rate-limit-response');
      if (!globalResult.success) {
        emit({ event: 'student-portal-auth-burst-v1', outcome: 'global-limited' });
        return false;
      }
      const key = createHash('sha256')
        .update('student-portal-burst-v1\0')
        .update(opaqueSubject)
        .digest('hex');
      const subjectResult = await subject.limit({ key });
      if (typeof subjectResult?.success !== 'boolean') throw new Error('invalid-rate-limit-response');
      if (!subjectResult.success) {
        emit({ event: 'student-portal-auth-burst-v1', outcome: 'subject-limited' });
        return false;
      }
      emit({ event: 'student-portal-auth-burst-v1', outcome: 'allowed' });
      return true;
    } catch {
      emit({ event: 'student-portal-auth-burst-v1', outcome: 'unavailable' });
      throw new Error('student-portal-rate-limit-unavailable');
    }
  };
}
