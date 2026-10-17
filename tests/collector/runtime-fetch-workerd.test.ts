// @vitest-environment node
import {readFileSync} from 'node:fs';
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
