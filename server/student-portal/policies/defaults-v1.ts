import { SCHOOL_TIME_ZONE_V1 } from '../../../shared/school-time-zone-v1';
import { DEFAULT_RISK_V1, settingsValueV1 } from '../../../shared/student-portal-contracts/policy-v1';

/** Explicit bootstrap only: no access, publication, institutional dates or runtime fallback. */
export function initialPolicyDefaultsV1() {
  return settingsValueV1.parse({
    accessEnabled: false, accessSchedule: null, showPartials: false, autoUpdate: false, showFinalResult: false, showTermClosing: false, termClosingConclusive: true, showFrequency: false, showSchedule: false, showIncidents: false, allowedPeriods: [],
    risk: DEFAULT_RISK_V1,
    calendar: {
      timezone: SCHOOL_TIME_ZONE_V1, enrollmentStartsAt: null, yearStartsAt: null, t1EndsAt: null,
      t2StartsAt: null, t2EndsAt: null, t3StartsAt: null, t3EndsAt: null, recoveriesStartAt: null, yearEndsAt: null, finalDisclosureAt: null,
      disclosure: { mode: 'single', at: null, periods: ['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'] },
    },
  });
}
