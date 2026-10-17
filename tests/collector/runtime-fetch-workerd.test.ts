// @vitest-environment node
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {expect,it} from 'vitest';

it('calls native Workerd fetch through the real collector dependency with its global receiver',async()=>{
  const bundled=await build({stdin:{contents:`
    import {createCollectorRuntimeV1} from './server/collector/runtime-v1';
    import {encodeBase64Url} from './server/auth/base64url';
    export default {async fetch(){
      const runtime=await createCollectorRuntimeV1({OFFICIAL_ORIGIN:'https://admin.escolaieda.com',
        COLLECTOR_ENABLED:'true',COLLECTOR_DB:{connectionString:'synthetic-only'},
        SESSION_SECRET:'s'.repeat(43),COLLECTOR_REFRESH_KEY:encodeBase64Url(new Uint8Array(32).fill(8))},
        {database:async()=>({query:async()=>[{ready:true}],close:async()=>{}}),assertion:async()=>'synthetic'});
      if(!runtime)return new Response('runtime unavailable',{status:503});
      try {
        // No injected fetch: exercise the production native function, as both
        // the OAuth callback and subsequent directory refresh invoke it.
        const reply=await runtime.oauth.fetch('https://synthetic.invalid/token',{method:'POST',body:'synthetic'});
        return Response.json({status:reply.status,body:await reply.text()});
      }finally{await runtime.close();}
    }};
  `,resolveDir:process.cwd(),sourcefile:'collector-fetch-harness.ts',loader:'ts'},
    bundle:true,write:false,format:'esm',platform:'node',target:'es2022'});
  const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
  let outgoing=0;
  const runtime=new Miniflare(convertV4MiniflareOptions({name:'collector-fetch-proof',modules:true,
    script:bundled.outputFiles[0]!.text,compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,
    outboundService:async request=>{
      outgoing++;
      expect(request.url).toBe('https://synthetic.invalid/token');
      expect(request.method).toBe('POST');
      expect(await request.text()).toBe('synthetic');
      return new Response('intercepted');
    }}));
  try {
    const reply=await runtime.dispatchFetch('http://localhost/');
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({status:200,body:'intercepted'});
    expect(outgoing).toBe(1);
  }finally{await runtime.dispose();}
},30_000);

it('completes the real Workerd callback with a signed ID token and intercepted own-directory checks',async()=>{
  const tenant='11111111-1111-4111-8111-111111111111',client='22222222-2222-4222-8222-222222222222';
  const actor='33333333-3333-4333-8333-333333333333',group='44444444-4444-4444-8444-444444444444';
  const nonce='n'.repeat(43),now=Math.floor(Date.now()/1000);
  const key=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,
    publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const publicKey=await webcrypto.subtle.exportKey('jwk',key.publicKey);
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned=encode({alg:'RS256',kid:'synthetic-key'})+'.'+encode({aud:client,
    iss:`https://login.microsoftonline.com/${tenant}/v2.0`,tid:tenant,oid:actor,exp:now+3600,nbf:now-30,
    nonce,name:'Synthetic actor',auth_time:now,groups:[]});
  const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',key.privateKey,new TextEncoder().encode(unsigned));
  const idToken=unsigned+'.'+Buffer.from(signature).toString('base64url');
  const bundled=await build({stdin:{contents:`
    import {createCollectorRuntimeV1} from './server/collector/runtime-v1';
    import {completeCollectorOAuthV1} from './server/collector/oauth-v1';
    import {encodeBase64Url} from './server/auth/base64url';
    export default {async fetch(){
      const now=${now}*1000;
      const env={OFFICIAL_ORIGIN:'https://admin.escolaieda.com',TENANT_ID:'${tenant}',WEB_CLIENT_ID:'${client}',
        GROUP_ADMIN_ID:'${group}',COLLECTOR_ENABLED:'true',COLLECTOR_DB:{connectionString:'synthetic-only'},
        SESSION_SECRET:'s'.repeat(43),COLLECTOR_REFRESH_KEY:encodeBase64Url(new Uint8Array(32).fill(8))};
      const runtime=await createCollectorRuntimeV1(env,{database:async()=>({query:async()=>[{ready:true,id:'synthetic'}],
        close:async()=>{}}),assertion:async()=>'synthetic',now:()=>now});
      if(!runtime)return new Response('runtime unavailable',{status:503});
      try {
        const transaction={state:'collector.'+'s'.repeat(43),nonce:'${nonce}',verifier:'v'.repeat(64),
          exp:now/1000+600,startedAt:now,pairingId:'55555555-5555-4555-8555-555555555555'};
        return Response.json(await completeCollectorOAuthV1({env,transaction,callbackState:transaction.state,
          code:'synthetic-code',cipher:runtime.cipher,dependencies:runtime.oauth}));
      }finally{await runtime.close();}
    }};
  `,resolveDir:process.cwd(),sourcefile:'collector-callback-harness.ts',loader:'ts'},
    bundle:true,write:false,format:'esm',platform:'node',target:'es2022'});
  const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
  const outgoing:string[]=[];
  const runtime=new Miniflare(convertV4MiniflareOptions({name:'collector-callback-proof',modules:true,
    script:bundled.outputFiles[0]!.text,compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,
    outboundService:async request=>{
      const url=new URL(request.url);outgoing.push(url.pathname);
      if(url.pathname.endsWith('/keys'))return Response.json({keys:[{...publicKey,kid:'synthetic-key'}]});
      if(url.pathname.endsWith('/token')){
        const body=new URLSearchParams(await request.text());
        if(body.get('grant_type')==='authorization_code')return Response.json({id_token:idToken,token_type:'Bearer',refresh_token:'SYNTHETIC_REFRESH_TOKEN'});
        return Response.json({token_type:'Bearer',access_token:'SYNTHETIC_DIRECTORY_TOKEN',refresh_token:'SYNTHETIC_ROTATED_REFRESH',expires_in:3600,scope:'User.Read'});
      }
      if(url.pathname==='/v1.0/me')return Response.json({id:actor,accountEnabled:true,signInSessionsValidFromDateTime:new Date((now-60)*1000).toISOString()});
      if(url.pathname==='/v1.0/me/checkMemberGroups')return Response.json({value:[group]});
      throw new Error('Unexpected synthetic outbound request');
    }}));
  try {
    const reply=await runtime.dispatchFetch('http://localhost/');
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({completed:true});
    expect(outgoing).toHaveLength(5);
  }finally{await runtime.dispose();}
},30_000);
