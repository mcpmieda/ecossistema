import { z } from 'zod';
import type { PortalCompositionEnvV1 } from './config-v1';
import { portalKeysV1 } from './config-v1';
import { portalDatabaseV1 } from './database-v1';
import { SessionServiceV1 } from '../auth/session-service-v1';
import { sessionCookieTokenV1 } from '../http/auth/handler-v1';
import { portalRequestOriginAllowedV1 } from '../runtime/http-v1';
import { checkPortalOperationV1, PortalRateLimitErrorV1 } from '../observability/operation-burst-v1';
import { portalFrequencySummaryV2, portalFrequencyYearV2 } from '../../attendance/service-v2';
import { schoolCalendarDaysV1, schoolDaysOfV1, schoolYearProgressOfV1 } from '../../../shared/student-portal-contracts/school-calendar-v1';
import { bellShiftOfLabelV1 } from '../../../shared/student-portal-contracts/school-bells-v1';
import { schoolBellsAndDaysOffV1 } from './schedule-v1';
const gridSchema=z.object({classes:z.array(z.object({label:z.string().min(1).max(300),observedAt:z.string(),
  lessons:z.array(z.object({weekday:z.number().int().min(1).max(5),slot:z.number().int().min(1).max(6),subject:z.string().min(1).max(120)}).strict()).max(30)}).strict()).max(8)}).strict();

const originsSchema=z.array(z.object({occurrence_id:z.uuid(),date:z.iso.date(),slot:z.number().int().min(1).max(6),shift:z.string().max(80),
  mark:z.enum(['X','J']).nullable(),conflict_id:z.uuid().nullable(),source_class_label:z.string().max(300),observed_at:z.string(),received_at:z.string(),mapping_valid:z.boolean()}).strict()).max(10_000);
// The whole school year in one read (attendance 0012): a student in two classes (regular and
// integral) or with two records has a few rows per school day.
const daysSchema=z.array(z.object({date:z.iso.date(),shift:z.string().max(80),slots_json:z.array(z.number().int().min(1).max(6)).max(6),complete:z.boolean()}).strict()).max(4000);
const readSchema=z.object({origins:originsSchema,days:daysSchema,today:z.iso.date(),lastReadAt:z.string().nullable(),now:z.string().optional()}).strict();
const HIDDEN=Symbol('frequency-hidden');
const response=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store, no-cache, private, must-revalidate','Pragma':'no-cache','Vary':'Cookie, Authorization'}});
export async function servePortalFrequencyV2(request:Request,env:PortalCompositionEnvV1):Promise<Response>{
  const fail=(state:string,status:number)=>response({contractVersion:2,state},status);
  if(!portalRequestOriginAllowedV1(request,env.PORTAL_ENVIRONMENT,env.PORTAL_ORIGIN))return fail('forbidden',403);
  if(request.method!=='GET')return fail('invalid-request',405);
  // One month (?month=2026-10), or the whole year so far in one answer (?year=2026, PR 1317: the
  // Portal reads it with the sign-in and changes months without asking again).
  const url=new URL(request.url),params=[...url.searchParams.keys()];
  const month=url.searchParams.get('month'),wholeYear=url.searchParams.get('year');
  const asMonth=params.length===1&&params[0]==='month'&&/^2026-(0[1-9]|1[0-2])$/u.test(month??'');
  const asYear=params.length===1&&params[0]==='year'&&wholeYear==='2026';
  if(!asMonth&&!asYear)return fail('invalid-request',400);
  if(env.PORTAL_SERVING_ENABLED!=='true')return fail('unavailable',503);
  const token=sessionCookieTokenV1(request);if(!token)return fail('unauthenticated',401);
  try{
    await checkPortalOperationV1(env.PORTAL_AUTH_GLOBAL,'session-entry','public');
    const keys=portalKeysV1(env);
    const summary=await portalDatabaseV1(env,'self',sql=>new SessionServiceV1(sql,keys.cryptoPort,undefined,true,
      accountId=>checkPortalOperationV1(env.PORTAL_SESSION_ACCOUNT,'session',accountId)).withAuthorized(token,async(context,tx,session)=>{
        // Política Frequência: off for this student's level hides the attendance data entirely.
        if(!context.policy.enforcedValue.showFrequency)return HIDDEN;
        // v4 (attendance 0012): the whole year's marks and lesson days in one read, with the school's
        // today and the class's last reading; the month and the year are worked out from it.
        const rows=await tx.unsafe('SELECT attendance.read_portal_frequency_v4($1::uuid,$2::uuid,$3::text,$4::text) AS frequency',[context.account.id,session.id,'2026-01','2026-12']);
        const raw=rows[0]?.frequency;if(raw===null||raw===undefined)return null;
        const read=readSchema.parse(typeof raw==='string'?JSON.parse(raw):raw);
        const clock=await tx.unsafe('SELECT clock_timestamp() < $1::timestamptz AS active',[session.expiresAt]);
        if(clock[0]?.active!==true)return null;
        // The school's calendar (ADM, student-portal 0029): only its school days count, and the
        // countdown runs to its last one. No calendar yet: the diary as it is, no countdown.
        const calendar=await tx.unsafe('SELECT days_json FROM student_portal.school_calendar_v1 WHERE academic_year=2026',[]);
        const calendarDays=calendar?.[0]?.days_json;
        const marked=calendarDays==null?null:schoolCalendarDaysV1.parse(typeof calendarDays==="string"?JSON.parse(calendarDays):calendarDays);
        const schoolDays=marked?new Set(schoolDaysOfV1(marked)):undefined;
        if(!asYear)return portalFrequencySummaryV2(read,month!,schoolDays);
        const schoolYear=marked?schoolYearProgressOfV1(marked,read.today):null;
        // The days without school with their description (Frequência calendar), each lesson's time
        // and, when the Horário is on for this student, the subject of each position of the week
        // (owner decision 23/10/2026: "Faltou na 3ª aula (08:50–09:45), MATEMATICA").
        const{bells,daysOff}=await schoolBellsAndDaysOffV1(tx);
        let grid:{shift:'matutino'|'vespertino';lessons:{weekday:number;slot:number;subject:string}[]}[]=[];
        if(context.policy.enforcedValue.showSchedule){
          const found=await tx.unsafe('SELECT attendance.read_portal_schedule_v1($1::uuid,$2::uuid) AS schedule',[context.account.id,session.id]);
          const rawGrid=found[0]?.schedule;
          if(rawGrid!=null)grid=gridSchema.parse(typeof rawGrid==='string'?JSON.parse(rawGrid):rawGrid).classes.flatMap(item=>{
            const shift=bellShiftOfLabelV1(item.label);return shift?[{shift,lessons:item.lessons}]:[];});
        }
        return {...portalFrequencyYearV2(read,schoolDays,schoolYear?.remaining??0),schoolYear,daysOff,bells,grid};
      }));
    if(summary===HIDDEN)return fail('forbidden',403);
    return summary===null?fail('unauthenticated',401):response(summary);
  }catch(error){return error instanceof PortalRateLimitErrorV1?fail('unavailable',429):fail('unavailable',503);}
}
