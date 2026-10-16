// @vitest-environment node
import {webcrypto} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import type {RuntimeEnv} from '../../server/env';
import {handleCollectorRequestV1} from '../../server/collector/routes-v1';
import {createCollectorRuntimeV1,type CollectorRuntimeDependenciesV1} from '../../server/collector/runtime-v1';
import {collectorChallengeBytesV1,collectorKeyThumbprintV1,type CollectorPublicKeyV1,type CollectorChallengeV1} from '../../server/collector/device-proof-v1';
import {encodeBase64Url,decodeJson} from '../../server/auth/base64url';
import {unseal,seal} from '../../server/auth/sealed';
import {SESSION_COOKIE,createApplicationSession} from '../../server/auth/session';
import {onRequest} from '../../functions/[[path]]';

const origin='https://admin.escolaieda.com',prefix='/api/frequency-collector/';
const tenant='11111111-1111-4111-8111-111111111111',client='22222222-2222-4222-8222-222222222222';
const actor='33333333-3333-4333-8333-333333333333',group='44444444-4444-4444-8444-444444444444';
// All UUIDs, credentials and providers in this file are synthetic.
const env={TENANT_ID:tenant,WEB_CLIENT_ID:client,GRAPH_CLIENT_ID:client,GROUP_ADMIN_ID:group,GROUP_PROFESSOR_ID:group,
  GROUP_ALUNO_ID:group,GROUP_APOIO_ID:group,GROUP_VISITANTE_ID:group,SHAREPOINT_SITE_ID:'synthetic-site-not-contacted',
  SESSION_SECRET:'s'.repeat(43),OFFICIAL_ORIGIN:origin,COLLECTOR_ENABLED:'true',COLLECTOR_DB:{connectionString:'synthetic-only'},
  COLLECTOR_REFRESH_KEY:encodeBase64Url(new Uint8Array(32).fill(8))} as unknown as RuntimeEnv;
let db:PGlite;
beforeAll(async()=>{vi.stubGlobal('crypto',webcrypto);db=new PGlite();
  for(const name of ['0001_device_authorization.sql','0002_pending_pairings.sql','0006_pairing_rate_v1.sql','0009_atomic_pairing_admission_v2.sql'])
    await db.exec(await readFile(new URL('../../migrations/collector/'+name,import.meta.url),'utf8'));},60_000);
beforeEach(async()=>{await db.exec('TRUNCATE collector_auth.pairings,collector_auth.challenges,collector_auth.devices,collector_auth.oauth_grants,collector_auth.pairing_rate_v1');});
afterAll(async()=>{await db.close();});

