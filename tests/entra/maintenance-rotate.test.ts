// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  addRotationCertificate,
  finalizeRotation,
  MaintenanceRotationError,
  removeExactCertificate,
} from '../../scripts/entra/maintenance-rotate';

const TOKEN = 'synthetic-token';
const WEB_OBJECT_ID = '11111111-1111-4111-8111-111111111111';
const OLD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OLD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GRAPH_NEW_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REASSIGNED_OLD_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const REASSIGNED_OLD_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const REASSIGNED_NEW_A = '99999999-9999-4999-8999-999999999999';

function key(keyId: string, slot: 'A' | 'B', startDateTime: string, suffix: string) {
  return {
    keyId,
    type: 'AsymmetricX509Cert',
    usage: 'Verify',
    key: Buffer.from(`CERT-${suffix}`).toString('base64'),
    displayName: `automatic-web-slot-${slot}-${startDateTime}`,
    startDateTime,
    endDateTime: '2027-06-01T00:00:00.000Z',
    customKeyIdentifier: Buffer.from(`THUMB-${suffix}`).toString('base64'),
  };
}

type StoredKey = ReturnType<typeof key>;
type PatchKey = Omit<StoredKey, 'keyId' | 'startDateTime' | 'endDateTime'> & {
  keyId?: string;
  startDateTime?: string;
  endDateTime?: string;
};

function application(keys: StoredKey[]) {
  return {
    id: WEB_OBJECT_ID,
    appId: '78185e20-c824-4acc-9ccd-41b9f7509a6f',
    displayName: 'Ecossistema Escolar - Web',
    keyCredentials: keys,
    passwordCredentials: [],
  };
}

function reassignedKeyId(displayName: string): string {
  if (displayName.includes('2026-09-19T13:00:00.000Z')) return REASSIGNED_NEW_A;
  if (displayName.includes('slot-A-2026-08-24T16:00:05.533Z')) return REASSIGNED_OLD_A;
  if (displayName.includes('slot-B-2026-08-24T16:02:00.054Z')) return REASSIGNED_OLD_B;
  return GRAPH_NEW_A;
}

function hydratePatchKey(value: PatchKey): StoredKey {
  const startDateTime =
    value.startDateTime ??
    value.displayName.match(/^automatic-web-slot-[AB]-(.+)$/u)?.[1] ??
    '2026-01-01T00:00:00.000Z';
  return {
    keyId: value.keyId ?? reassignedKeyId(value.displayName),
    type: 'AsymmetricX509Cert',
    usage: 'Verify',
    key: value.key,
    displayName: value.displayName,
    startDateTime,
    endDateTime: value.endDateTime ?? '2027-06-01T00:00:00.000Z',
    customKeyIdentifier:
      value.customKeyIdentifier ?? Buffer.from(`THUMB-${value.displayName}`).toString('base64'),
  };
}

function statefulFetcher(
  initialKeys: StoredKey[],
  options: { staleReadsAfterPatch?: number } = {},
) {
  let keys = structuredClone(initialKeys);
  let staleSnapshot: StoredKey[] | null = null;
  let staleReadsRemaining = 0;
  const patchBodies: Array<{ keyCredentials: PatchKey[] }> = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    if (method === 'GET' && url.includes(`/applications/${WEB_OBJECT_ID}`)) {
      if (staleSnapshot && staleReadsRemaining > 0) {
        staleReadsRemaining -= 1;
        return Response.json(application(staleSnapshot));
      }
      return Response.json(application(keys));
    }
    if (method === 'PATCH' && url.endsWith(`/applications/${WEB_OBJECT_ID}`)) {
      const body = JSON.parse(String(init?.body)) as { keyCredentials: PatchKey[] };
      patchBodies.push(structuredClone(body));
      staleSnapshot = structuredClone(keys);
      staleReadsRemaining = options.staleReadsAfterPatch ?? 0;
      keys = body.keyCredentials.map(hydratePatchKey);
      return new Response(null, { status: 204 });
    }
    return new Response('unexpected', { status: 404 });
  });
  return {
    fetcher,
    keys: () => structuredClone(keys),
    patchBodies: () => structuredClone(patchBodies),
  };
}

