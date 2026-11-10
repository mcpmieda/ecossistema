import { expect, it } from 'vitest';
import { createFrequencyAdminClientV2 } from '../../src/features/gradebook/import/frequency-client-v2';

/** The status the server sends since the automatic student report (29/10/2026). */
function serverStatus(extra: Record<string, unknown> = {}) {
  return {
    contractVersion: 2,
    state: 'ready',
    academicYear: 2026,
    serverTime: '2026-11-10T21:14:00.000Z',
    settings: {
      revision: 7,
      paused: false,
      schedule: null,
      reportSchedule: {
        timezone: 'America/Sao_Paulo',
        enabled: true,
        every: 60,
        from: '07:00',
        to: '17:00',
        weekdays: [1, 2, 3, 4, 5],
      },
    },
    studentReport: {
      observedAt: '2026-11-10T20:00:00.000Z',
      receivedAt: '2026-11-10T20:00:05.000Z',
      changedAt: '2026-11-10T19:00:00.000Z',
      outcome: 'applied',
      rows: 412,
      notes: {
        counts: { rows: 412, linked: 410, pending: 2 },
        differences: [],
        invalid: [
          {
            sourceRow: 9,
            name: 'ALUNO INVENTADO',
            classLabel: 'TURMA INVENTADA',
            field: 'nascimento',
            reason: 'data inválida',
          },
        ],
      },
    },
    lease: null,
    classes: [],
    devices: [],
    collections: [],
    conflicts: [],
    unresolved: [],
    failures: [],
    ...extra,
  };
}
const answer = (body: unknown) => async () => Response.json(body);

it('accepts the status with the student report and its agenda', async () => {
  const client = createFrequencyAdminClientV2(answer(serverStatus()));
  const status = await client.status(new AbortController().signal);
  expect(status.settings.reportSchedule?.every).toBe(60);
  expect(status.studentReport?.rows).toBe(412);
});

it('accepts the status before the first student report', async () => {
  const body = serverStatus({ studentReport: null });
  body.settings.reportSchedule = null as never;
  const client = createFrequencyAdminClientV2(answer(body));
  await expect(client.status(new AbortController().signal)).resolves.toMatchObject({
    studentReport: null,
  });
});

it('still refuses an unknown field', async () => {
  const client = createFrequencyAdminClientV2(answer(serverStatus({ surprise: true })));
  await expect(client.status(new AbortController().signal)).rejects.toMatchObject({
    state: 'unavailable',
  });
});
