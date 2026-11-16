// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createSettingsQueryV1 } from '../../../../src/features/student-portal-admin/shared/settings-query-v1';
import type { AdminResponseV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import { SYNTHETIC_ID_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import { settingsFixtureV1 } from './fixtures-v1';
import { createPortalAdminClientV1 } from '../../../../src/features/student-portal-admin/shared/admin-client-v1';

const response = (): AdminResponseV1 => ({
  contractVersion: 1,
  requestId: SYNTHETIC_ID_V1,
  state: 'settings',
  settings: settingsFixtureV1(),
});

it('coalesces only in-flight settings and preserves independent consumer cancellation', async () => {
  const share = createSettingsQueryV1();
  let finish!: (value: AdminResponseV1) => void;
  let underlying!: AbortSignal;
  const load = vi.fn((signal: AbortSignal) => {
    underlying = signal;
    return new Promise<AdminResponseV1>((resolve) => {
      finish = resolve;
    });
  });
  const left = new AbortController();
  const first = share('school', load, left.signal);
  const second = share('school', load);
  const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(1);
  left.abort();
  await firstRejected;
  expect(underlying.aborted).toBe(false);
  finish(response());
  await expect(second).resolves.toMatchObject({ state: 'settings' });
  const third = share('school', load);
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(2);
  finish(response());
  await third;
});

it('does not share distinct scopes or retain rejected/cancelled requests', async () => {
  const share = createSettingsQueryV1();
  const abort = new AbortController();
  let underlying!: AbortSignal;
  const blocked = vi.fn((signal: AbortSignal) => {
    underlying = signal;
    return new Promise<AdminResponseV1>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  });
  const first = share('school', blocked, abort.signal);
  const rejection = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  abort.abort();
  await rejection;
  expect(underlying.aborted).toBe(true);
  const load = vi.fn(async () => response());
  await Promise.all([share('school', load), share('class', load)]);
  expect(load).toHaveBeenCalledTimes(2);
  const failed = vi.fn(async () => {
    throw new Error('synthetic failure');
  });
  await expect(share('school', failed)).rejects.toThrow('synthetic failure');
  await share('school', load);
  expect(load).toHaveBeenCalledTimes(3);
});

it.each(['committed', 'uncertain'] as const)(
  'does not share settings across a command attempt ending %s',
  async (outcome) => {
    const queries: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
    const commands: { resolve: (response: Response) => void; reject: (error: Error) => void }[] =
      [];
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    const client = createPortalAdminClientV1({
      fetch: (path, init) => {
        if (path.endsWith('/query'))
          return new Promise<Response>((resolve) => {
            queries.push({ signal: init.signal as AbortSignal, resolve });
          });
        return new Promise<Response>((resolve, reject) => {
          commands.push({ resolve, reject });
        });
      },
    });
    const query = {
      contractVersion: 1 as const,
      operation: 'settings' as const,
      scope: { kind: 'school' as const, academicYear: 2026 as const },
      page: { limit: 50 },
    };
    const before = client.query(query);
    await vi.waitFor(() => expect(queries).toHaveLength(1));
    const command = client.command({
      contractVersion: 1,
      operation: 'settings-set',
      scope: query.scope,
      expectedVersion: 7,
      idempotencyKey: SYNTHETIC_ID_V1,
      value: { accessEnabled: true },
      acknowledgeImmediateEffect: true,
    });
    const observedCommand = command.then(
      () => 'committed',
      () => 'uncertain',
    );
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    const during = client.query(query);
    await vi.waitFor(() => expect(queries).toHaveLength(2));
    if (outcome === 'committed')
      commands[0]!.resolve(
        json({
          contractVersion: 1,
          requestId: SYNTHETIC_ID_V1,
          state: 'committed',
          operationId: SYNTHETIC_ID_V1,
          version: 8,
        }),
      );
    else {
      commands[0]!.reject(new Error('synthetic uncertain response'));
      await vi.waitFor(() => expect(commands).toHaveLength(2));
      commands[1]!.reject(new Error('synthetic uncertain replay'));
    }
    expect(await observedCommand).toBe(outcome);
    const after = client.query(query);
    await vi.waitFor(() => expect(queries).toHaveLength(3));
    expect(queries.every((entry) => !entry.signal.aborted)).toBe(true);
    queries[0]!.resolve(json(response()));
    queries[1]!.resolve(json(response()));
    await Promise.all([before, during]);
    const sameAfter = client.query(query);
    await Promise.resolve();
    expect(queries).toHaveLength(3);
    queries[2]!.resolve(json({ ...response(), settings: { ...settingsFixtureV1(), version: 8 } }));
    for (const result of await Promise.all([after, sameAfter]))
      expect(result).toMatchObject({ state: 'settings', settings: { version: 8 } });
    expect(commands).toHaveLength(outcome === 'committed' ? 1 : 2);
  },
);

it('keeps pending settings isolated between client identities', async () => {
  const finish: ((response: Response) => void)[] = [];
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish.push(resolve);
      }),
  );
  const firstIdentity = createPortalAdminClientV1({ fetch });
  const secondIdentity = createPortalAdminClientV1({ fetch });
  const query = {
    contractVersion: 1 as const,
    operation: 'settings' as const,
    scope: { kind: 'school' as const, academicYear: 2026 as const },
    page: { limit: 50 },
  };
  const first = firstIdentity.query(query),
    second = secondIdentity.query(query);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  for (const resolve of finish)
    resolve(
      new Response(JSON.stringify(response()), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      }),
    );
  await Promise.all([first, second]);
});