describe('Maintenance certificate rotation', () => {
  it('adds only to the inactive slot using the Graph-supported preservation shape', async () => {
    const state = statefulFetcher([
      key(OLD_A, 'A', '2026-08-24T16:00:05.533Z', 'old-a'),
      key(OLD_B, 'B', '2026-08-24T16:02:00.054Z', 'old-b'),
    ]);

    const result = await addRotationCertificate({
      accessToken: TOKEN,
      target: 'web',
      slot: 'A',
      objectId: WEB_OBJECT_ID,
      certificateDerBase64: Buffer.from('NEW-CERT').toString('base64'),
      displayName: 'automatic-web-slot-A-2026-09-19T13:00:00.000Z',
      startDateTime: '2026-09-19T13:00:00.000Z',
      endDateTime: '2027-03-18T13:00:00.000Z',
      fetcher: state.fetcher,
    });

    expect(result).toMatchObject({
      status: 'added',
      target: 'web',
      slot: 'A',
      previousActiveSlot: 'B',
      previousActiveKeyId: OLD_B,
      staleSameSlotKeyId: OLD_A,
      newGraphKeyId: REASSIGNED_NEW_A,
    });
    expect(state.keys()).toHaveLength(3);
    expect(state.keys().map((value) => value.displayName)).toEqual([
      'automatic-web-slot-A-2026-08-24T16:00:05.533Z',
      'automatic-web-slot-B-2026-08-24T16:02:00.054Z',
      'automatic-web-slot-A-2026-09-19T13:00:00.000Z',
    ]);

    const patch = state.patchBodies()[0]!;
    expect(patch.keyCredentials).toHaveLength(3);
    for (const preserved of patch.keyCredentials.slice(0, 2)) {
      expect(preserved).not.toHaveProperty('keyId');
      expect(preserved).not.toHaveProperty('startDateTime');
      expect(preserved).not.toHaveProperty('endDateTime');
      expect(preserved).toMatchObject({
        type: 'AsymmetricX509Cert',
        usage: 'Verify',
      });
    }
    expect(patch.keyCredentials[2]).toMatchObject({
      type: 'AsymmetricX509Cert',
      usage: 'Verify',
      startDateTime: '2026-09-19T13:00:00.000Z',
      endDateTime: '2027-03-18T13:00:00.000Z',
    });
  });

  it('fails closed if the requested slot is currently active', async () => {
    const state = statefulFetcher([
      key(OLD_A, 'A', '2026-08-24T16:00:05.533Z', 'old-a'),
      key(OLD_B, 'B', '2026-08-24T16:02:00.054Z', 'old-b'),
    ]);

    await expect(
      addRotationCertificate({
        accessToken: TOKEN,
        target: 'web',
        slot: 'B',
        objectId: WEB_OBJECT_ID,
        certificateDerBase64: Buffer.from('NEW-CERT').toString('base64'),
        displayName: 'automatic-web-slot-B-2026-09-19T13:00:00.000Z',
        startDateTime: '2026-09-19T13:00:00.000Z',
        endDateTime: '2027-03-18T13:00:00.000Z',
        fetcher: state.fetcher,
      }),
    ).rejects.toMatchObject({ stage: 'requested-slot-is-not-inactive' });
    expect(state.keys()).toHaveLength(2);
    expect(state.patchBodies()).toHaveLength(0);
  });

  it('finalizes by removing only the older certificate from the rotated slot', async () => {
    const state = statefulFetcher(
      [
        key(OLD_A, 'A', '2026-08-24T16:00:05.533Z', 'old-a'),
        key(OLD_B, 'B', '2026-08-24T16:02:00.054Z', 'old-b'),
        key(GRAPH_NEW_A, 'A', '2026-09-19T13:00:00.000Z', 'new-a'),
      ],
      { staleReadsAfterPatch: 2 },
    );
    const pause = vi.fn(async () => undefined);

    const result = await finalizeRotation({
      accessToken: TOKEN,
      target: 'web',
      slot: 'A',
      objectId: WEB_OBJECT_ID,
      fetcher: state.fetcher,
      pause,
    });

    expect(result).toMatchObject({
      status: 'finalized',
      retainedNewKeyId: REASSIGNED_NEW_A,
      retainedRollbackSlot: 'B',
      retainedRollbackKeyId: REASSIGNED_OLD_B,
      removedStaleKeyId: OLD_A,
    });
    expect(state.keys().map((value) => value.displayName)).toEqual([
      'automatic-web-slot-B-2026-08-24T16:02:00.054Z',
      'automatic-web-slot-A-2026-09-19T13:00:00.000Z',
    ]);
    expect(pause).toHaveBeenCalledTimes(2);
  });

  it('can remove the exact newly-added certificate during pre-secret rollback', async () => {
    const state = statefulFetcher([
      key(OLD_A, 'A', '2026-08-24T16:00:05.533Z', 'old-a'),
      key(OLD_B, 'B', '2026-08-24T16:02:00.054Z', 'old-b'),
      key(GRAPH_NEW_A, 'A', '2026-09-19T13:00:00.000Z', 'new-a'),
    ]);

    const result = await removeExactCertificate({
      accessToken: TOKEN,
      target: 'web',
      objectId: WEB_OBJECT_ID,
      keyId: GRAPH_NEW_A,
      fetcher: state.fetcher,
    });

    expect(result).toEqual({ status: 'removed', remainingCertificates: 2 });
    expect(state.keys().map((value) => value.displayName)).toEqual([
      'automatic-web-slot-A-2026-08-24T16:00:05.533Z',
      'automatic-web-slot-B-2026-08-24T16:02:00.054Z',
    ]);
  });

  it('waits for Graph reads to converge after removing an orphan certificate', async () => {
    const state = statefulFetcher(
      [
        key(OLD_A, 'A', '2026-08-24T16:00:05.533Z', 'old-a'),
        key(OLD_B, 'B', '2026-08-24T16:02:00.054Z', 'old-b'),
        key(GRAPH_NEW_A, 'A', '2026-09-19T13:00:00.000Z', 'new-a'),
      ],
      { staleReadsAfterPatch: 2 },
    );
    const pause = vi.fn(async () => undefined);

    const result = await removeExactCertificate({
      accessToken: TOKEN,
      target: 'web',
      objectId: WEB_OBJECT_ID,
      keyId: GRAPH_NEW_A,
      fetcher: state.fetcher,
      pause,
    });

    expect(result).toEqual({ status: 'removed', remainingCertificates: 2 });
    expect(pause).toHaveBeenCalledTimes(2);
    expect(state.keys().map((value) => value.displayName)).toEqual([
      'automatic-web-slot-A-2026-08-24T16:00:05.533Z',
      'automatic-web-slot-B-2026-08-24T16:02:00.054Z',
    ]);
  });

  it('does not leak provider bodies through rotation errors', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response('provider-secret-MUST-NOT-LEAK', { status: 403 }),
    );
    try {
      await removeExactCertificate({
        accessToken: TOKEN,
        target: 'web',
        objectId: WEB_OBJECT_ID,
        keyId: GRAPH_NEW_A,
        fetcher,
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(MaintenanceRotationError);
      expect(String(error)).not.toContain('MUST-NOT-LEAK');
      expect(String(error)).not.toContain(TOKEN);
    }
  });
});
