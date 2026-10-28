import { z } from 'zod';
import type { PortalCompositionEnvV1 } from './config-v1';
import { portalKeysV1 } from './config-v1';
import { portalDatabaseV1 } from './database-v1';
import { SessionServiceV1 } from '../auth/session-service-v1';
import { sessionCookieTokenV1 } from '../http/auth/handler-v1';
import { portalRequestOriginAllowedV1 } from '../runtime/http-v1';
import { checkPortalOperationV1, PortalRateLimitErrorV1 } from '../observability/operation-burst-v1';
import { bellShiftOfLabelV1, bellsValidFromV1, schoolBellsDaysV1 } from '../../../shared/student-portal-contracts/school-bells-v1';
import { schoolCalendarDaysV1, schoolDaysOffOfV1, schoolYearSpanOfV1 } from '../../../shared/student-portal-contracts/school-calendar-v1';
import type { StudentPortalPostgresQueryV1 } from '../persistence/postgres-persistence-v1';

// The weekly grid of the student's own class(es) (owner decision 22/10/2026; attendance 0011).
// The subject exactly as the Smecel names it; no teacher; a free position is absent.
const lessonSchema=z.object({weekday:z.number().int().min(1).max(5),slot:z.number().int().min(1).max(6),subject:z.string().min(1).max(120)}).strict();
const readSchema=z.object({classes:z.array(z.object({label:z.string().min(1).max(300),observedAt:z.string(),lessons:z.array(lessonSchema).max(30)}).strict()).max(8)}).strict();
const HIDDEN=Symbol('schedule-hidden');
const jsonOf=(raw:unknown)=>typeof raw==='string'?JSON.parse(raw):raw;
/**
 * What the school marked in the ADM (student-portal 0029 and 0030), for the Horário and the
 * Frequência: the time of each lesson by shift and weekday and from when those times hold, the days
 * without school with their description, and the school year's first and last school day (owner
 * requests 27/10/2026: the Horário ends the year at the calendar's last lesson; nothing fixed in the
 * code). Nothing marked yet: null, an empty list and null (the Portal shows the grid without times
 * and without an end of the year).
 */
export async function schoolBellsAndCalendarV1(tx:StudentPortalPostgresQueryV1){
  // Saved by the system (student-portal 0030/0031, the official sheets) or by a person in the ADM.
  const bells=await tx.unsafe(`SELECT bells_json,updated_by='00000000-0000-4000-8000-000000000000' AS by_system,(updated_at AT TIME ZONE 'America/Bahia')::date::text AS saved_on FROM student_portal.school_bells_v1 WHERE academic_year=2026`,[]);
  const calendar=await tx.unsafe('SELECT days_json FROM student_portal.school_calendar_v1 WHERE academic_year=2026',[]);
  const bellsRow=bells?.[0],rawBells=bellsRow?.bells_json,rawDays=calendar?.[0]?.days_json;
  const days=rawDays==null?null:schoolCalendarDaysV1.parse(jsonOf(rawDays));
  return{
    bells:rawBells==null?null:schoolBellsDaysV1.parse(jsonOf(rawBells)),
    bellsValidFrom:rawBells==null?null:bellsValidFromV1(bellsRow!.by_system===true,String(bellsRow!.saved_on)),
    daysOff:days?schoolDaysOffOfV1(days):[],
    schoolYear:days?schoolYearSpanOfV1(days):null,
  };
}
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
        const value=readSchema.parse(jsonOf(raw));
        // The school's today and the database's clock (owner decision 23/10/2026: the lesson going
        // on now and its countdown run on the server's time, never on a phone with a wrong clock).
        const clock=await tx.unsafe(`SELECT clock_timestamp() < $1::timestamptz AS active,(clock_timestamp() AT TIME ZONE 'America/Bahia')::date::text AS today,clock_timestamp() AS now`,[session.expiresAt]);
        if(clock[0]?.active!==true)return null;
        const{bells,daysOff,schoolYear}=await schoolBellsAndCalendarV1(tx);
        return{
          // Each class with its shift's bells (the shift named in its label), or null.
          classes:value.classes.map(item=>{const shift=bellShiftOfLabelV1(item.label);return{...item,bells:shift&&bells?bells[shift]:null};}),
          today:String(clock[0]!.today),
          now:new Date(clock[0]!.now as string|Date).toISOString(),
          daysOff,
          schoolYear,
        };
      }));
    if(read===HIDDEN)return fail('forbidden',403);
    return read===null?fail('unauthenticated',401):response({contractVersion:1,state:'ready',...read});
  }catch(error){return error instanceof PortalRateLimitErrorV1?fail('unavailable',429):fail('unavailable',503);}
}
