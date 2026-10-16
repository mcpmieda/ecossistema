import { z } from 'zod';
import type { PortalCompositionEnvV1 } from './config-v1';
import { portalKeysV1 } from './config-v1';
import { portalDatabaseV1 } from './database-v1';
import { SessionServiceV1 } from '../auth/session-service-v1';
import { sessionCookieTokenV1 } from '../http/auth/handler-v1';
import { portalRequestOriginAllowedV1 } from '../runtime/http-v1';
import { checkPortalOperationV1, PortalRateLimitErrorV1 } from '../observability/operation-burst-v1';
import { summarizeFrequencyPublicOriginsV2 } from '../../attendance/service-v2';

const originsSchema=z.array(z.object({occurrence_id:z.uuid(),date:z.iso.date(),slot:z.number().int().min(1).max(6),shift:z.string().max(80),
  mark:z.enum(['X','J']).nullable(),conflict_id:z.uuid().nullable(),source_class_label:z.string().max(300),observed_at:z.string(),received_at:z.string(),mapping_valid:z.boolean()}).strict()).max(10_000);
const response=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store, no-cache, private, must-revalidate','Pragma':'no-cache','Vary':'Cookie, Authorization'}});
export async function servePortalFrequencyV2(request:Request,env:PortalCompositionEnvV1):Promise<Response>{
  const fail=(state:string,status:number)=>response({contractVersion:2,state},status);
  if(!portalRequestOriginAllowedV1(request,env.PORTAL_ENVIRONMENT,env.PORTAL_ORIGIN))return fail('forbidden',403);
  if(request.method!=='GET')return fail('invalid-request',405);
  const url=new URL(request.url),month=url.searchParams.get('month');
  if(url.searchParams.getAll('month').length!==1||[...url.searchParams.keys()].some(k=>k!=='month')||!/^2026-(0[1-9]|1[0-2])$/u.test(month??''))return fail('invalid-request',400);
  if(env.PORTAL_SERVING_ENABLED!=='true')return fail('unavailable',503);
  const token=sessionCookieTokenV1(request);if(!token)return fail('unauthenticated',401);
  try{
    await checkPortalOperationV1(env.PORTAL_AUTH_GLOBAL,'session-entry','public');
    const keys=portalKeysV1(env);
    const summary=await portalDatabaseV1(env,'self',sql=>new SessionServiceV1(sql,keys.cryptoPort,undefined,true,
      accountId=>checkPortalOperationV1(env.PORTAL_SESSION_ACCOUNT,'session',accountId)).withAuthorized(token,async(context,tx,session)=>{
        const rows=await tx.unsafe('SELECT attendance.read_portal_origins_v2($1::uuid,$2::uuid,$3::text) AS origins',[context.account.id,session.id,month!]);
        const raw=rows[0]?.origins;if(raw===null||raw===undefined)return null;
        const origins=originsSchema.parse(typeof raw==='string'?JSON.parse(raw):raw);
        const clock=await tx.unsafe('SELECT clock_timestamp() < $1::timestamptz AS active',[session.expiresAt]);
        if(clock[0]?.active!==true)return null;
        return summarizeFrequencyPublicOriginsV2(origins,month!);
      }));
    return summary===null?fail('unauthenticated',401):response(summary);
  }catch(error){return error instanceof PortalRateLimitErrorV1?fail('unavailable',429):fail('unavailable',503);}
}
