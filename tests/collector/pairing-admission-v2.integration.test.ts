// @vitest-environment node
// Real disposable PostgreSQL concurrency test: NEVER runs against Supabase.
import postgres from 'postgres';
import {readFile} from 'node:fs/promises';
import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {CollectorPairingStoreV1} from '../../server/collector/pairing-store-v1';
import type {CollectorSqlV1} from '../../server/collector/authorization-store-v1';
import type {CollectorPublicKeyV1} from '../../server/collector/device-proof-v1';

const url=process.env.ATTENDANCE_TEST_POSTGRES_URL;
const expectedMarker='00000000-0000-4000-8000-000000000001';
let connection:ReturnType<typeof postgres>,pool:ReturnType<typeof postgres>,store:CollectorPairingStoreV1,publicKey:CollectorPublicKeyV1;

beforeAll(async()=>{
  if(!url)return; // The generic npm test has no isolated PostgreSQL service.
  if(!url.includes('127.0.0.1:5432/attendance_ephemeral_'))throw new Error('disposable-native-postgres-required');
  // Multi-statement migrations must use exactly one reserved connection.
  connection=postgres(url,{max:1,prepare:false,connect_timeout:5});
  const evidence=await connection.unsafe("SELECT marker::text AS marker FROM public.attendance_test_sandbox_v1");
  if(evidence.length!==1 || evidence[0]?.marker!==expectedMarker)throw new Error('disposable-native-postgres-marker-required');
  for(const migration of ['0001_device_authorization.sql','0002_pending_pairings.sql','0006_pairing_rate_v1.sql','0009_atomic_pairing_admission_v2.sql']){
    await connection.unsafe(await readFile(new URL('../../migrations/collector/'+migration,import.meta.url),'utf8'));
  }
  const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const jwk=await crypto.subtle.exportKey('jwk',key.publicKey);
  publicKey={kty:'EC',crv:'P-256',x:jwk.x!,y:jwk.y!,ext:true};
  // A separate pool with multiple real connections reproduces races.
  pool=postgres(url,{max:25,prepare:false,connect_timeout:5});
  const adapter:CollectorSqlV1={query:async<T extends Record<string,unknown>>(statement:string,params:unknown[])=>
    Array.from(await pool.unsafe(statement,params as never[])) as T[]};
  store=new CollectorPairingStoreV1(adapter);
},60_000);
afterAll(async()=>{if(pool)await pool.end({timeout:2});if(connection)await connection.end({timeout:2});});

const scope=(n:string)=>'client:'+n.repeat(64);
const offer=(target:string)=>store.createAdmitted(target,{
  id:crypto.randomUUID(),publicKey,pollHash:'d'.repeat(64),displayCode:'123456',createdAt:Date.now()});
const globalCount=async()=>Number((await connection.unsafe("SELECT requests FROM collector_auth.pairing_rate_v1 WHERE scope='global'"))[0]?.requests??0);
describe.skipIf(!url)('real PostgreSQL multi-connection pairing admission',()=>{
  it('confirms a real PostgreSQL pairing exactly once and rejects a different OAuth state',async()=>{
    await connection.unsafe("TRUNCATE collector_auth.pairings,collector_auth.pairing_rate_v1");
    const id=crypto.randomUUID(),now=Date.now();
    await store.create({id,publicKey,pollHash:'e'.repeat(64),displayCode:'123456',createdAt:now});
    const txn={pairingId:id,state:'collector.'+'a'.repeat(43),nonce:'b'.repeat(43),
      verifier:'c'.repeat(64),startedAt:now,exp:Math.floor(now/1000)+300};
    expect(await store.confirm(txn)).toBe(true);
    const committed=await connection.unsafe("SELECT state FROM collector_auth.pairings WHERE id=$1",[id]);
    expect(committed[0]?.state).toBe('confirmed');
    expect(await store.confirm({...txn,state:'collector.'+'z'.repeat(43)})).toBe(false);
    expect(await store.confirm(txn)).toBe(true); // Exact cryptographic binding only, no replacement.
  });
  it('admits only one of 24 concurrent callers when their local budget is 29',async()=>{
    await connection.unsafe("TRUNCATE collector_auth.pairings,collector_auth.pairing_rate_v1");
    await connection.unsafe("INSERT INTO collector_auth.pairing_rate_v1(scope,requests) VALUES('global',5),($1,29)",[scope('a')]);
    const outcomes=await Promise.all(Array.from({length:24},()=>offer(scope('a'))));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await globalCount()).toBe(6);
    const local=(await connection.unsafe("SELECT requests FROM collector_auth.pairing_rate_v1 WHERE scope=$1",[scope('a')]))[0];
    expect(local?.requests).toBe(30);
  });
  it('atomically admits only one pairing at capacity 79, with unique origins',async()=>{
    await connection.unsafe("TRUNCATE collector_auth.pairings,collector_auth.pairing_rate_v1");
    const seed=crypto.randomUUID();
    expect(await store.create({id:seed,publicKey,pollHash:'f'.repeat(64),displayCode:'123456',createdAt:Date.now()})).toBeUndefined();
    await connection.unsafe(`INSERT INTO collector_auth.pairings(id,public_key,key_thumbprint,poll_hash,display_code,created_at,expires_at)
      SELECT gen_random_uuid(),p.public_key,p.key_thumbprint,p.poll_hash,'123456',p.created_at,p.expires_at
      FROM collector_auth.pairings p CROSS JOIN generate_series(1,78) n WHERE p.id=$1`,[seed]);
    const results=await Promise.all(Array.from({length:24},(_,i)=>offer('client:'+i.toString(16).padStart(64,'0'))));
    expect(results.filter(Boolean)).toHaveLength(1);
    const pending=await connection.unsafe("SELECT count(*)::integer AS n FROM collector_auth.pairings WHERE state='pending'");
    expect(pending[0]?.n).toBe(80);
    expect(await globalCount()).toBe(1);
  });
});
