import { PolicyServiceV1 } from '../../../server/student-portal/policies/policy-service-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
/** Explicit school authorization for synthetic authentication/publication fixtures only. */
export async function openSyntheticSchoolV1(sql: StudentPortalPostgresSqlV1) {
  const service = new PolicyServiceV1(sql);
  await service.initializeDefaults();
  const scope = { kind: 'school', academicYear: 2026 } as const;
  const current = await service.read(scope);
  const now = Math.floor(Date.now() / 1000) * 1000;
  const startsAt = new Date(now - 365 * 86400_000).toISOString();
  const endsAt = new Date(now + 365 * 86400_000).toISOString();
  await service.mutate('11111111-1111-4111-8111-111111111111', {
    contractVersion: 1,
    operation: 'settings-set',
    scope,
    expectedVersion: current.version,
    idempotencyKey: crypto.randomUUID(),
    acknowledgeImmediateEffect: true,
    value: {
      accessEnabled: true,
      calendar: {
        ...current.value.calendar,
        accessStartsAt: startsAt,
        accessEndsAt: endsAt,
        yearStartsAt: current.value.calendar.yearStartsAt ?? startsAt,
        yearEndsAt: current.value.calendar.yearEndsAt ?? endsAt,
      },
    },
  });
}
