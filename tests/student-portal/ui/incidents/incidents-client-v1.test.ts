// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createStudentIncidentsClientV1 } from '../../../../src/features/student-portal/incidents/client-v1';
import { FrequencyClientErrorV2 } from '../../../../src/features/student-portal/frequency/client-v2';

const versionId = '33333333-3333-4333-8333-333333333333';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const incident = {
  id: versionId,
  kind: 'ADVERTÊNCIA',
  date: '2026-09-29',
  leave: null,
  description: 'Advertido(a) por usar o uniforme fora do padrão.',
  acknowledgedAt: null,
};
const stateOf = async (promise: Promise<unknown>) => {
  const error = await promise.catch((reason: unknown) => reason);
  return error instanceof FrequencyClientErrorV2 ? error.state : error;
};

it('reads the records same-origin, private and without a cache', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => json({ contractVersion: 1, state: 'ready', incidents: [incident] }));
  const client = createStudentIncidentsClientV1(fetcher);
  expect(await client.read(new AbortController().signal)).toEqual({ incidents: [incident] });
  const [path, init] = fetcher.mock.calls[0]!;
  expect(path).toBe('/api/student/incidents');
  expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(init?.method).toBeUndefined();
});

it('confirms one version with a JSON body naming only its id', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    json({ contractVersion: 1, state: 'ready', acknowledgedAt: '2026-10-29T12:40:00.000Z' }),
  );
  const client = createStudentIncidentsClientV1(fetcher);
  expect(await client.acknowledge(versionId)).toEqual({ acknowledgedAt: '2026-10-29T12:40:00.000Z' });
  const [path, init] = fetcher.mock.calls[0]!;
  expect(path).toBe('/api/student/incidents/acknowledge');
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  expect(JSON.parse(String(init?.body))).toEqual({ id: versionId });
});

it('turns each failure into its state, never a provider body', async () => {
  const failing = (response: Response) => createStudentIncidentsClientV1(async () => response);
  const signal = new AbortController().signal;
  expect(await stateOf(failing(json({}, 401)).read(signal))).toBe('unauthenticated');
  expect(await stateOf(failing(json({}, 403)).read(signal))).toBe('forbidden');
  expect(await stateOf(failing(json({ contractVersion: 1, state: 'changed' }, 409)).acknowledge(versionId))).toBe(
    'changed',
  );
  expect(await stateOf(failing(new Response('<html>', { headers: { 'Content-Type': 'text/html' } })).read(signal))).toBe(
    'unavailable',
  );
  // A record outside the contract (an extra field) is not shown.
  expect(
    await stateOf(
      failing(json({ contractVersion: 1, state: 'ready', incidents: [{ ...incident, teacher: 'X' }] })).read(signal),
    ),
  ).toBe('unavailable');
});
