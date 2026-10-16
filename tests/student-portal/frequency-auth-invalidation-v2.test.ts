import {describe,it,expect,vi} from 'vitest';
import {createStudentSessionV1} from '../../src/features/student-portal/auth/student-session-v1';
import type {PortalSelfClientV1} from '../../src/features/student-portal/shared/self-client-v1';
import type {SelfResponseV1} from '../../shared/student-portal-contracts/self-v1';
import type {PortalLoadStateV1} from '../../src/features/student-portal/shared/latest-request-v1';

describe('student-wide invalidation on frequency 401',()=>{
  it('discards previous profile, blocks late refresh and allows reauthentication',async()=>{
    let reads=0;
    const client={
      session:vi.fn(async()=>({expiresAt:new Date(Date.now()+120_000).toISOString()})),
      me:vi.fn(async()=>{reads++;return {profile:{accountId:'00000000-0000-4000-8000-000000000001'}} as SelfResponseV1;}),
      logout:vi.fn(async()=>undefined)
    } as unknown as PortalSelfClientV1;
    const seen:PortalLoadStateV1<SelfResponseV1>[]=[];
    const session=createStudentSessionV1(client,state=>seen.push(state),()=>{});
    try{
      await session.refresh();
      expect(seen.at(-1)?.state).toBe('ready');
      session.invalidateAuthorization();
      expect(seen.at(-1)).toMatchObject({state:'error',error:{state:'unauthenticated'}});
      await session.refresh();
      expect(reads).toBe(1);
      await session.authenticated();
      expect(reads).toBe(2);
      expect(seen.at(-1)?.state).toBe('ready');
    }finally{session.dispose();}
  });
});
