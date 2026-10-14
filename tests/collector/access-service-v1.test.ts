// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { CollectorAccessServiceV1 } from '../../server/collector/access-service-v1';
import { CollectorAuthorizationStoreV1,type CollectorSqlV1 } from '../../server/collector/authorization-store-v1';
import { CollectorRefreshCipherV1,type CollectorGrantBindingV1 } from '../../server/collector/refresh-cipher-v1';
import { collectorKeyThumbprintV1,collectorChallengeBytesV1,type CollectorPublicKeyV1,type CollectorChallengeV1 } from '../../server/collector/device-proof-v1';
import { encodeBase64Url } from '../../server/auth/base64url';
import { frequencyPayloadHashV2 } from '../../shared/attendance-contracts/frequency-v2';
let db:PGlite;
beforeAll(async()=>{vi.stubGlobal('crypto',webcrypto);db=new PGlite();
  await db.exec(await readFile(new URL('../../migrations/collector/0001_device_authorization.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../migrations/collector/0002_pending_pairings.sql',import.meta.url),'utf8'));},60_000);
afterAll(async()=>db.close());
const ids={tenant:'11111111-1111-4111-8111-111111111111',client:'22222222-2222-4222-8222-222222222222',
  actor:'33333333-3333-4333-8333-333333333333',grant:'44444444-4444-4444-8444-444444444444',
  device:'55555555-5555-4555-8555-555555555555',group:'66666666-6666-4666-8666-666666666666'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
async function fixture(age=0) {
  await db.exec('TRUNCATE collector_auth.pairings,collector_auth.challenges,collector_auth.devices,collector_auth.oauth_grants');
  const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const exported=await crypto.subtle.exportKey('jwk',key.publicKey);
  const publicKey:CollectorPublicKeyV1={kty:'EC',crv:'P-256',x:exported.x!,y:exported.y!,ext:true};
  const fingerprint=await collectorKeyThumbprintV1(publicKey),now=Date.now();
  const source:CollectorGrantBindingV1={tenantId:ids.tenant,clientId:ids.client,actorId:ids.actor,grantId:ids.grant,
    generation:1,version:0,originAuthenticatedAt:now-3600_000};
  const cipher=await CollectorRefreshCipherV1.fromDedicatedKey(new Uint8Array(32).fill(9));
  const encrypted=await cipher.encrypt('synthetic-private-refresh-token',source);
  const checked=now-age;
  await db.query(`INSERT INTO collector_auth.oauth_grants(id,tenant_id,actor_id,client_id,generation,credential_version,
    origin_authenticated_at,encrypted_refresh,state,directory_authorized,directory_checked_at,directory_valid_until)
    VALUES($1,$2,$3,$4,1,0,$5,$6,'active',true,$7,$8)`,[ids.grant,ids.tenant,ids.actor,ids.client,
    new Date(source.originAuthenticatedAt).toISOString(),encrypted,new Date(checked).toISOString(),new Date(checked+300_000).toISOString()]);
  await db.query(`INSERT INTO collector_auth.devices(id,grant_id,tenant_id,actor_id,public_key,key_thumbprint,generation,created_at)
    VALUES($1,$2,$3,$4,$5,$6,1,clock_timestamp())`,[ids.device,ids.grant,ids.tenant,ids.actor,JSON.stringify(publicKey),fingerprint]);
  await db.query(`INSERT INTO collector_auth.pairings(id,public_key,key_thumbprint,poll_hash,display_code,created_at,expires_at,state,oauth_state_hash,device_id,claimed_at)
    SELECT $1,d.public_key,d.key_thumbprint,$2,'123456',t,t+interval '10 minutes','completed',$3,d.id,t
    FROM collector_auth.devices d CROSS JOIN (SELECT clock_timestamp() AS t) stamp WHERE d.id=$4`,
    [crypto.randomUUID(),'a'.repeat(64),'b'.repeat(64),ids.device]);
  const sql:CollectorSqlV1={query:async<T extends Record<string,unknown>>(statement:string,parameters:unknown[])=>(await db.query<T>(statement,parameters)).rows};
  const store=new CollectorAuthorizationStoreV1(sql);
  const replies=[json({token_type:'Bearer',access_token:'synthetic-access-token',refresh_token:'synthetic-new-refresh-token',expires_in:3600,scope:'User.Read'}),
    json({id:ids.actor,accountEnabled:true,signInSessionsValidFromDateTime:new Date(now-7200_000).toISOString()}),json({value:[ids.group]})];
  const fetcher=vi.fn(async()=>replies.shift()??json({},503));
  const service=new CollectorAccessServiceV1(store,cipher,{tenantId:ids.tenant,clientId:ids.client,adminGroupId:ids.group},
    {fetch:fetcher as unknown as typeof fetch,now:Date.now,clientAssertion:async()=>'synthetic-server-assertion'});
  async function sign(challenge:CollectorChallengeV1) {
    const prefix=new TextEncoder().encode('Ecossistema.Coletor.DeviceProof.v1\0'),body=collectorChallengeBytesV1(challenge);
    const data=new Uint8Array(prefix.byteLength+body.byteLength);data.set(prefix);data.set(body,prefix.byteLength);
    return encodeBase64Url(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,data)));
  }
  return {service,store,fetcher,sign,cipher,source};
}
describe('collector broker composition without Microsoft token exposure',()=>{
  it('uses current directory evidence, consumes proof once, and returns only a bounded receipt',async()=>{
    const f=await fixture(),challenge=await f.service.challenge(ids.device);
    const input={deviceId:ids.device,nonce:challenge.nonce,signature:await f.sign(challenge)};
    const reply=await f.service.authorize(input);
    expect(reply.contractVersion).toBe(2);expect(reply.capability).toBe('frequency.collector.use');
    expect(JSON.stringify(reply)).not.toMatch(/synthetic.*token|encrypted_refresh|access_token|refresh_token/u);
    expect(Date.parse(reply.expiresAt)).toBeLessThanOrEqual(Date.parse(reply.directoryValidUntil));
    expect(f.fetcher).not.toHaveBeenCalled();
    await expect(f.service.authorize(input)).rejects.toThrow('denied');
  });
  it('refreshes expired evidence silently, preserves origin and replaces encrypted secret under CAS',async()=>{
    const f=await fixture(301_000),challenge=await f.service.challenge(ids.device);
    const reply=await f.service.authorize({deviceId:ids.device,nonce:challenge.nonce,signature:await f.sign(challenge)});
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    const snapshot=await f.store.snapshot(ids.device);
    expect(snapshot?.credential_version).toBe(1);
    const original=snapshot?.origin_authenticated_at as Date;
    expect(original.getTime()).toBe(f.source.originAuthenticatedAt);
    expect(await f.cipher.decrypt(String(snapshot?.encrypted_refresh),{...f.source,version:1})).toBe('synthetic-new-refresh-token');
    expect(Date.parse(reply.expiresAt)).toBeLessThanOrEqual(Date.parse(reply.directoryValidUntil));
  });
  it('checks local revocation even while directory evidence remains current',async()=>{
    const f=await fixture(),challenge=await f.service.challenge(ids.device),signature=await f.sign(challenge);
    await f.store.revokeDevice(ids.device,ids.tenant,ids.actor);
    await expect(f.service.authorize({deviceId:ids.device,nonce:challenge.nonce,signature})).rejects.toThrow('denied');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('binds real signatures and one-use nonce to the frequency payload and purpose',async()=>{
    const f=await fixture();
    const payload={operation:'lease',academicYear:2026,requestId:crypto.randomUUID(),durationSeconds:60};
    const challenge=await f.service.challenge(ids.device,'collector-frequency',await frequencyPayloadHashV2(payload));
    const proof={deviceId:ids.device,nonce:challenge.nonce,signature:await f.sign(challenge)};
    await expect(f.service.authorizeFrequency(proof,{...payload,durationSeconds:61})).rejects.toThrow('denied');
    await expect(f.service.authorize(proof)).rejects.toThrow('denied');
    const actor=await f.service.authorizeFrequency(proof,payload);
    expect(actor).toEqual({mode:'device',actorId:ids.actor,tenantId:ids.tenant,deviceId:ids.device,deviceGeneration:1,keyThumbprint:challenge.keyThumbprint});
    expect(f.fetcher).not.toHaveBeenCalled();
    await expect(f.service.authorizeFrequency(proof,payload)).rejects.toThrow('denied');
  });
  it('rejects frequency authorization after local revocation with still-current directory evidence',async()=>{
    const f=await fixture(),payload={operation:'status',academicYear:2026};
    const challenge=await f.service.challenge(ids.device,'collector-frequency',await frequencyPayloadHashV2(payload));
    const proof={deviceId:ids.device,nonce:challenge.nonce,signature:await f.sign(challenge)};
    await f.store.revokeDevice(ids.device,ids.tenant,ids.actor);
    await expect(f.service.authorizeFrequency(proof,payload)).rejects.toThrow('denied');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
