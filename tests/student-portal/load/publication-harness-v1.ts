import { expect } from 'vitest';
import { adminResponseV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { selfResponseV1 } from '../../../shared/student-portal-contracts/self-v1';
import { createLocalPortalHarnessV1 } from './local-harness-v1';

/** Authentication setup is a synthetic session fixture; the separate load proof exercises full activation.
 * The caller activates scoped V2 publication first: prepared editions are the only published source. */
export async function proveWorkerPublicationV1(
  connectionString: string,
  accountId: string,
  token: string,
) {
  const harness = await createLocalPortalHarnessV1(connectionString);
  const scope = { kind: 'account', academicYear: 2026, accountId };
  try {
    const call = async (path: string, body?: unknown) => {
      const response = await harness.runtime.dispatchFetch(`https://aluno.escolaieda.com${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          origin: 'https://aluno.escolaieda.com',
          'content-type': 'application/json',
          cookie: `__Host-student_portal_session=${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const query = async (operation: string) =>
      adminResponseV1.parse(
        await call('/harness/admin/query', { contractVersion: 1, operation, scope, page: {} }),
      );
    const command = async (body: object) =>
      adminResponseV1.parse(
        await call('/harness/admin/command', {
          contractVersion: 1,
          idempotencyKey: crypto.randomUUID(),
          ...body,
        }),
      );
    const settings = await query('settings');
    if (settings.state !== 'settings') throw new Error('synthetic-publication-settings');
    const clock = Math.floor(Date.now() / 1000) * 1000;
    const at = (days: number) => new Date(clock + days * 86400_000).toISOString();
    expect(
      (
        await command({
          operation: 'settings-set',
          scope,
          expectedVersion: settings.settings.version,
          acknowledgeImmediateEffect: true,
          value: {
            accessEnabled: true,
            allowedPeriods: ['T1'],
            showPartials: true,
            autoUpdate: false,
            showFinalResult: false,
            calendar: {
              ...settings.settings.value.calendar,
              yearStartsAt: at(-60),
              t1EndsAt: at(-50),
              t2EndsAt: at(-40),
              t3EndsAt: at(-30),
              recoveriesStartAt: at(-20),
              yearEndsAt: at(30),
              finalDisclosureAt: at(-10),
              disclosure: { mode: 'single', at: at(-10), periods: ['T1'] },
            },
          },
        })
      ).state,
    ).toBe('committed');
    const publication = await query('publication');
    if (publication.state !== 'publication') throw new Error('synthetic-publication-query');
    const t1 = publication.items.find((item) => item.period === 'T1')!;
    expect(t1.availableRevision).not.toBeNull();
    expect(
      (
        await command({
          operation: 'publish',
          scope,
          period: 'T1',
          expectedVersion: t1.version,
          targetDataVersion: t1.availableRevision,
        })
      ).state,
    ).toBe('committed');
    const self = selfResponseV1.parse(await call('/api/student/me'));
    expect(self.state).toBe('ready');
    expect(self.subjects).toHaveLength(2);
    expect(
      self.subjects.every((subject) => subject.periods.every((period) => period.period === 'T1')),
    ).toBe(true);
    expect(
      self.subjects.some((subject) =>
        subject.periods.some((period) =>
          period.partials?.some(
            (partial) => partial.mark.kind === 'score' && partial.mark.value === 0,
          ),
        ),
      ),
    ).toBe(true);
    const current = await query('publication');
    if (current.state !== 'publication') throw new Error('synthetic-publication-query');
    expect(
      (
        await command({
          operation: 'unpublish',
          scope,
          period: 'T1',
          expectedVersion: current.items[0]!.version,
          confirmed: true,
        })
      ).state,
    ).toBe('committed');
    expect(selfResponseV1.parse(await call('/api/student/me')).state).toBe('no-publication');
  } finally {
    await harness.close();
  }
}
