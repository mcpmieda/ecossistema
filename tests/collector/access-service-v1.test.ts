// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { CollectorAccessServiceV1 } from '../../server/collector/access-service-v1';
import {
  CollectorAuthorizationStoreV1,
  type CollectorSqlV1,
} from '../../server/collector/authorization-store-v1';
import type { CollectorGrantBindingV1 } from '../../server/collector/directory-v1';
import { GraphError } from '../../server/graph/request-policy-v1';
import {
  collectorKeyThumbprintV1,
  collectorChallengeBytesV1,
  type CollectorPublicKeyV1,
  type CollectorChallengeV1,
} from '../../server/collector/device-proof-v1';
import { encodeBase64Url } from '../../server/auth/base64url';
import { frequencyPayloadHashV2 } from '../../shared/attendance-contracts/frequency-v2';
let db: PGlite;
beforeAll(async () => {
  vi.stubGlobal('crypto', webcrypto);
  db = new PGlite();
  await db.exec(
    await readFile(
      new URL('../../migrations/collector/0001_device_authorization.sql', import.meta.url),
      'utf8',
    ),
  );
  await db.exec(
    await readFile(
      new URL('../../migrations/collector/0002_pending_pairings.sql', import.meta.url),
      'utf8',
    ),
  );
  await db.exec(
    await readFile(
      new URL('../../migrations/collector/0015_session_authorization_v1.sql', import.meta.url),
      'utf8',
    ),
  );
}, 60_000);
afterAll(async () => db.close());
const ids = {
  tenant: '11111111-1111-4111-8111-111111111111',
  client: '22222222-2222-4222-8222-222222222222',
  actor: '33333333-3333-4333-8333-333333333333',
  grant: '44444444-4444-4444-8444-444444444444',
  device: '55555555-5555-4555-8555-555555555555',
  group: '66666666-6666-4666-8666-666666666666',
};
async function fixture(age = 0) {
  await db.exec(
    'TRUNCATE collector_auth.pairings,collector_auth.challenges,collector_auth.devices,collector_auth.oauth_grants',
  );
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const exported = await crypto.subtle.exportKey('jwk', key.publicKey);
  const publicKey: CollectorPublicKeyV1 = {
    kty: 'EC',
    crv: 'P-256',
    x: exported.x!,
    y: exported.y!,
    ext: true,
  };
  const fingerprint = await collectorKeyThumbprintV1(publicKey),
    now = Date.now();
  const source: CollectorGrantBindingV1 = {
    tenantId: ids.tenant,
    clientId: ids.client,
    actorId: ids.actor,
    grantId: ids.grant,
    generation: 1,
    version: 0,
    originAuthenticatedAt: now - 3600_000,
  };
  const checked = now - age;
  await db.query(
    `INSERT INTO collector_auth.oauth_grants(id,tenant_id,actor_id,client_id,generation,credential_version,
    origin_authenticated_at,state,directory_authorized,directory_checked_at,directory_valid_until)
    VALUES($1,$2,$3,$4,1,0,$5,'active',true,$6,$7)`,
    [
      ids.grant,
      ids.tenant,
      ids.actor,
      ids.client,
      new Date(source.originAuthenticatedAt).toISOString(),
      new Date(checked).toISOString(),
      new Date(checked + 300_000).toISOString(),
    ],
  );
  await db.query(
    `INSERT INTO collector_auth.devices(id,grant_id,tenant_id,actor_id,public_key,key_thumbprint,generation,created_at)
    VALUES($1,$2,$3,$4,$5,$6,1,clock_timestamp())`,
    [ids.device, ids.grant, ids.tenant, ids.actor, JSON.stringify(publicKey), fingerprint],
  );
  await db.query(
    `INSERT INTO collector_auth.pairings(id,public_key,key_thumbprint,poll_hash,display_code,created_at,expires_at,state,device_id,claimed_at)
    SELECT $1,d.public_key,d.key_thumbprint,$2,'123456',t,t+interval '10 minutes','completed',d.id,t
    FROM collector_auth.devices d CROSS JOIN (SELECT clock_timestamp() AS t) stamp WHERE d.id=$3`,
    [crypto.randomUUID(), 'a'.repeat(64), ids.device],
  );
  const sql: CollectorSqlV1 = {
    query: async <T extends Record<string, unknown>>(statement: string, parameters: unknown[]) =>
      (await db.query<T>(statement, parameters)).rows,
  };
  const store = new CollectorAuthorizationStoreV1(sql);
  const user = {
    id: ids.actor,
    accountEnabled: true,
    signInSessionsValidFromDateTime: new Date(now - 7200_000).toISOString(),
  };
  const directory = { user: user as unknown, groups: [ids.group], down: false };
  const graph = vi.fn(async (input: { path: string }) => {
    if (directory.down) throw new GraphError(503, 'synthetic-correlation');
    return input.path.endsWith('/checkMemberGroups') ? { value: directory.groups } : directory.user;
  });
  const service = new CollectorAccessServiceV1(
    store,
    { tenantId: ids.tenant, clientId: ids.client, adminGroupId: ids.group },
    { now: Date.now, graph },
  );
  async function sign(challenge: CollectorChallengeV1) {
    const prefix = new TextEncoder().encode('Ecossistema.Coletor.DeviceProof.v1\0'),
      body = collectorChallengeBytesV1(challenge);
    const data = new Uint8Array(prefix.byteLength + body.byteLength);
    data.set(prefix);
    data.set(body, prefix.byteLength);
    return encodeBase64Url(
      new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, data),
      ),
    );
  }
  return { service, store, graph, directory, sign, source };
}
describe('collector broker composition, with the directory read by the server itself', () => {
  it('uses current directory evidence, consumes proof once, and returns only a bounded receipt', async () => {
    const f = await fixture(),
      challenge = await f.service.challenge(ids.device);
    const input = {
      deviceId: ids.device,
      nonce: challenge.nonce,
      signature: await f.sign(challenge),
    };
    const reply = await f.service.authorize(input);
    expect(reply.contractVersion).toBe(2);
    expect(reply.capability).toBe('frequency.collector.use');
    expect(Date.parse(reply.expiresAt)).toBeLessThanOrEqual(Date.parse(reply.directoryValidUntil));
    expect(f.graph).not.toHaveBeenCalled();
    await expect(f.service.authorize(input)).rejects.toThrow('denied');
  });
  it('renews expired evidence silently, preserving the origin and stepping the version', async () => {
    const f = await fixture(301_000),
      challenge = await f.service.challenge(ids.device);
    const reply = await f.service.authorize({
      deviceId: ids.device,
      nonce: challenge.nonce,
      signature: await f.sign(challenge),
    });
    expect(f.graph).toHaveBeenCalledTimes(2);
    const snapshot = await f.store.snapshot(ids.device);
    expect(snapshot?.credential_version).toBe(1);
    const original = snapshot?.origin_authenticated_at as Date;
    expect(original.getTime()).toBe(f.source.originAuthenticatedAt);
    expect(Date.parse(reply.expiresAt)).toBeLessThanOrEqual(Date.parse(reply.directoryValidUntil));
  });
  it('renews evidence that is about to expire, so the following requests stay authorized', async () => {
    const f = await fixture(250_000),
      challenge = await f.service.challenge(ids.device); // 50 s left.
    const reply = await f.service.authorize({
      deviceId: ids.device,
      nonce: challenge.nonce,
      signature: await f.sign(challenge),
    });
    expect(f.graph).toHaveBeenCalledTimes(2);
    expect(Date.parse(reply.directoryValidUntil) - Date.now()).toBeGreaterThan(240_000);
  });
  it('keeps evidence that is still valid when the directory cannot be read', async () => {
    const f = await fixture(250_000);
    f.directory.down = true;
    const challenge = await f.service.challenge(ids.device);
    const reply = await f.service.authorize({
      deviceId: ids.device,
      nonce: challenge.nonce,
      signature: await f.sign(challenge),
    });
    expect(Date.parse(reply.directoryValidUntil) - Date.now()).toBeLessThan(60_000);
    expect((await f.store.snapshot(ids.device))?.state).toBe('active');
  });
  it('an outage after the evidence ran out is unavailable and ends no grant', async () => {
    const f = await fixture(301_000);
    f.directory.down = true;
    const challenge = await f.service.challenge(ids.device);
    await expect(
      f.service.authorize({
        deviceId: ids.device,
        nonce: challenge.nonce,
        signature: await f.sign(challenge),
      }),
    ).rejects.toThrow('unavailable');
    expect((await f.store.snapshot(ids.device))?.state).toBe('active');
  });
  it.each([
    ['left the admin group', (d: { groups: string[] }) => (d.groups = [])],
    [
      'was disabled',
      (d: { user: unknown }) => (d.user = { ...(d.user as object), accountEnabled: false }),
    ],
  ])('asks for a new authorization when the person %s', async (_name, change) => {
    const f = await fixture(301_000);
    change(f.directory);
    const challenge = await f.service.challenge(ids.device);
    await expect(
      f.service.authorize({
        deviceId: ids.device,
        nonce: challenge.nonce,
        signature: await f.sign(challenge),
      }),
    ).rejects.toThrow('reauthentication-required');
    expect((await f.store.snapshot(ids.device))?.state).toBe('needs_reauth');
    await expect(f.service.challenge(ids.device)).rejects.toThrow('denied');
  });
  it('checks local revocation even while directory evidence remains current', async () => {
    const f = await fixture(),
      challenge = await f.service.challenge(ids.device),
      signature = await f.sign(challenge);
    await f.store.revokeDevice(ids.device, ids.tenant, ids.actor);
    await expect(
      f.service.authorize({ deviceId: ids.device, nonce: challenge.nonce, signature }),
    ).rejects.toThrow('denied');
    expect(f.graph).not.toHaveBeenCalled();
  });
  it('binds real signatures and one-use nonce to the frequency payload and purpose', async () => {
    const f = await fixture();
    const payload = {
      operation: 'lease',
      academicYear: 2026,
      requestId: crypto.randomUUID(),
      durationSeconds: 60,
    };
    const challenge = await f.service.challenge(
      ids.device,
      'collector-frequency',
      await frequencyPayloadHashV2(payload),
    );
    const proof = {
      deviceId: ids.device,
      nonce: challenge.nonce,
      signature: await f.sign(challenge),
    };
    await expect(
      f.service.authorizeFrequency(proof, { ...payload, durationSeconds: 61 }),
    ).rejects.toThrow('denied');
    await expect(f.service.authorize(proof)).rejects.toThrow('denied');
    const actor = await f.service.authorizeFrequency(proof, payload);
    expect(actor).toEqual({
      mode: 'device',
      actorId: ids.actor,
      tenantId: ids.tenant,
      deviceId: ids.device,
      deviceGeneration: 1,
      keyThumbprint: challenge.keyThumbprint,
    });
    expect(f.graph).not.toHaveBeenCalled();
    await expect(f.service.authorizeFrequency(proof, payload)).rejects.toThrow('denied');
  });
  it('rejects frequency authorization after local revocation with still-current directory evidence', async () => {
    const f = await fixture(),
      payload = { operation: 'status', academicYear: 2026 };
    const challenge = await f.service.challenge(
      ids.device,
      'collector-frequency',
      await frequencyPayloadHashV2(payload),
    );
    const proof = {
      deviceId: ids.device,
      nonce: challenge.nonce,
      signature: await f.sign(challenge),
    };
    await f.store.revokeDevice(ids.device, ids.tenant, ids.actor);
    await expect(f.service.authorizeFrequency(proof, payload)).rejects.toThrow('denied');
    expect(f.graph).not.toHaveBeenCalled();
  });
});
