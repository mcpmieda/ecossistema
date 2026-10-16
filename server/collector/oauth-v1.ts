import { z } from 'zod';
import type { RuntimeEnv } from '../env';
import { authorizationUrl, type AuthTransaction, type IdClaims } from '../auth/oidc';
import { decodeJson } from '../auth/base64url';
import { CollectorRefreshCipherV1, type CollectorGrantBindingV1 } from './refresh-cipher-v1';
import { readCollectorOwnDirectoryV1, type CollectorDirectoryDependenciesV1, type CollectorDirectoryEvidenceV1 } from './directory-v1';

const scopes='openid profile email offline_access https://graph.microsoft.com/User.Read';
const tokenSchema=z.object({id_token:z.string().min(16).max(32_768),token_type:z.literal('Bearer'),
  refresh_token:z.string().min(16).max(16_384)});
const transactionSchema=z.object({state:z.string().regex(/^collector\.[A-Za-z0-9_-]{43}$/u),
  nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/u),verifier:z.string().regex(/^[A-Za-z0-9_-]{64}$/u),
  exp:z.number().int().positive(),startedAt:z.number().int().positive(),pairingId:z.string().uuid()}).strict();
export type CollectorOAuthTransactionV1=z.infer<typeof transactionSchema>;
export class CollectorOAuthErrorV1 extends Error { constructor(){super('collector-login-denied');} }

/** Only the collector-specific, explicitly confirmed transaction asks for
 * User.Read/offline_access. The application's existing authorization URL is
 * unchanged, and the already registered /auth/callback is reused. */
export function collectorAuthorizationUrlV1(env:RuntimeEnv,transaction:AuthTransaction & {challenge:string}):string {
  if(!/^collector\.[A-Za-z0-9_-]{43}$/u.test(transaction.state)) throw new CollectorOAuthErrorV1();
  const url=new URL(authorizationUrl(env,transaction));
  url.searchParams.set('scope',scopes);url.searchParams.set('max_age','0');
  return url.toString();
}

async function tokenBody(response:Response):Promise<unknown> {
  if(!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new CollectorOAuthErrorV1();
  const reader=response.body?.getReader();if(!reader) throw new CollectorOAuthErrorV1();
  let size=0;const chunks:Uint8Array[]=[];
  try {
    while(true){
      const item=await reader.read();
      if(item.done)break;
      size+=item.value.byteLength;
      if(size>64_000) throw new CollectorOAuthErrorV1();
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(()=>undefined);
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}

export type CollectorRegistrationV1=Readonly<{pairingId:string;binding:CollectorGrantBindingV1;
  encryptedRefresh:string;directory:CollectorDirectoryEvidenceV1}>;
export type CollectorOAuthDependenciesV1=CollectorDirectoryDependenciesV1 & {
  verifyIdToken:(token:string,env:RuntimeEnv,nonce:string)=>Promise<IdClaims>;
  /** Database must consume the confirmed transaction once, including expiry,
   * pairing/public-key binding, and return false on replay or cancellation. */
  consumeConfirmedTransaction:(transaction:CollectorOAuthTransactionV1)=>Promise<boolean>;
  /** Atomic insert of the grant/device for that same confirmed pairing only.
   * Must refuse expired/cancelled/already-completed pairing and never reset an
   * existing grant's original authentication time. No upsert of old grants. */
  registerConfirmedPairing:(registration:CollectorRegistrationV1)=>Promise<boolean>;
};

/** Server-private callback broker; its only public result is completion.
 * Missing storage, key or actual own-user evidence keeps the flow unavailable.
 * The HTTP cookie/state/pairing adapter still has to call this after explicit
 * browser confirmation; it is not installed by merely adding this module. */
export async function completeCollectorOAuthV1(input:{env:RuntimeEnv;transaction:CollectorOAuthTransactionV1;
  callbackState:string;code:string;cipher:CollectorRefreshCipherV1;dependencies:CollectorOAuthDependenciesV1}):Promise<{completed:true}> {
  try {
    const {env,dependencies}=input,transaction=transactionSchema.parse(input.transaction),now=dependencies.now();
    if(env.OFFICIAL_ORIGIN!=='https://admin.escolaieda.com' || input.callbackState!==transaction.state
      || transaction.exp*1000<=now || transaction.startedAt>now || now-transaction.startedAt>600_000
      || !input.code || input.code.length>8192) throw new CollectorOAuthErrorV1();
    if(!await dependencies.consumeConfirmedTransaction(transaction)) throw new CollectorOAuthErrorV1();
    const response=await dependencies.fetch(`https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`,{
      method:'POST',redirect:'manual',signal:AbortSignal.timeout(15_000),headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({client_id:env.WEB_CLIENT_ID,grant_type:'authorization_code',code:input.code,
        code_verifier:transaction.verifier,redirect_uri:env.OFFICIAL_ORIGIN+'/auth/callback',scope:scopes,
        client_assertion_type:'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',client_assertion:await dependencies.clientAssertion()})});
    if(!response.ok) throw new CollectorOAuthErrorV1();
    const tokens=tokenSchema.parse(await tokenBody(response));
    const claims=await dependencies.verifyIdToken(tokens.id_token,env,transaction.nonce);
    if(claims.tid!==env.TENANT_ID || claims.aud!==env.WEB_CLIENT_ID || claims.nonce!==transaction.nonce)
      throw new CollectorOAuthErrorV1();
    // Decode only after signature/authority/nonce validation. max_age requires
    // auth_time; absent/stale values cannot be replaced with callback clock time.
    const payload=z.object({auth_time:z.number().int().positive()}).parse(decodeJson(tokens.id_token.split('.')[1]!));
    const authenticatedAt=payload.auth_time*1000;
    if(authenticatedAt>now || authenticatedAt<transaction.startedAt-1000 || now-authenticatedAt>600_000)
      throw new CollectorOAuthErrorV1();
    const binding:CollectorGrantBindingV1={tenantId:claims.tid,actorId:claims.oid,clientId:env.WEB_CLIENT_ID,
      grantId:crypto.randomUUID(),generation:1,version:0,originAuthenticatedAt:authenticatedAt};
    // Reacquire only User.Read, prove enabled own account, original-origin marker
    // and fixed ADMIN group; do not use the code response's access token.
    const result=await readCollectorOwnDirectoryV1({binding,expectedTenantId:env.TENANT_ID,expectedClientId:env.WEB_CLIENT_ID,
      adminGroupId:env.GROUP_ADMIN_ID,refreshToken:tokens.refresh_token,dependencies});
    const encryptedRefresh=await input.cipher.encrypt(result.nextRefreshToken,binding);
    if(!await dependencies.registerConfirmedPairing({pairingId:transaction.pairingId,binding,encryptedRefresh,directory:result.evidence}))
      throw new CollectorOAuthErrorV1();
    return {completed:true};
  } catch {throw new CollectorOAuthErrorV1();}
}
