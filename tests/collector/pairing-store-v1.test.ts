// @vitest-environment node
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {CollectorPairingStoreV1,collectorOpaqueHashV1} from '../../server/collector/pairing-store-v1';
import type {CollectorSqlV1} from '../../server/collector/authorization-store-v1';
import type {CollectorPublicKeyV1} from '../../server/collector/device-proof-v1';
import type {CollectorOAuthTransactionV1,CollectorRegistrationV1} from '../../server/collector/oauth-v1';
let db:PGlite,publicKey:CollectorPublicKeyV1;
beforeAll(async()=>{
  db=new PGlite();
  for(const name of ['0001_device_authorization.sql','0002_pending_pairings.sql'])
    await db.exec(await readFile(new URL('../../migrations/collector/'+name,import.meta.url),'utf8'));
  const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const exported=await crypto.subtle.exportKey('jwk',key.publicKey);
  publicKey={kty:'EC',crv:'P-256',x:exported.x!,y:exported.y!,ext:true};
},60_000);
afterAll(async()=>{await db.close();});
const id='11111111-1111-4111-8111-111111111111',tenant='22222222-2222-4222-8222-222222222222';
const actor='33333333-3333-4333-8333-333333333333',client='44444444-4444-4444-8444-444444444444';
async function fixture(age=0){
  await db.exec('TRUNCATE collector_auth.pairings,collector_auth.challenges,collector_auth.devices,collector_auth.oauth_grants');
  const sql:CollectorSqlV1={query:async<T extends Record<string,unknown>>(statement:string,parameters:unknown[])=>(await db.query<T>(statement,parameters)).rows};
  const store=new CollectorPairingStoreV1(sql),now=Date.now(),pollHash=await collectorOpaqueHashV1('synthetic-private-poll-secret');
  await store.create({id,publicKey,pollHash,displayCode:'123456',createdAt:now-age});
  const transaction:CollectorOAuthTransactionV1={pairingId:id,state:'collector.'+'s'.repeat(43),nonce:'n'.repeat(43),
    verifier:'v'.repeat(64),startedAt:now,exp:Math.floor((now+590_000)/1000)};
  const grantId=crypto.randomUUID(),binding={tenantId:tenant,actorId:actor,clientId:client,grantId,generation:1,version:0,originAuthenticatedAt:now-1000};
  const registration:CollectorRegistrationV1={pairingId:id,binding,encryptedRefresh:'synthetic-encrypted-placeholder-not-a-real-token',
    directory:{tenantId:tenant,actorId:actor,grantId,grantGeneration:1,originAuthenticatedAt:binding.originAuthenticatedAt,
      directoryCheckedAt:now,directoryValidUntil:now+300_000}};
  return {store,transaction,pollHash,registration};
}
describe('owner-only pending pairing and atomic initial registration',()=>{
  it('reveals neither public key nor poll secret in browser view and isolates polling',async()=>{
    const f=await fixture(),view=await f.store.browserView(id);
    expect(view?.display_code).toBe('123456');expect(view).not.toHaveProperty('poll_hash');expect(view).not.toHaveProperty('public_key');
    expect(await f.store.poll(id,'f'.repeat(64))).toBeNull();
    expect(await f.store.poll(id,f.pollHash)).toEqual({state:'pending',device_id:null});
  });
  it('requires explicit confirmation and atomically consumes exactly one callback',async()=>{
    const f=await fixture();expect(await f.store.consumeConfirmedTransaction(f.transaction)).toBe(false);
    expect(await f.store.confirm(f.transaction)).toBe(true);expect(await f.store.confirm(f.transaction)).toBe(false);
    const results=await Promise.all(Array.from({length:8},()=>f.store.consumeConfirmedTransaction(f.transaction)));
    expect(results.filter(Boolean)).toHaveLength(1);expect(await f.store.consumeConfirmedTransaction(f.transaction)).toBe(false);
  });
  it('binds callback state, nonce and pairing instead of accepting swapped transactions',async()=>{
    const f=await fixture();await f.store.confirm(f.transaction);
    expect(await f.store.consumeConfirmedTransaction({...f.transaction,state:'collector.'+'x'.repeat(43)})).toBe(false);
    expect(await f.store.consumeConfirmedTransaction({...f.transaction,nonce:'x'.repeat(43)})).toBe(false);
    expect(await f.store.consumeConfirmedTransaction({...f.transaction,pairingId:crypto.randomUUID()})).toBe(false);
    expect(await f.store.consumeConfirmedTransaction(f.transaction)).toBe(true);
  });
  it('registers one new grant/device with the confirmed key, preserving authentication origin',async()=>{
    const f=await fixture();await f.store.confirm(f.transaction);await f.store.consumeConfirmedTransaction(f.transaction);
    const results=await Promise.all(Array.from({length:8},()=>f.store.registerConfirmedPairing(f.registration)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const grant=(await db.query<{origin_authenticated_at:Date}>('SELECT origin_authenticated_at FROM collector_auth.oauth_grants')).rows;
    expect(grant).toHaveLength(1);expect(grant[0]!.origin_authenticated_at.getTime()).toBe(f.registration.binding.originAuthenticatedAt);
    const devices=(await db.query<{public_key:unknown}>('SELECT public_key FROM collector_auth.devices')).rows;
    expect(devices).toHaveLength(1);expect(devices[0]!.public_key).toEqual(publicKey);
    expect((await f.store.poll(id,f.pollHash))?.state).toBe('completed');
  });
  it('cancellation and expiry prevent registration and callback consumption',async()=>{
    const f=await fixture();await f.store.confirm(f.transaction);await f.store.consumeConfirmedTransaction(f.transaction);
    await f.store.cancel(id,f.pollHash);expect(await f.store.registerConfirmedPairing(f.registration)).toBe(false);
    expect((await f.store.poll(id,f.pollHash))?.state).toBe('cancelled');
    const expired=await fixture(601_000);expect(await expired.store.browserView(id)).toBeNull();
    expect(await expired.store.confirm(expired.transaction)).toBe(false);expect(await expired.store.poll(id,expired.pollHash)).toBeNull();
  });
  it('rolls back the new grant when device registration fails inside the same statement',async()=>{
    const f=await fixture();await f.store.confirm(f.transaction);await f.store.consumeConfirmedTransaction(f.transaction);
    await db.exec(`CREATE FUNCTION collector_auth.synthetic_reject_device() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic-device-failure'; END; $$;
      CREATE TRIGGER synthetic_reject_device BEFORE INSERT ON collector_auth.devices FOR EACH ROW EXECUTE FUNCTION collector_auth.synthetic_reject_device();`);
    try{
      await expect(f.store.registerConfirmedPairing(f.registration)).rejects.toThrow('synthetic-device-failure');
      expect((await db.query('SELECT id FROM collector_auth.oauth_grants')).rows).toHaveLength(0);
      expect((await f.store.poll(id,f.pollHash))?.state).toBe('exchanging');
    }finally{await db.exec('DROP TRIGGER synthetic_reject_device ON collector_auth.devices;DROP FUNCTION collector_auth.synthetic_reject_device();');}
  });
});
