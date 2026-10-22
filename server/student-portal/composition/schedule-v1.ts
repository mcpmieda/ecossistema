import { z } from 'zod';
import type { PortalCompositionEnvV1 } from './config-v1';
import { portalKeysV1 } from './config-v1';
import { portalDatabaseV1 } from './database-v1';
import { SessionServiceV1 } from '../auth/session-service-v1';
import { sessionCookieTokenV1 } from '../http/auth/handler-v1';
import { portalRequestOriginAllowedV1 } from '../runtime/http-v1';
import { checkPortalOperationV1, PortalRateLimitErrorV1 } from '../observability/operation-burst-v1';

// The weekly grid of the student's own class(es) (owner decision 22/10/2026; attendance 0011).
// The subject exactly as the Smecel names it; no teacher; a free position is absent.
const lessonSchema=z.object({weekday:z.number().int().min(1).max(5),slot:z.number().int().min(1).max(6),subject:z.string().min(1).max(120)}).strict();
const readSchema=z.object({classes:z.array(z.object({label:z.string().min(1).max(300),observedAt:z.string(),lessons:z.array(lessonSchema).max(30)}).strict()).max(8)}).strict();
const HIDDEN=Symbol('schedule-hidden');
const response=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store, no-cache, private, must-revalidate','Pragma':'no-cache','Vary':'Cookie, Authorization'}});
export async function servePortalScheduleV1(request:Request,env:PortalCompositionEnvV1):Promise<Response>{
  const fail=(state:string,status:number)=>response({contractVersion:1,state},status);
  if(!portalRequestOriginAllowedV1(request,env.PORTAL_ENVIRONMENT,env.PORTAL_ORIGIN))return fail('forbidden',403);
  if(request.method!=='GET')return fail('invalid-request',405);
  if([...new URL(request.url).searchParams.keys()].length)return fail('invalid-request',400);
  if(env.PORTAL_SERVING_ENABLED!=='true')return fail('unavailable',503);
  const token=sessionCookieTokenV1(request);if(!token)return fail('unauthenticated',401);
  try{
    await checkPortalOperationV1(env.PORTAL_AUTH_GLOBAL,'session-entry','public');
    const keys=portalKeysV1(env);
    const read=await portalDatabaseV1(env,'self',sql=>new SessionServiceV1(sql,keys.cryptoPort,undefined,true,
      accountId=>checkPortalOperationV1(env.PORTAL_SESSION_ACCOUNT,'session',accountId)).withAuthorized(token,async(context,tx,session)=>{
        // Política Horário: off for this student's level hides the grid entirely.
        if(!context.policy.enforcedValue.showSchedule)return HIDDEN;
        const rows=await tx.unsafe('SELECT attendance.read_portal_schedule_v1($1::uuid,$2::uuid) AS schedule',[context.account.id,session.id]);
        const raw=rows[0]?.schedule;if(raw===null||raw===undefined)return null;
        const value=readSchema.parse(typeof raw==='string'?JSON.parse(raw):raw);
        const clock=await tx.unsafe('SELECT clock_timestamp() < $1::timestamptz AS active',[session.expiresAt]);
        if(clock[0]?.active!==true)return null;
        return value;
      }));
    if(read===HIDDEN)return fail('forbidden',403);
    return read===null?fail('unauthenticated',401):response({contractVersion:1,state:'ready',...read});
  }catch(error){return error instanceof PortalRateLimitErrorV1?fail('unavailable',429):fail('unavailable',503);}
}
