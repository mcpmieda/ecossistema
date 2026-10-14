import { z } from 'zod';
import { FREQUENCY_BODY_BYTES_V2, frequencyRequestV2 } from '../../shared/attendance-contracts/frequency-v2';
import type { RuntimeEnv } from '../env';
import { requireAuth, AuthenticationError } from '../auth/session';
import { requireRole, AuthorizationError } from '../auth/roles';
import { readBoundedJson, enforceWriteOrigin, HttpError } from '../http/security';
import { createFrequencyServiceV2, FrequencyErrorV2 } from '../attendance/service-v2';
import type { GradebookPostgresDatabaseV1 } from '../gradebook/persistence/postgres/postgres-database-v1';
import { withOfficialGradebookDatabaseV1 } from '../gradebook/persistence/postgres/official-gradebook-database-v1';
import { CollectorAccessErrorV1, type CollectorAccessServiceV1 } from './access-service-v1';

const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store, private','Pragma':'no-cache','Vary':'Cookie, Authorization'}});
const proofSchema=z.object({deviceId:z.uuid(),nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/u),signature:z.string().regex(/^[A-Za-z0-9_-]{86}$/u)}).strict();
const failed=(error:unknown):Response=>{
  if(error instanceof FrequencyErrorV2)return reply({contractVersion:2,state:error.code},error.status);
  if(error instanceof AuthenticationError)return reply({contractVersion:2,state:'not-authorized'},401);
  if(error instanceof AuthorizationError||error instanceof CollectorAccessErrorV1&&error.reason!=='unavailable')return reply({contractVersion:2,state:'not-authorized'},403);
  if(error instanceof z.ZodError||error instanceof HttpError)return reply({contractVersion:2,state:'invalid-request'},error instanceof HttpError?error.status:400);
  return reply({contractVersion:2,state:'unavailable'},503);
};
function database(env:RuntimeEnv):GradebookPostgresDatabaseV1 {
  const value=env.GRADEBOOK_DATABASE as GradebookPostgresDatabaseV1|undefined;
  if(!value?.transaction)throw new Error('frequency-database-unavailable');return value;
}

/** Payload-bound device proof is the only desktop authority. No browser cookie authorizes a device. */
export async function handleCollectorFrequencyRequestV2(request:Request,env:RuntimeEnv,access:Pick<CollectorAccessServiceV1,'authorizeFrequency'>):Promise<Response>{
  try{
    if(request.method!=='POST')return reply({contractVersion:2,state:'invalid-request'},405);
    if(new URL(request.url).origin!=='https://admin.escolaieda.com'||env.OFFICIAL_ORIGIN!=='https://admin.escolaieda.com'
      ||request.headers.has('Origin')&&request.headers.get('Origin')!==env.OFFICIAL_ORIGIN)return reply({contractVersion:2,state:'not-authorized'},403);
    const input=z.object({proof:proofSchema,payload:frequencyRequestV2}).strict().parse(await readBoundedJson(request,FREQUENCY_BODY_BYTES_V2));
    const actor=await access.authorizeFrequency(input.proof,input.payload);
    const result=await withOfficialGradebookDatabaseV1(env,async execution=>
      reply(await createFrequencyServiceV2(database(execution)).execute(input.payload,actor)));
    return result??reply({contractVersion:2,state:'unavailable'},503);
  }catch(error){return failed(error);}
}

/** Same service and rules; the site's verified ADMINISTRADOR session is independent of the device grant. */
export async function handleFrequencyAdminRequestV2(request:Request,env:RuntimeEnv):Promise<Response|null>{
  if(new URL(request.url).pathname!=='/api/gradebook/frequency/v2')return null;
  try{
    if(new URL(request.url).origin!==env.OFFICIAL_ORIGIN)return reply({contractVersion:2,state:'not-authorized'},403);
    if(request.method!=='POST')return reply({contractVersion:2,state:'invalid-request'},405);
    enforceWriteOrigin(request,env);
    const session=await requireAuth(request,env);requireRole(session.roles,'ADMINISTRADOR');
    const input=frequencyRequestV2.parse(await readBoundedJson(request,FREQUENCY_BODY_BYTES_V2));
    if(['lease','heartbeat','release','collect'].includes(input.operation))return reply({contractVersion:2,state:'not-authorized'},403);
    return await withOfficialGradebookDatabaseV1(env,async execution=>reply(await createFrequencyServiceV2(database(execution)).execute(input,
      {mode:'admin',actorId:session.oid,tenantId:env.TENANT_ID})))??reply({contractVersion:2,state:'unavailable'},503);
  }catch(error){return failed(error);}
}
