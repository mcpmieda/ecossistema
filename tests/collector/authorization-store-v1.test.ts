// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CollectorAuthorizationStoreV1, type CollectorConsumptionV1, type CollectorSqlV1 } from '../../server/collector/authorization-store-v1';

let database: PGlite;
beforeAll(async () => {
  database = new PGlite();
  await database.exec(await readFile(new URL('../../migrations/collector/0001_device_authorization.sql', import.meta.url), 'utf8'));
}, 60_000);
afterAll(async () => { await database.close(); });
const ids = { grant: '11111111-1111-4111-8111-111111111111', device: '22222222-2222-4222-8222-222222222222',
  tenant: '33333333-3333-4333-8333-333333333333', actor: '44444444-4444-4444-8444-444444444444',
  client: '55555555-5555-4555-8555-555555555555', owner: '66666666-6666-4666-8666-666666666666' };
const proof: CollectorConsumptionV1 = { deviceId: ids.device, generation: 1, tenantId: ids.tenant,
  actorId: ids.actor, clientId: ids.client, keyThumbprint: 'x'.repeat(43), nonceHash: 'a'.repeat(64), maximumExpiry:Date.now()+300_000 };
async function fixture(directoryAgeSeconds = 0) {
  const db = database;
  await db.exec('TRUNCATE collector_auth.challenges, collector_auth.devices, collector_auth.oauth_grants');
  await db.query(`INSERT INTO collector_auth.oauth_grants(id,tenant_id,actor_id,client_id,generation,credential_version,
    origin_authenticated_at,encrypted_refresh,state,directory_authorized,directory_checked_at,directory_valid_until)
    SELECT $1,$2,$3,$4,1,0,t-interval '1 hour',$5,'active',true,
      t-($6::integer * interval '1 second'), t-($6::integer * interval '1 second')+interval '5 minutes'
    FROM (SELECT date_trunc('milliseconds',clock_timestamp()) AS t) stamp`,
  [ids.grant, ids.tenant, ids.actor, ids.client, 'synthetic-encrypted-refresh-placeholder', directoryAgeSeconds]);
  await db.query(`INSERT INTO collector_auth.devices(id,grant_id,tenant_id,actor_id,public_key,key_thumbprint,generation,created_at)
    VALUES($1,$2,$3,$4,$5,$6,1,clock_timestamp())`, [ids.device, ids.grant, ids.tenant, ids.actor,
    JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43), ext: true }), proof.keyThumbprint]);
  await db.query(`INSERT INTO collector_auth.challenges(nonce_hash,device_id,generation,key_thumbprint,issued_at,expires_at)
    SELECT $1,$2,1,$3,t,t+interval '60 seconds' FROM (SELECT clock_timestamp() AS t) stamp`,
  [proof.nonceHash, ids.device, proof.keyThumbprint]);
  const sql: CollectorSqlV1 = { query: async <T extends Record<string, unknown>>(statement: string, parameters: unknown[]) =>
    (await db.query<T>(statement, parameters)).rows };
  return { db, store: new CollectorAuthorizationStoreV1(sql) };
}

describe('collector owner-only candidate relational authority', () => {
  it('consumes a nonce once; concurrent callers have only one winner', async () => {
    const { store } = await fixture();
    const attempts = await Promise.all(Array.from({ length: 8 }, () => store.consumeAndAuthorize(proof)));
    expect(attempts.filter(value => value !== null)).toHaveLength(1);
    expect(await store.consumeAndAuthorize(proof)).toBeNull();
  });
  it('checks local revocation on every operation, without waiting for directory cache', async () => {
    const { store } = await fixture();
    await store.revokeDevice(ids.device, ids.tenant, ids.actor);
    expect(await store.consumeAndAuthorize(proof)).toBeNull();
  });
  it('pins account, client, generation, fingerprint and nonce', async () => {
    const { store } = await fixture();
    for (const changed of [{ ...proof, actorId: ids.client }, { ...proof, tenantId: ids.client },
      { ...proof, clientId: ids.actor }, { ...proof, generation: 2 }, { ...proof, keyThumbprint: 'z'.repeat(43) },
      { ...proof, nonceHash: 'b'.repeat(64) }]) expect(await store.consumeAndAuthorize(changed)).toBeNull();
    expect(await store.consumeAndAuthorize(proof)).not.toBeNull();
  });
  it('clips nearly expired directory evidence and denies expired evidence', async () => {
    const { db, store } = await fixture(295);
    const rows = await db.query<{ directory_valid_until: Date }>('SELECT directory_valid_until FROM collector_auth.oauth_grants');
    const expiry = rows.rows[0]!.directory_valid_until.getTime();
    expect(await store.consumeAndAuthorize(proof)).toBe(expiry);
    const expired = await fixture(301);
    expect(await expired.store.consumeAndAuthorize(proof)).toBeNull();
  });
  it('serializes refresh ownership and atomically replaces the secret under CAS', async () => {
    const { db, store } = await fixture();
    expect(await store.claimRefresh(ids.grant, 1, 0, ids.owner)).toBe(true);
    expect(await store.claimRefresh(ids.grant, 1, 0, ids.device)).toBe(false);
    const replacement = { grantId: ids.grant, generation: 1, version: 0, owner: ids.owner,
      encryptedReplacement: 'synthetic-encrypted-replacement-value', directoryCheckedAt: Date.now()-1000 };
    expect(await store.commitRefresh({ ...replacement, owner: ids.device })).toBe(false);
    expect(await store.commitRefresh(replacement)).toBe(true);
    expect(await store.commitRefresh(replacement)).toBe(false);
    const rows = await db.query<{ credential_version: number; encrypted_refresh: string; refresh_owner: string | null }>(
      'SELECT credential_version,encrypted_refresh,refresh_owner FROM collector_auth.oauth_grants');
    expect(rows.rows[0]).toEqual({ credential_version: 1, encrypted_refresh: replacement.encryptedReplacement, refresh_owner: null });
  });
  it('cannot reset authentication origin during refresh and wipes secret on suspension', async () => {
    const { db, store } = await fixture();
    await expect(db.query('UPDATE collector_auth.oauth_grants SET origin_authenticated_at=clock_timestamp()')).rejects.toThrow('collector-grant-origin-immutable');
    expect(await store.claimRefresh(ids.grant, 1, 0, ids.owner)).toBe(true);
    await store.suspendGrant(ids.grant, 1, ids.owner);
    expect(await store.consumeAndAuthorize(proof)).toBeNull();
    const rows = await db.query<{ encrypted_refresh: string | null; state: string; generation: number }>(
      'SELECT encrypted_refresh,state,generation FROM collector_auth.oauth_grants');
    expect(rows.rows[0]).toEqual({ encrypted_refresh: null, state: 'needs_reauth', generation: 2 });
  });
});
