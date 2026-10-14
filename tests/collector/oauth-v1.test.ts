import {describe,it,expect,vi} from 'vitest';
import {collectorAuthorizationUrlV1,completeCollectorOAuthV1,type CollectorOAuthDependenciesV1,type CollectorOAuthTransactionV1} from '../../server/collector/oauth-v1';
import {CollectorRefreshCipherV1} from '../../server/collector/refresh-cipher-v1';
import {authorizationUrl,type IdClaims} from '../../server/auth/oidc';
import {encodeBase64Url} from '../../server/auth/base64url';
import type {RuntimeEnv} from '../../server/env';
const tenant='11111111-1111-4111-8111-111111111111',client='22222222-2222-4222-8222-222222222222';
const actor='33333333-3333-4333-8333-333333333333',group='44444444-4444-4444-8444-444444444444';
// Wrangler's generated Env pins production UUID literals. This fixture deliberately
// substitutes synthetic identities; it never reaches a real identity provider.
const env={TENANT_ID:tenant,WEB_CLIENT_ID:client,GRAPH_CLIENT_ID:client,GROUP_ADMIN_ID:group,
  GROUP_PROFESSOR_ID:group,GROUP_ALUNO_ID:group,GROUP_APOIO_ID:group,GROUP_VISITANTE_ID:group,
  SHAREPOINT_SITE_ID:'synthetic-site-not-contacted',SESSION_SECRET:'s'.repeat(43),OFFICIAL_ORIGIN:'https://admin.escolaieda.com'} as unknown as RuntimeEnv;
