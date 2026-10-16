import {z} from 'zod';
import type {RuntimeEnv} from '../env';
import {newAuthTransaction} from '../auth/oidc';
import {seal,unseal} from '../auth/sealed';
import {readCookie,secureCookie,clearCookie} from '../auth/cookies';
import {encodeBase64Url} from '../auth/base64url';
import {readBoundedJson,readBoundedBytes,enforceWriteOrigin} from '../http/security';
import {createCollectorRuntimeV1,type CollectorRuntimeDependenciesV1} from './runtime-v1';
import {createCollectorWithdrawalStoreV1} from './runtime-v1';
import {requireAuth} from '../auth/session';
import {handleCollectorAccessRequestV1} from './http-v1';
import {handleCollectorFrequencyRequestV2} from './frequency-http-v2';
import {collectorAuthorizationUrlV1,completeCollectorOAuthV1,type CollectorOAuthTransactionV1} from './oauth-v1';
import {verifyCollectorPairingV1} from './pairing-proof-v1';
import {collectorOpaqueHashV1} from './pairing-store-v1';

const CONFIRM_COOKIE='__Host-collector_confirm',AUTH_COOKIE='__Host-collector_auth';
const uuid=z.string().uuid(),secret=z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const random=()=>encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const confirmSchema=z.object({purpose:z.literal('collector-confirm'),id:uuid,csrf:secret,exp:z.number().int().positive()}).strict();
const authSchema=z.object({state:z.string().regex(/^collector\.[A-Za-z0-9_-]{43}$/u),nonce:secret,
  verifier:z.string().regex(/^[A-Za-z0-9_-]{64}$/u),exp:z.number().int().positive(),startedAt:z.number().int().positive(),pairingId:uuid}).strict();