async function fixture(){
  const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),exported=await crypto.subtle.exportKey('jwk',key.publicKey);
  const publicKey:CollectorPublicKeyV1={kty:'EC',crv:'P-256',x:exported.x!,y:exported.y!,ext:true};
  let expectedNonce='',authenticatedAt=0,providerUnavailable=false;
  const fetcher=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
    if(providerUnavailable)throw new Error('PRIVATE_PROVIDER_ERROR');
    const uri=String(url);
    if(uri.endsWith('/token')){
      const params=new URLSearchParams(String(init?.body));
      if(params.get('grant_type')==='authorization_code'){
        const token='header.'+encodeBase64Url(new TextEncoder().encode(JSON.stringify({auth_time:authenticatedAt})))+'.synthetic-signature';
        return Response.json({id_token:token,token_type:'Bearer',refresh_token:'PRIVATE_ORIGINAL_REFRESH'});
      }
      expect(params.get('scope')).toBe('https://graph.microsoft.com/User.Read');
      return Response.json({token_type:'Bearer',access_token:'PRIVATE_DIRECTORY_ACCESS',refresh_token:'PRIVATE_ROTATED_REFRESH',expires_in:3600,scope:'User.Read'});
    }
    if(uri.includes('/me?$select='))return Response.json({id:actor,accountEnabled:true,signInSessionsValidFromDateTime:new Date(Date.now()-3600_000).toISOString()});
    if(uri.endsWith('/me/checkMemberGroups')){expect(JSON.parse(String(init?.body))).toEqual({groupIds:[group]});return Response.json({value:[group]});}
    throw new Error('unexpected-synthetic-provider');
  });
  const closed=vi.fn(async()=>undefined);
  const dependencies:CollectorRuntimeDependenciesV1={database:async()=>({query:async<T extends Record<string,unknown>>(sql:string,parameters:unknown[])=>(await db.query<T>(sql,parameters)).rows,close:closed}),
    fetch:fetcher as unknown as typeof fetch,assertion:async()=>'PRIVATE_SERVER_ASSERTION',verify:async(_token,_env,nonce)=>{
      expect(nonce).toBe(expectedNonce);return {tid:tenant,oid:actor,aud:client,iss:`https://login.microsoftonline.com/${tenant}/v2.0`,
        nonce,exp:Math.floor(Date.now()/1000)+3600,name:'Synthetic administrator',groups:[]};}};
  async function request(path:string,value?:unknown,headers:Record<string,string>={}){
    const reply=await handleCollectorRequestV1(new Request(origin+path,{method:value===undefined?'GET':'POST',
      headers:{...(value===undefined?{}:{'Content-Type':'application/json'}),...headers},body:value===undefined?undefined:JSON.stringify(value)}),env,dependencies);
    expect(reply).not.toBeNull();return reply!;
  }
  async function sign(body:Uint8Array){const p=new TextEncoder().encode('Ecossistema.Coletor.DeviceProof.v1\0'),all=new Uint8Array(p.length+body.length);all.set(p);all.set(body,p.length);
    return encodeBase64Url(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,all)));}
  async function begin(){
    const id=crypto.randomUUID(),thumb=await collectorKeyThumbprintV1(publicKey),nonce='n'.repeat(43),issuedAt=Date.now(),expiresAt=issuedAt+120_000;
    const bytes=new TextEncoder().encode(JSON.stringify([id,thumb,nonce,origin,'POST',prefix+'pairings','collector-pairing',issuedAt,expiresAt]));
    const response=await request(prefix+'pairings',{id,publicKey,nonce,issuedAt,expiresAt,signature:await sign(bytes)});
    expect(response.status).toBe(200);return await response.json() as {id:string;pollToken:string;displayCode:string;browserUrl:string};
  }
  async function confirm(pair:Awaited<ReturnType<typeof begin>>){
    const page=await request('/frequency-collector/connect?pairing='+pair.id),html=await page.text();
    expect(html).toContain('type="checkbox"');expect(html).not.toContain(pair.pollToken);expect(html).not.toContain(pair.displayCode);
    if(process.env.COLLECTOR_RENDER_QA){
      const directory=process.env.COLLECTOR_RENDER_QA;
      await mkdir(directory,{recursive:true});
      await writeFile(join(directory,'confirmation.html'),html,'utf8');
      await writeFile(join(directory,'style.css'),await (await request('/frequency-collector/style.css')).text(),'utf8');
    }
    const csrf=html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)![1]!,cookie=page.headers.get('Set-Cookie')!.split(';')[0]!;
    const form=new URLSearchParams({pairing:pair.id,csrf,code:pair.displayCode,confirm:'yes'});
    const reply=await handleCollectorRequestV1(new Request(origin+'/frequency-collector/connect',{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie,Origin:origin},body:form}),env,dependencies);
    expect(reply?.status).toBe(303);expect(reply?.headers.get('Location')).toContain('offline_access');
    const authCookie=reply!.headers.get('Set-Cookie')!.match(/__Host-collector_auth=([^;]+)/)![1]!;
    const transaction=await unseal<{state:string;nonce:string}>(authCookie,env.SESSION_SECRET);
    expectedNonce=transaction!.nonce;
    authenticatedAt=Math.floor(Date.now()/1000);
    return {state:transaction!.state,cookie:'__Host-collector_auth='+authCookie};
  }
  async function complete(pair:Awaited<ReturnType<typeof begin>>){
    const auth=await confirm(pair),callback='/auth/callback?state='+auth.state+'&code=SYNTHETIC_CODE';
    const reply=await request(callback,undefined,{Cookie:auth.cookie});expect(reply.status).toBe(200);
    expect(await reply.text()).not.toContain('PRIVATE');
    return {auth,callback};
  }
  async function proof(deviceId:string,purpose:'collector-access'|'collector-revoke'='collector-access'){
    const response=await request(prefix+'challenge',{deviceId,purpose});expect(response.status).toBe(200);
    const challenge=await response.json() as CollectorChallengeV1;
    return {deviceId,nonce:challenge.nonce,signature:await sign(collectorChallengeBytesV1(challenge))};
  }
  return {request,begin,confirm,complete,proof,sign,dependencies,fetcher,closed,publicKey,unavailable:()=>{providerUnavailable=true;}};
}

