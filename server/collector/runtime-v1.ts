import {z} from 'zod';
import type {RuntimeEnv} from '../env';
import {decodeBase64Url} from '../auth/base64url';
import {createClientAssertion} from '../auth/client-assertion';
import {webCredentials} from '../auth/technical-identity';
import {verifyIdToken} from '../auth/oidc';
import {CollectorRefreshCipherV1} from './refresh-cipher-v1';
import {CollectorAuthorizationStoreV1,type CollectorSqlV1} from './authorization-store-v1';
import {CollectorPairingStoreV1} from './pairing-store-v1';
import {CollectorAccessServiceV1} from './access-service-v1';
import type {CollectorOAuthDependenciesV1} from './oauth-v1';

export type CollectorDatabaseV1=CollectorSqlV1 & {close:()=>Promise<void>};
export type CollectorRuntimeV1={access:CollectorAccessServiceV1;pairings:CollectorPairingStoreV1;
  cipher:CollectorRefreshCipherV1;oauth:CollectorOAuthDependenciesV1;close:()=>Promise<void>};
export type CollectorRuntimeDependenciesV1={database?:(connectionString:string)=>Promise<CollectorDatabaseV1>;
  fetch?:typeof fetch;now?:()=>number;assertion?:()=>Promise<string>;verify?:typeof verifyIdToken};
async function database(connectionString:string):Promise<CollectorDatabaseV1>{
  const {default:postgres}=await import('postgres');
  const sql=postgres(connectionString,{max:1,fetch_types:false,prepare:true,connect_timeout:8,idle_timeout:2,max_lifetime:30,
    connection:{application_name:'ecossistema-collector',statement_timeout:10_000,lock_timeout:3000,idle_in_transaction_session_timeout:10_000}});
  return {query:async<T extends Record<string,unknown>>(text:string,parameters:unknown[])=>
    Array.from(await sql.unsafe(text,parameters as never[])) as T[],close:async()=>{await sql.end({timeout:3});}};
}

/** Names only the failed setup step, never a value, so ACCESS_NOT_CONFIGURED is traceable. */
function unavailable(stage:string):void {
  console.error(JSON.stringify({message:'collector_runtime_unavailable',stage}));
}

export async function createCollectorWithdrawalStoreV1(env:RuntimeEnv,dependencies:CollectorRuntimeDependenciesV1={}){
  let db:CollectorDatabaseV1|undefined;
  try{
    if(env.OFFICIAL_ORIGIN!=='https://admin.escolaieda.com')return null;
    const connection=z.object({connectionString:z.string().min(1)}).parse(env.COLLECTOR_DB);
    db=await (dependencies.database??database)(connection.connectionString);
    return {store:new CollectorAuthorizationStoreV1(db),close:()=>db!.close()};
  }catch{
    unavailable('withdrawal-storage');
    if(db)await db.close().catch(()=>undefined);
    return null;
  }
}
/** Dedicated optional binding/key. No fallback to PROD_DB, SESSION_SECRET,
 * Graph app permissions, browser access tokens or broad delegated scopes. */
export async function createCollectorRuntimeV1(env:RuntimeEnv,dependencies:CollectorRuntimeDependenciesV1={}):Promise<CollectorRuntimeV1|null>{
  if(env.COLLECTOR_ENABLED!=='true' || env.OFFICIAL_ORIGIN!=='https://admin.escolaieda.com')return null;
  let db:CollectorDatabaseV1|undefined;
  let stage='database-binding';
  try{
    const connection=z.object({connectionString:z.string().min(1)}).parse(env.COLLECTOR_DB);
    stage='refresh-key';
    const encoded=z.string().regex(/^[A-Za-z0-9_-]{43}$/u).parse(env.COLLECTOR_REFRESH_KEY);
    if(encoded===env.SESSION_SECRET)throw new Error('dedicated-key-required');
    const key=decodeBase64Url(encoded);
    if(key.byteLength!==32)throw new Error('dedicated-key-required');
    stage='web-credential';
    const credential=dependencies.assertion?null:webCredentials(env)[0]!;
    stage='database-connection';
    db=await (dependencies.database??database)(connection.connectionString);
    stage='database-privileges';
    const ready=await db.query<{ready:boolean}>(`SELECT count(*)=4 AND bool_and(has_schema_privilege(current_user,n.oid,'USAGE')
      AND has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT')
      AND has_table_privilege(current_user,c.oid,'UPDATE')) AS ready FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='collector_auth' AND c.relkind='r' AND c.relname IN ('pairings','challenges','devices','oauth_grants')`,[]);
    if(ready[0]?.ready!==true)throw new Error('storage-unavailable');
    stage='pairing-cleanup';
    const pairings=new CollectorPairingStoreV1(db),cipher=await CollectorRefreshCipherV1.fromDedicatedKey(key);
    await pairings.retireExpiredUnclaimed();
    await pairings.purgeFinished();
    // Workerd requires its global receiver when native fetch is stored on a
    // dependency object; calling that unbound method throws Illegal invocation.
    const directory={fetch:dependencies.fetch??globalThis.fetch.bind(globalThis),now:dependencies.now??Date.now,clientAssertion:dependencies.assertion??(()=>createClientAssertion({
      clientId:env.WEB_CLIENT_ID,tenantId:env.TENANT_ID,privateKeyPkcs8:credential!.privateKeyPkcs8,certificateThumbprint:credential!.certificateThumbprint}))};
    const access=new CollectorAccessServiceV1(new CollectorAuthorizationStoreV1(db),cipher,
      {tenantId:env.TENANT_ID,clientId:env.WEB_CLIENT_ID,adminGroupId:env.GROUP_ADMIN_ID},directory);
    return {access,pairings,cipher,oauth:{...directory,verifyIdToken:dependencies.verify??verifyIdToken,
      consumeConfirmedTransaction:t=>pairings.consumeConfirmedTransaction(t),registerConfirmedPairing:r=>pairings.registerConfirmedPairing(r)},
      close:()=>db!.close()};
  }catch{
    unavailable(stage);
    if(db)await db.close().catch(()=>undefined);
    return null;
  }
}