const withdrawalSchema=z.object({purpose:z.literal('collector-withdraw'),device:uuid,actor:uuid,tenant:uuid,thumb:secret,csrf:secret,exp:z.number().int().positive()}).strict();
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','Pragma':'no-cache'}});
const escaped=(text:string)=>text.replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
function page(title:string,body:string,status=200,headers:HeadersInit={}):Response{
  return new Response(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escaped(title)} — Ecossistema</title><link rel="stylesheet" href="/frequency-collector/style.css">
    <main><p class="brand">ECOSSISTEMA · COLETOR DE FREQUÊNCIA</p><h1>${escaped(title)}</h1>${body}</main></html>`,
    {status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',...Object.fromEntries(new Headers(headers))}});
}
const style=`:root{font-family:Segoe UI,system-ui,sans-serif;color:#291e23;background:#faf7f8}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}main{background:white;border:1px solid #e8dce1;border-radius:16px;padding:36px;max-width:480px}h1{font-size:26px}p{line-height:1.6}.brand{color:#8e2841;font-size:11px;font-weight:700;letter-spacing:.1em}form{display:grid;gap:18px}label{display:block;line-height:1.5}input[type=text]{display:block;box-sizing:border-box;width:100%;font:inherit;font-size:24px;letter-spacing:.3em;padding:12px;border:1px solid #b9a7af;border-radius:8px;margin-top:8px}button{font:inherit;font-weight:600;border:0;border-radius:24px;padding:14px 18px;background:#a32743;color:white;cursor:pointer}small{display:block;overflow-wrap:anywhere;color:#64545c}a{color:#a32743}.note{padding:14px;background:#faf4f6;border-radius:8px}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #a32743;outline-offset:3px}`;

type CollectorRuntimeReadyV1=NonNullable<Awaited<ReturnType<typeof createCollectorRuntimeV1>>>;
type WithdrawalStoreV1=NonNullable<Awaited<ReturnType<typeof createCollectorWithdrawalStoreV1>>>['store'];
type SessionV1=Awaited<ReturnType<typeof requireAuth>>;
const WITHDRAW_COOKIE='__Host-collector_withdraw';
const denied=()=>json({error:'Collector access denied'},403);
const notAllowed=()=>json({error:'Method not allowed'},405);
const foreignOrigin=(request:Request,env:RuntimeEnv)=>request.headers.has('Origin') && request.headers.get('Origin')!==env.OFFICIAL_ORIGIN;
const formOf=async(request:Request)=>new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(
  await readBoundedBytes(request,{maxBytes:1024,allowedContentTypes:['application/x-www-form-urlencoded']})));

/** A verified application session can only ask the revocation status or retire its own device. */
async function deviceStatus(request:Request,env:RuntimeEnv,store:WithdrawalStoreV1):Promise<Response>{
  if(request.method!=='POST'||foreignOrigin(request,env))return json({error:'Denied'},403);
  const value=z.object({deviceId:uuid,keyThumbprint:secret}).strict().parse(await readBoundedJson(request,1024));
  return json({revoked:await store.revocationStatus(value.deviceId,value.keyThumbprint)});
}
async function withdrawalPage(url:URL,env:RuntimeEnv,store:WithdrawalStoreV1,session:SessionV1):Promise<Response>{
  const device=uuid.parse(url.searchParams.get('device'));
  const thumb=await store.ownedKey(device,env.TENANT_ID,session.oid);
  if(!thumb)return page('Vínculo indisponível','<p>Esta sessão não é dona deste vínculo.</p>',404);
  const csrf=random(),value={purpose:'collector-withdraw',device,actor:session.oid,tenant:env.TENANT_ID,thumb,csrf,exp:Date.now()+600_000};
  return page('Concluir a saída do coletor',`<p>A chave local já pode ter sido apagada. Esta confirmação retira o acesso deste dispositivo no servidor, sem encerrar sessões de outros módulos.</p>
    <form method="post" action="/frequency-collector/revoke"><input type="hidden" name="device" value="${device}"><input type="hidden" name="csrf" value="${csrf}">
    <label><input type="checkbox" name="confirm" value="yes" required> Quero retirar o vínculo deste dispositivo.</label><button type="submit">Retirar vínculo</button></form>`,200,
    {'Set-Cookie':secureCookie(WITHDRAW_COOKIE,await seal(value,env.SESSION_SECRET),{maxAge:600,sameSite:'Strict'})});
}
async function confirmWithdrawal(request:Request,env:RuntimeEnv,store:WithdrawalStoreV1,session:SessionV1):Promise<Response>{
  enforceWriteOrigin(request,env);
  const form=await formOf(request);
  const cookie=readCookie(request,WITHDRAW_COOKIE);
  const value=withdrawalSchema.parse(cookie&&cookie.length<4096?await unseal(cookie,env.SESSION_SECRET):null);
  const keys=[...form.keys()];
  const confirmed=keys.length===3&&new Set(keys).size===3&&form.get('confirm')==='yes'&&value.exp>Date.now()
    &&value.device===form.get('device')&&value.csrf===form.get('csrf')&&value.actor===session.oid&&value.tenant===env.TENANT_ID;
  if(!confirmed||await store.ownedKey(value.device,env.TENANT_ID,session.oid)!==value.thumb)throw new Error('withdrawal-denied');
  await store.revokeDevice(value.device,env.TENANT_ID,session.oid,value.thumb);
  return page('Vínculo retirado','<p>Volte ao Coletor e clique em Concluir saída.</p>',200,{'Set-Cookie':clearCookie(WITHDRAW_COOKIE)});
}
/** Withdrawal only: no directory/refresh key is needed and no authority is issued. */
async function handleWithdrawalV1(request:Request,url:URL,env:RuntimeEnv,dependencies:CollectorRuntimeDependenciesV1):Promise<Response>{
  const withdrawal=await createCollectorWithdrawalStoreV1(env,dependencies);
  if(!withdrawal)return json({error:'Collector withdrawal unavailable'},503);
  try{
    if(url.pathname===prefixPath('device-status'))return await deviceStatus(request,env,withdrawal.store);
    let session:SessionV1;
    try{session=await requireAuth(request,env);}
    catch{return page('Entre para concluir a saída','<p>Entre no Ecossistema com a conta dona do vínculo e depois reabra esta página pelo Coletor.</p><a href="/auth/login">Entrar no Ecossistema</a>',401);}
    if(request.method==='GET')return await withdrawalPage(url,env,withdrawal.store,session);
    if(request.method!=='POST')return notAllowed();
    return await confirmWithdrawal(request,env,withdrawal.store,session);
  }catch{
    return json({error:'Collector withdrawal denied'},403);
  }finally{
    await withdrawal.close().catch(()=>undefined);
  }
}

async function oauthCallback(request:Request,url:URL,env:RuntimeEnv,runtime:CollectorRuntimeReadyV1):Promise<Response>{
  const cookie=readCookie(request,AUTH_COOKIE);
  const transaction=authSchema.parse(cookie && cookie.length<8192?await unseal(cookie,env.SESSION_SECRET):null);
  if(request.method!=='GET'||url.searchParams.has('error'))throw new Error('callback-denied');
  await completeCollectorOAuthV1({env,transaction,callbackState:url.searchParams.get('state')??'',code:url.searchParams.get('code')??'',cipher:runtime.cipher,dependencies:runtime.oauth});
  return page('Computador autorizado','<p>Volte ao Coletor e clique em <strong>Verificar acesso</strong>.</p><p>O programa não recebe sua senha ou tokens Microsoft. Você pode sair da conta pelo coletor.</p>',200,{'Set-Cookie':clearCookie(AUTH_COOKIE)});
}
async function connectPage(url:URL,env:RuntimeEnv,runtime:CollectorRuntimeReadyV1):Promise<Response>{
  const id=uuid.parse(url.searchParams.get('pairing')),view=await runtime.pairings.browserView(id);
  if(!view)return page('Autorização expirada','<p>Prepare o acesso novamente no Coletor.</p>',410);
  const csrf=random(),cookie=await seal({purpose:'collector-confirm',id,csrf,exp:Math.min(runtime.oauth.now()+600_000,new Date(view.expires_at as string|Date).getTime())},env.SESSION_SECRET);
  return page('Autorizar este computador',`<p>Digite o código mostrado no Coletor. Continue somente se você iniciou este pedido no seu computador.</p>
    <form method="post" action="/frequency-collector/connect"><input type="hidden" name="pairing" value="${id}"><input type="hidden" name="csrf" value="${csrf}">
    <label>Código mostrado no Coletor<input name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="off" required></label>
    <label><input type="checkbox" name="confirm" value="yes" required> Autorizo manter este computador vinculado ao coletor.</label>
    <p class="note">Sua conta deve ser ADMINISTRADOR. A permissão Microsoft é verificada a cada cinco minutos. A senha não é salva neste programa.</p>
    <button type="submit">Entrar e autorizar este computador</button></form><small>Chave pública do pedido: ${escaped(String(view.key_thumbprint))}</small>`,200,
    {'Set-Cookie':secureCookie(CONFIRM_COOKIE,cookie,{maxAge:600,sameSite:'Strict'})});
}
async function confirmConnect(request:Request,env:RuntimeEnv,runtime:CollectorRuntimeReadyV1):Promise<Response>{
  enforceWriteOrigin(request,env);
  const form=await formOf(request);
  const keys=[...form.keys()];
  if(keys.length!==4 || new Set(keys).size!==4 || form.get('confirm')!=='yes')throw new Error('confirmation-required');
  const cookie=readCookie(request,CONFIRM_COOKIE),confirmed=confirmSchema.parse(cookie && cookie.length<4096?await unseal(cookie,env.SESSION_SECRET):null);
  if(confirmed.exp<=runtime.oauth.now() || confirmed.id!==form.get('pairing') || confirmed.csrf!==form.get('csrf'))throw new Error('confirmation-denied');
  const view=await runtime.pairings.browserView(confirmed.id);
  if(view?.display_code===undefined || form.get('code')!==view.display_code)throw new Error('confirmation-denied');
  const base=await newAuthTransaction(runtime.oauth.now());
  const transaction:CollectorOAuthTransactionV1={state:'collector.'+base.state,nonce:base.nonce,verifier:base.verifier,
    exp:Math.min(base.exp,Math.floor(confirmed.exp/1000)),startedAt:runtime.oauth.now(),pairingId:confirmed.id};
  if(!await runtime.pairings.confirm(transaction))throw new Error('confirmation-denied');
  const headers=new Headers({Location:collectorAuthorizationUrlV1(env,{...base,...transaction})});
  headers.append('Set-Cookie',clearCookie(CONFIRM_COOKIE));
  headers.append('Set-Cookie',secureCookie(AUTH_COOKIE,await seal(transaction,env.SESSION_SECRET),{maxAge:600}));
  return new Response(null,{status:303,headers});
}
async function pairingRequest(request:Request,url:URL,env:RuntimeEnv,runtime:CollectorRuntimeReadyV1):Promise<Response>{
  if(request.method!=='POST')return notAllowed();
  if(foreignOrigin(request,env))return denied();
  const value=await readBoundedJson(request,2048);
  if(url.pathname==='/api/frequency-collector/pairings'){
    // Cloudflare supplies CF-Connecting-IP at the edge; avoid storing raw IP.
    // Do not trust forwarded client headers for authority: the independent
    // global database budget enforces a ceiling even if this one is spoofed.
    const edgeAddress=request.headers.get('CF-Connecting-IP')??'';
    const source=/^[0-9a-fA-F:.]{3,48}$/u.test(edgeAddress)?edgeAddress.toLowerCase():'unknown';
    const scope='client:'+await collectorOpaqueHashV1(env.SESSION_SECRET+'\\0'+source);
    // Malformed/unsigned requests must not consume the scarce school-wide
    // pairing quota. A self-signed valid key is still untrusted, hence DB caps.
    const proof=await verifyCollectorPairingV1(value,runtime.oauth.now());
    if(!await runtime.pairings.allowPairingRequest(scope))
      return new Response(JSON.stringify({error:'Pairing temporarily unavailable',code:'ACCESS_UNAVAILABLE'}),{
        status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Retry-After':'600'}});
    const pollToken=random();
    const digits=crypto.getRandomValues(new Uint32Array(1))[0]!;
    const displayCode=String(digits%1_000_000).padStart(6,'0');
    await runtime.pairings.create({id:proof.id,publicKey:proof.publicKey,pollHash:await collectorOpaqueHashV1(pollToken),displayCode,createdAt:runtime.oauth.now()});
    return json({contractVersion:1,id:proof.id,pollToken,displayCode,browserUrl:env.OFFICIAL_ORIGIN+'/frequency-collector/connect?pairing='+proof.id});
  }
  const poll=z.object({id:uuid,pollToken:secret}).strict().parse(value),hash=await collectorOpaqueHashV1(poll.pollToken);
  if(url.pathname==='/api/frequency-collector/pairings/poll'){
    const found=await runtime.pairings.poll(poll.id,hash);
    if(!found)return json({error:'Pairing unavailable'},403);
    return json({contractVersion:1,state:found.state,...(found.state==='completed'?{deviceId:found.device_id}:{})});
  }
  if(url.pathname==='/api/frequency-collector/pairings/cancel'){
    await runtime.pairings.cancel(poll.id,hash);
    return json({cancelled:true});
  }
  if(url.pathname==='/api/frequency-collector/pairings/claim'){
    if(!await runtime.pairings.claim(poll.id,hash))return json({error:'Pairing unavailable'},403);
    return json({claimed:true});
  }
  return json({error:'Not found'},404);
}
/** Every branch is awaited: the runtime's connection closes only after the response is complete. */
async function runtimeRoute(request:Request,url:URL,env:RuntimeEnv,runtime:CollectorRuntimeReadyV1,callback:boolean):Promise<Response>{
  if(callback)return await oauthCallback(request,url,env,runtime);
  if(url.pathname==='/frequency-collector/connect'){
    if(request.method==='GET')return await connectPage(url,env,runtime);
    if(request.method!=='POST')return notAllowed();
    return await confirmConnect(request,env,runtime);
  }
  if(url.pathname==='/api/frequency-collector/config')
    return request.method==='GET'?json({contractVersion:1,ready:true,serverTime:runtime.oauth.now()}):notAllowed();
  if(url.pathname==='/api/frequency-collector/frequency')return await handleCollectorFrequencyRequestV2(request,env,runtime.access);
  const access=await handleCollectorAccessRequestV1(request,runtime.access);
  if(access)return access;
  return await pairingRequest(request,url,env,runtime);
}

/** Pages-mounted orchestration. All credentials/SQL live on the server. */
export async function handleCollectorRequestV1(request:Request,env:RuntimeEnv,dependencies:CollectorRuntimeDependenciesV1={}):Promise<Response|null>{
  const url=new URL(request.url);
  const callback=url.pathname==='/auth/callback' && url.searchParams.get('state')?.startsWith('collector.')===true;
  const collectorPath=url.pathname.startsWith('/api/frequency-collector/') || url.pathname.startsWith('/frequency-collector/');
  if(!callback && !collectorPath)return null;
  if(url.origin!=='https://admin.escolaieda.com' || env.OFFICIAL_ORIGIN!==url.origin)return denied();
  if(url.pathname==='/frequency-collector/style.css')
    return request.method==='GET'?new Response(style,{headers:{'Content-Type':'text/css; charset=utf-8','Cache-Control':'no-store'}}):notAllowed();
  if(url.pathname==='/frequency-collector/revoke'||url.pathname===prefixPath('device-status'))
    return handleWithdrawalV1(request,url,env,dependencies);
  const runtime=await createCollectorRuntimeV1(env,dependencies);
  if(!runtime)return json({error:'Collector access unavailable',code:'ACCESS_NOT_CONFIGURED'},503);
  try{
    return await runtimeRoute(request,url,env,runtime,callback);
  }catch{
    if(callback)return page('Não foi possível autorizar','<p>Volte ao Coletor e prepare o acesso novamente. Nenhuma senha é solicitada no programa.</p>',403,{'Set-Cookie':clearCookie(AUTH_COOKIE)});
    return json({error:'Collector access denied',code:'ACCESS_REQUIRED'},403);
  }finally{
    await runtime.close().catch(()=>undefined);
  }
}
function prefixPath(suffix:string){return '/api/frequency-collector/'+suffix;}