describe('Pages collector orchestration, no real network/credentials',()=>{
  it('publishes a Pages invocation route for browser pairing, revocation and CSS',async()=>{
    const { readFile } = await import('node:fs/promises');
    const routeFile = JSON.parse(await readFile(new URL('../../public/_routes.json',import.meta.url),'utf8')) as {
      version:number; include:string[]; exclude:string[];
    };
    expect(routeFile.version).toBe(1);
    expect(routeFile.include).toEqual(expect.arrayContaining(['/auth/*','/api/*','/frequency-collector/*']));
    for(const url of ['/frequency-collector/connect','/frequency-collector/revoke','/frequency-collector/style.css']){
      expect(routeFile.include.some(path=>path.endsWith('/*') && url.startsWith(path.slice(0,-1)))).toBe(true);
    }
    expect(routeFile.exclude).toEqual([]);
  });

  it('mounts the unavailable route by default while preserving ordinary application routes',async()=>{
    const execution={...env,COLLECTOR_ENABLED:undefined,COLLECTOR_DB:undefined,COLLECTOR_REFRESH_KEY:undefined};
    for(const path of [prefix+'config',prefix+'access','/frequency-collector/connect']){
      const reply=await onRequest({request:new Request(origin+path),env:execution,waitUntil:()=>undefined} as never) as Response;
      expect(reply.status).toBe(503);expect(await reply.json()).toHaveProperty('code','ACCESS_NOT_CONFIGURED');
    }
    const health=await onRequest({request:new Request(origin+'/api/health'),env:execution,waitUntil:()=>undefined} as never) as Response;
    expect(health.status).toBe(200);
    expect(await handleCollectorRequestV1(new Request(origin+'/auth/callback?state=ordinary'),env)).toBeNull();
  });
  it('rejects unsigned requests without consuming budgets; valid signed attempts still hit rate limits',async()=>{
    const f=await fixture();
    for(let i=0;i<35;i++){
      const reply=await f.request(prefix+'pairings',{not:'a valid proof'});
      expect(reply.status).toBe(403);
    }
    const forged=await f.request(prefix+'pairings',{not:'a valid proof'},{'CF-Connecting-IP':'198.51.100.21'});
    expect(forged.status).toBe(403);
    expect((await db.query<{n:number}>("SELECT count(*)::integer AS n FROM collector_auth.pairing_rate_v1")).rows[0]?.n).toBe(0);
    for(let i=0;i<30;i++)await f.begin();
    const thumb=await collectorKeyThumbprintV1(f.publicKey),id=crypto.randomUUID(),
      nonce='n'.repeat(43),issuedAt=Date.now(),expiresAt=issuedAt+120_000;
    const bytes=new TextEncoder().encode(JSON.stringify([id,thumb,nonce,origin,'POST',prefix+'pairings',
      'collector-pairing',issuedAt,expiresAt]));
    const blocked=await f.request(prefix+'pairings',{id,publicKey:f.publicKey,nonce,issuedAt,expiresAt,
      signature:await f.sign(bytes)});
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toHaveProperty('code','ACCESS_UNAVAILABLE');
    const count=(await db.query<{n:number}>("SELECT count(*)::integer AS n FROM collector_auth.pairings")).rows[0]?.n;
    expect(count).toBe(30);
  });
  it('runs signed pairing, explicit browser confirmation, callback, local claim and nonce-protected authorization',async()=>{
    const f=await fixture(),pair=await f.begin(),{auth,callback}=await f.complete(pair);
    expect((await f.request(callback,undefined,{Cookie:auth.cookie})).status).toBe(403);
    const poll=await (await f.request(prefix+'pairings/poll',{id:pair.id,pollToken:pair.pollToken})).json() as {deviceId:string};
    expect((await f.request(prefix+'challenge',{deviceId:poll.deviceId})).status).toBe(403);
    expect((await f.request(prefix+'pairings/claim',{id:pair.id,pollToken:pair.pollToken})).status).toBe(200);
    const input=await f.proof(poll.deviceId),access=await f.request(prefix+'access',input),body=await access.json();
    expect(access.status).toBe(200);expect(body).toHaveProperty('capability','frequency.collector.use');
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE|access_token|refresh_token|encrypted_refresh/u);
    expect((await f.request(prefix+'access',input)).status).toBe(403);
    expect((await f.request(prefix+'revoke',input)).status).toBe(403);
    expect(f.closed).toHaveBeenCalled();
  });
  it('revoke uses its own purpose, works during provider outage, retires refresh, and cannot be used for access',async()=>{
    const f=await fixture(),pair=await f.begin();await f.complete(pair);
    const poll=await (await f.request(prefix+'pairings/poll',{id:pair.id,pollToken:pair.pollToken})).json() as {deviceId:string};
    await f.request(prefix+'pairings/claim',{id:pair.id,pollToken:pair.pollToken});
    const proof=await f.proof(poll.deviceId,'collector-revoke'),calls=f.fetcher.mock.calls.length;f.unavailable();
    expect((await f.request(prefix+'access',proof)).status).toBe(403);
    expect((await f.request(prefix+'revoke',proof)).status).toBe(200);expect(f.fetcher.mock.calls).toHaveLength(calls);
    const grant=(await db.query<{state:string;encrypted_refresh:null}>('SELECT state,encrypted_refresh FROM collector_auth.oauth_grants')).rows[0]!;
    expect(grant).toMatchObject({state:'revoked',encrypted_refresh:null});
    expect((await f.request(prefix+'challenge',{deviceId:poll.deviceId})).status).toBe(403);
    expect((await f.request(prefix+'revoke',await f.proof(poll.deviceId,'collector-revoke'))).status).toBe(200);
  });
  it('cancellation racing after callback retires unclaimed grant/device and prevents claim',async()=>{
    const f=await fixture(),pair=await f.begin();await f.complete(pair);
    const owner={id:pair.id,pollToken:pair.pollToken};expect((await f.request(prefix+'pairings/cancel',owner)).status).toBe(200);
    expect((await f.request(prefix+'pairings/claim',owner)).status).toBe(403);
    const grants=(await db.query<{state:string;encrypted_refresh:null}>('SELECT state,encrypted_refresh FROM collector_auth.oauth_grants')).rows;
    expect(grants[0]).toMatchObject({state:'revoked',encrypted_refresh:null});
  });
  it('an unclaimed device may retire itself by signed revoke after a client crash, but cannot access',async()=>{
    const f=await fixture(),pair=await f.begin();await f.complete(pair);
    const poll=await (await f.request(prefix+'pairings/poll',{id:pair.id,pollToken:pair.pollToken})).json() as {deviceId:string};
    expect((await f.request(prefix+'challenge',{deviceId:poll.deviceId})).status).toBe(403);
    expect((await f.request(prefix+'revoke',await f.proof(poll.deviceId,'collector-revoke'))).status).toBe(200);
    expect((await f.request(prefix+'pairings/claim',{id:pair.id,pollToken:pair.pollToken})).status).toBe(403);
  });
  it('web withdrawal is owner-only, origin/CSRF bound, and remains usable with collector activation disabled',async()=>{
    const f=await fixture(),pair=await f.begin();await f.complete(pair);
    const poll=await (await f.request(prefix+'pairings/poll',{id:pair.id,pollToken:pair.pollToken})).json() as {deviceId:string};
    const thumb=await collectorKeyThumbprintV1(f.publicKey),inactive={...env,COLLECTOR_ENABLED:undefined,COLLECTOR_REFRESH_KEY:undefined} as RuntimeEnv;
    async function sessionCookie(oid:string){return SESSION_COOKIE+'='+await seal(createApplicationSession({oid,name:'Synthetic owner',roles:['VISITANTE']}),env.SESSION_SECRET);}
    const owner=await sessionCookie(actor),other=await sessionCookie('77777777-7777-4777-8777-777777777777');
    const path='/frequency-collector/revoke?device='+poll.deviceId;
    expect((await handleCollectorRequestV1(new Request(origin+path,{headers:{Cookie:other}}),inactive,f.dependencies))?.status).toBe(404);
    const page=await handleCollectorRequestV1(new Request(origin+path,{headers:{Cookie:owner}}),inactive,f.dependencies);
    expect(page?.status).toBe(200);
    const csrf=(await page!.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)![1]!,withdraw=page!.headers.get('Set-Cookie')!.split(';')[0]!;
    const form=new URLSearchParams({device:poll.deviceId,csrf,confirm:'yes'});
    for(const [cookie,from] of [[other,'https://admin.escolaieda.com'],[owner,'https://other.invalid']]){
      const reply=await handleCollectorRequestV1(new Request(origin+'/frequency-collector/revoke',{method:'POST',headers:{
        Cookie:cookie+'; '+withdraw,Origin:from!,'Content-Type':'application/x-www-form-urlencoded'},body:form}),inactive,f.dependencies);
      expect(reply?.status).toBe(403);
    }
    expect(await (await f.request(prefix+'device-status',{deviceId:poll.deviceId,keyThumbprint:thumb})).json()).toEqual({revoked:false});
    const reply=await handleCollectorRequestV1(new Request(origin+'/frequency-collector/revoke',{method:'POST',headers:{
      Cookie:owner+'; '+withdraw,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:form}),inactive,f.dependencies);
    expect(reply?.status).toBe(200);
    expect(await (await f.request(prefix+'device-status',{deviceId:poll.deviceId,keyThumbprint:thumb})).json()).toEqual({revoked:true});
    const grant=(await db.query<{state:string;encrypted_refresh:null}>('SELECT state,encrypted_refresh FROM collector_auth.oauth_grants')).rows[0]!;
    expect(grant).toMatchObject({state:'revoked',encrypted_refresh:null});
  });
  it('expired unclaimed registrations retire credentials on the next configured request',async()=>{
    const f=await fixture(),pair=await f.begin();await f.complete(pair);
    await db.query(`WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS now)
      UPDATE collector_auth.pairings SET created_at=stamp.now-interval '11 minutes',
      expires_at=stamp.now-interval '1 minute' FROM stamp WHERE id=$1`,[pair.id]);
    expect((await f.request(prefix+'config')).status).toBe(200);
    expect((await db.query<{encrypted_refresh:null}>('SELECT encrypted_refresh FROM collector_auth.oauth_grants')).rows[0]!.encrypted_refresh).toBeNull();
  });
  it('requires correct origin, CSRF, matching code and checkbox without exposing secrets',async()=>{
    const f=await fixture(),pair=await f.begin();
    const page=await f.request('/frequency-collector/connect?pairing='+pair.id),html=await page.text();
    const csrf=html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)![1]!,cookie=page.headers.get('Set-Cookie')!.split(';')[0]!;
    for(const variant of ['origin','csrf','code','checkbox']){
      const form=new URLSearchParams({pairing:pair.id,csrf,code:pair.displayCode,confirm:'yes'});
      if(variant==='csrf')form.set('csrf','wrong');if(variant==='code')form.set('code','WRONG');if(variant==='checkbox')form.delete('confirm');
      const reply=await handleCollectorRequestV1(new Request(origin+'/frequency-collector/connect',{method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie,Origin:variant==='origin'?'https://other.invalid':origin},body:form}),env,f.dependencies);
      expect(reply?.status).toBe(403);expect(await reply?.text()).not.toContain('PRIVATE');
    }
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await f.request(prefix+'pairings/poll',{id:pair.id,pollToken:'x'.repeat(43)})).status).toBe(403);
  });
  it('denies missing configuration/dedicated key before opening a database',async()=>{
    const factory=vi.fn();
    for(const changes of [{COLLECTOR_ENABLED:undefined},{COLLECTOR_DB:undefined},{COLLECTOR_REFRESH_KEY:undefined},{COLLECTOR_REFRESH_KEY:env.SESSION_SECRET}])
      expect(await createCollectorRuntimeV1({...env,...changes} as RuntimeEnv,{database:factory,assertion:async()=>'synthetic'})).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });
  it('keeps the collector database open until the frequency request has finished',async()=>{
    let open=true;
    const dependencies:CollectorRuntimeDependenciesV1={assertion:async()=>'synthetic',database:async()=>({
      query:async<T extends Record<string,unknown>>(sql:string,parameters:unknown[])=>{
        if(!open)throw new Error('synthetic-connection-ended');
        return (await db.query<T>(sql,parameters)).rows;},
      close:async()=>{open=false;}})};
    const body={proof:{deviceId:'66666666-6666-4666-8666-666666666666',nonce:'n'.repeat(43),signature:'s'.repeat(86)},
      payload:{operation:'status',academicYear:2026}};
    const reply=await handleCollectorRequestV1(new Request(origin+prefix+'frequency',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env,dependencies);
    // An unknown device is a denied proof, never a closed-connection outage.
    expect(reply?.status).toBe(403);
    expect(await reply?.json()).toEqual({contractVersion:2,state:'not-authorized'});
    expect(open).toBe(false);
  });
  it('never reads unverified ID token data in the callback',async()=>{
    const f=await fixture(),pair=await f.begin(),auth=await f.confirm(pair);
    f.dependencies.verify=async(token)=>{expect(decodeJson(token.split('.')[1]!)).toHaveProperty('auth_time');throw new Error('PRIVATE_ID_TOKEN_FAILURE');};
    const reply=await f.request('/auth/callback?state='+auth.state+'&code=synthetic',undefined,{Cookie:auth.cookie});
    expect(reply.status).toBe(403);expect(await reply.text()).not.toContain('PRIVATE');
    expect((await db.query('SELECT id FROM collector_auth.oauth_grants')).rows).toHaveLength(0);
  });
});
