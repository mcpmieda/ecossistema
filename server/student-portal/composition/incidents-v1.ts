import { z } from 'zod';
import type { PortalCompositionEnvV1 } from './config-v1';
import { portalKeysV1 } from './config-v1';
import { portalDatabaseV1 } from './database-v1';
import { SessionServiceV1 } from '../auth/session-service-v1';
import { sessionCookieTokenV1 } from '../http/auth/handler-v1';
import { portalRequestOriginAllowedV1 } from '../runtime/http-v1';
import { checkPortalOperationV1, PortalRateLimitErrorV1 } from '../observability/operation-burst-v1';

// The student's own Smecel records and the family's "Estou ciente" (owner decisions 29/10/2026;
// attendance 0016). The whole description, as the Smecel has it; the session decides the student.
const incidentSchema=z.object({id:z.uuid(),kind:z.string().min(1).max(80),date:z.iso.date(),classLabel:z.string().min(1).max(300),
  leaveFrom:z.iso.date().nullable(),leaveTo:z.iso.date().nullable(),leaveDays:z.number().int().min(0).max(366).nullable(),
  description:z.string().min(1).max(8000),acknowledgedAt:z.string().nullable()}).strict();
const readSchema=z.object({incidents:z.array(incidentSchema).max(500)}).strict();
const ackSchema=z.discriminatedUnion('state',[z.object({state:z.literal('acknowledged'),acknowledgedAt:z.string()}).strict(),
  z.object({state:z.literal('changed')}).strict()]);
const bodySchema=z.object({id:z.uuid()}).strict();
const HIDDEN=Symbol('incidents-hidden');
const jsonOf=(raw:unknown)=>typeof raw==='string'?JSON.parse(raw):raw;
const instant=(value:string|null)=>value===null?null:new Date(value).toISOString();
const response=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store, no-cache, private, must-revalidate','Pragma':'no-cache','Vary':'Cookie, Authorization'}});
const fail=(state:string,status:number)=>response({contractVersion:1,state},status);

/** The request body: a small JSON object with the version confirmed, nothing else. */
async function acknowledgedIdOf(request:Request):Promise<string|null>{
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return null;
  const text=await request.text();
  if(text.length>256)return null;
  try{const parsed=bodySchema.safeParse(JSON.parse(text));return parsed.success?parsed.data.id:null;}catch{return null;}
}

export async function servePortalIncidentsV1(request:Request,env:PortalCompositionEnvV1):Promise<Response>{
  if(!portalRequestOriginAllowedV1(request,env.PORTAL_ENVIRONMENT,env.PORTAL_ORIGIN))return fail('forbidden',403);
  const acknowledging=new URL(request.url).pathname==='/api/student/incidents/acknowledge';
  if(request.method!==(acknowledging?'POST':'GET'))return fail('invalid-request',405);
  const version=acknowledging?await acknowledgedIdOf(request):null;
  if(acknowledging&&!version)return fail('invalid-request',400);
  if(env.PORTAL_SERVING_ENABLED!=='true')return fail('unavailable',503);
  const token=sessionCookieTokenV1(request);if(!token)return fail('unauthenticated',401);
  try{
    await checkPortalOperationV1(env.PORTAL_AUTH_GLOBAL,'session-entry','public');
    const keys=portalKeysV1(env);
    // A confirmation writes, so it runs in the account's locked transaction; the list is a snapshot.
    const result=await portalDatabaseV1(env,'self',sql=>new SessionServiceV1(sql,keys.cryptoPort,undefined,!acknowledging,
      accountId=>checkPortalOperationV1(env.PORTAL_SESSION_ACCOUNT,'session',accountId)).withAuthorized(token,async(context,tx,session)=>{
        // Política Ocorrências: off for this student's level hides the records entirely.
        if(!context.policy.enforcedValue.showIncidents)return HIDDEN;
        if(acknowledging){
          const rows=await tx.unsafe('SELECT attendance.acknowledge_portal_incident_v1($1::uuid,$2::uuid,$3::uuid) AS ack',[context.account.id,session.id,version]);
          const raw=rows[0]?.ack;if(raw===null||raw===undefined)return null;
          const ack=ackSchema.parse(jsonOf(raw));
          return ack.state==='changed'?ack:{state:'ready' as const,acknowledgedAt:instant(ack.acknowledgedAt)};
        }
        const rows=await tx.unsafe('SELECT attendance.read_portal_incidents_v1($1::uuid,$2::uuid) AS incidents',[context.account.id,session.id]);
        const raw=rows[0]?.incidents;if(raw===null||raw===undefined)return null;
        const read=readSchema.parse(jsonOf(raw));
        const clock=await tx.unsafe('SELECT clock_timestamp() < $1::timestamptz AS active',[session.expiresAt]);
        if(clock[0]?.active!==true)return null;
        return{state:'ready' as const,incidents:read.incidents.map(({leaveFrom,leaveTo,leaveDays,acknowledgedAt,...item})=>({...item,
          // Only a suspension has a leave; any part the Smecel left blank stays null.
          leave:leaveFrom===null&&leaveTo===null&&leaveDays===null?null:{from:leaveFrom,to:leaveTo,days:leaveDays},
          acknowledgedAt:instant(acknowledgedAt)}))};
      }));
    if(result===HIDDEN)return fail('forbidden',403);
    if(result===null)return fail('unauthenticated',401);
    // The school edited or removed it since the page was read: the Portal reads again.
    if(result.state==='changed')return fail('changed',409);
    return response({contractVersion:1,...result});
  }catch(error){return error instanceof PortalRateLimitErrorV1?fail('unavailable',429):fail('unavailable',503);}
}