const json=(body:unknown,status=200)=>Response.json(body,{status});
async function fixture(authTime:unknown='valid') {
  const now=Math.floor(Date.now()/1000)*1000;
  const transaction:CollectorOAuthTransactionV1={state:'collector.'+'s'.repeat(43),nonce:'n'.repeat(43),verifier:'v'.repeat(64),
    exp:now/1000+600,startedAt:now,pairingId:'55555555-5555-4555-8555-555555555555'};
  const body=authTime==='absent'?{}:{auth_time:authTime==='valid'?now/1000:authTime};
  const idToken='header.'+encodeBase64Url(new TextEncoder().encode(JSON.stringify(body)))+'.synthetic-signature';
  const replies=[json({id_token:idToken,token_type:'Bearer',refresh_token:'PRIVATE_ORIGINAL_REFRESH'}),
    json({token_type:'Bearer',access_token:'PRIVATE_DIRECTORY_ACCESS',refresh_token:'PRIVATE_ROTATED_REFRESH',expires_in:3600,scope:'User.Read'}),
    json({id:actor,accountEnabled:true,signInSessionsValidFromDateTime:new Date(now-1000).toISOString()}),json({value:[group]})];
  const fetcher=vi.fn(async()=>replies.shift()??json({},503));
  const claims={tid:tenant,oid:actor,aud:client,iss:`https://login.microsoftonline.com/${tenant}/v2.0`,
    nonce:transaction.nonce,exp:now/1000+3600,name:'Synthetic actor',groups:[]} satisfies IdClaims;
  const dependencies:CollectorOAuthDependenciesV1={fetch:fetcher as unknown as typeof fetch,now:()=>now,
    clientAssertion:vi.fn(async()=>'PRIVATE_SERVER_ASSERTION'),verifyIdToken:vi.fn(async()=>claims),
    consumeConfirmedTransaction:vi.fn(async()=>true),registerConfirmedPairing:vi.fn(async()=>true)};
  const cipher=await CollectorRefreshCipherV1.fromDedicatedKey(new Uint8Array(32).fill(7));
  const input={env,transaction,callbackState:transaction.state,code:'SYNTHETIC_AUTHORIZATION_CODE',cipher,dependencies};
  return {input,replies,fetcher,dependencies,now,cipher};
}
describe('collector callback broker, synthetic providers only',()=>{
  it('adds narrow collector scopes without changing normal login or its registered redirect',()=>{
    const base={state:'collector.'+'s'.repeat(43),nonce:'n'.repeat(43),verifier:'v'.repeat(64),exp:9e9,challenge:'synthetic'};
    const collector=new URL(collectorAuthorizationUrlV1(env,base)),normal=new URL(authorizationUrl(env,base));
    expect(collector.searchParams.get('scope')).toBe('openid profile email offline_access https://graph.microsoft.com/User.Read');
    expect(collector.searchParams.get('redirect_uri')).toBe('https://admin.escolaieda.com/auth/callback');
    expect(collector.searchParams.get('max_age')).toBe('0');expect(normal.searchParams.get('scope')).toBe('openid profile email');
    expect(()=>collectorAuthorizationUrlV1(env,{...base,state:'normal'})).toThrow('denied');
  });
  it('returns completion only and registers rotated ciphertext with original authentication time',async()=>{
    const f=await fixture(),result=await completeCollectorOAuthV1(f.input);
    expect(result).toEqual({completed:true});expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(f.dependencies.verifyIdToken).toHaveBeenCalledTimes(1);expect(f.fetcher).toHaveBeenCalledTimes(4);
    const registered=vi.mocked(f.dependencies.registerConfirmedPairing).mock.calls[0]![0];
    expect(registered.binding.originAuthenticatedAt).toBe(f.now);expect(registered.binding.actorId).toBe(actor);
    expect(registered.encryptedRefresh).not.toContain('PRIVATE');
    expect(await f.cipher.decrypt(registered.encryptedRefresh,registered.binding)).toBe('PRIVATE_ROTATED_REFRESH');
    for(const call of f.fetcher.mock.calls as unknown as [string,RequestInit][]) expect(call[1].redirect).toBe('manual');
  });
  it('denies mismatch, expiry and already consumed transaction before any provider request',async()=>{
    for(const scenario of ['state','expired','consumed']){
      const f=await fixture();if(scenario==='state')f.input.callbackState='wrong';
      if(scenario==='expired')f.input.transaction.exp=f.now/1000;
      if(scenario==='consumed')vi.mocked(f.dependencies.consumeConfirmedTransaction).mockResolvedValue(false);
      await expect(completeCollectorOAuthV1(f.input)).rejects.toThrow('denied');
      expect(f.fetcher).not.toHaveBeenCalled();expect(f.dependencies.registerConfirmedPairing).not.toHaveBeenCalled();
    }
  });
  it('requires validated provider auth_time instead of resetting origin to callback clock',async()=>{
    for(const authTime of ['absent',null,'not-a-number',Math.floor(Date.now()/1000)-3600,Math.floor(Date.now()/1000)+3600]){
      const f=await fixture(authTime);await expect(completeCollectorOAuthV1(f.input)).rejects.toThrow('denied');
      expect(f.fetcher).toHaveBeenCalledTimes(1);expect(f.dependencies.registerConfirmedPairing).not.toHaveBeenCalled();
    }
    const f=await fixture();vi.mocked(f.dependencies.verifyIdToken).mockRejectedValue(new Error('PRIVATE_TOKEN_ERROR'));
    await expect(completeCollectorOAuthV1(f.input)).rejects.toThrow('collector-login-denied');
    expect(f.dependencies.registerConfirmedPairing).not.toHaveBeenCalled();
  });
  it('does not register missing/null own-account properties or a lost confirmed pairing',async()=>{
    const f=await fixture();f.replies[2]=json({id:actor,accountEnabled:true,signInSessionsValidFromDateTime:null});
    await expect(completeCollectorOAuthV1(f.input)).rejects.toThrow('denied');expect(f.dependencies.registerConfirmedPairing).not.toHaveBeenCalled();
    const cancelled=await fixture();vi.mocked(cancelled.dependencies.registerConfirmedPairing).mockResolvedValue(false);
    await expect(completeCollectorOAuthV1(cancelled.input)).rejects.toThrow('denied');
  });
});
